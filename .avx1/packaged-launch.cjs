const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses')
const { FuseState } = require('@electron/fuses/dist/constants')

function assertProductionFuses(fuses) {
  for (const key of ['EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']) {
    assert.equal(fuses[FuseV1Options[key]], FuseState.DISABLE, key)
  }
  for (const key of ['EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar']) {
    assert.equal(fuses[FuseV1Options[key]], FuseState.ENABLE, key)
  }
}

function debuggerEndpoint(text) {
  return text.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/)?.[1]
}

async function smokeHardened(executable, profile, chromium, expectedVersion) {
  assertProductionFuses(await getCurrentFuseWire(executable))
  fs.mkdirSync(profile, { recursive: true })
  const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`], { env, windowsHide: true })
  let browser
  let output = ''
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Packaged Chromium endpoint timed out')), 60000)
      const fail = error => { clearTimeout(timer); reject(error) }
      child.once('error', fail)
      child.once('exit', code => fail(Error(`Packaged app exited before CDP: ${code}`)))
      child.stderr.on('data', data => {
        output = (output + data.toString()).slice(-65536)
        const endpoint = debuggerEndpoint(output)
        if (endpoint) { clearTimeout(timer); resolve(endpoint) }
      })
    })
    browser = await chromium.connectOverCDP(endpoint)
    const context = browser.contexts()[0]
    let page
    const deadline = Date.now() + 60000
    while (!page && Date.now() < deadline) {
      page = context.pages().find(item => /\/index\.html(?:[?#]|$)/.test(item.url()))
      if (!page) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(page, 'Packaged main renderer is missing')
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.getByText('Новое подключение', { exact: true }).or(page.getByRole('button', { name: 'Начать', exact: true })).first().waitFor({ state: 'visible', timeout: 60000 })
    assert.equal(await page.locator('html').getAttribute('lang'), 'ru-RU')
    assert.equal(await page.evaluate(() => window.electronAPI.getVersion()), expectedVersion)
    await verifyConnectedUI(page)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: path.join(profile, 'russian-onboarding.png') })
    console.log('UNMODIFIED_HARDENED_NSIS_APP_RENDERED')
  } catch (error) {
    fs.writeFileSync(path.join(profile, 'launch-failure.txt'), output)
    throw error
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (child.exitCode === null && child.signalCode === null) {
      // Only this isolated test process; never an installed app or service.
      child.kill()
      await new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        child.once('exit', resolve)
      })
    }
  }
}

async function verifyConnectedUI(page) {
  const key = 'synthetic-terminal-regression'
  const server = require('node:http').createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(request.headers.authorization === `Bearer ${key}` ? 200 : 401,
        { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok' }))
    } else {
      response.setHeader('Content-Type', 'text/html')
      response.end('<!doctype html><title>Connection fixture</title><body>OWUI_CONNECTION_READY</body>')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const label = `OWUI connection regression ${server.address().port}`
  try {
    await page.evaluate(async ({ url, label }) => {
      await window.electronAPI.addConnection({ id: label, name: label, type: 'remote', url })
    }, { url, label })
    const connection = page.getByRole('button', { name: label, exact: true })
    if (!await connection.isVisible()) await page.getByRole('button', { name: 'Показать подключения', exact: true }).click()
    await connection.click()
    await page.waitForFunction(async url => {
      const view = [...document.querySelectorAll('webview')].find(item => item.getAttribute('src') === url)
      if (!view) return false
      try { return (await view.executeJavaScript('document.body.textContent')).includes('OWUI_CONNECTION_READY') }
      catch { return false }
    }, url, { timeout: 30000 })
    await page.getByRole('button', { name: 'Обновить', exact: true }).click({ trial: true, timeout: 15000 })
    console.log('PACKAGED_CONNECTION_WEBVIEW_AND_REFRESH_VERIFIED')
    // Reproduce a startup failure, then reconnect through the real dock control.
    await page.evaluate(async port => {
      const config = await window.electronAPI.getConfig()
      await window.electronAPI.setConfig({ localServer: { ...config.localServer, managedBackend: true },
        openTerminal: { enabled: true, port, apiKey: '' } })
      await window.electronAPI.startOpenTerminal()
    }, server.address().port)
    await page.evaluate(async key => {
      const config = await window.electronAPI.getConfig()
      await window.electronAPI.setConfig({ openTerminal: { ...config.openTerminal, apiKey: key } })
    }, key)
    await page.getByRole('button', { name: 'Запустить Open Terminal', exact: true }).click()
    await page.waitForFunction(async () => {
      const info = await window.electronAPI.getOpenTerminalInfo()
      return info.status === 'started' && info.external === true && info.pid === null
    }, null, { timeout: 15000 })
    console.log('PACKAGED_TERMINAL_RECONNECT_EXTERNAL_OWNER_VERIFIED')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

module.exports = { assertProductionFuses, debuggerEndpoint, smokeHardened, verifyConnectedUI }

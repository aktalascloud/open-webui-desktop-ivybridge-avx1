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

module.exports = { assertProductionFuses, debuggerEndpoint, smokeHardened }

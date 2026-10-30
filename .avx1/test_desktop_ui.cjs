const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { _electron } = require(process.env.TEST_PLAYWRIGHT)
;(async () => {
  const executablePath = process.argv[2]
  const profile = process.argv[3]
  fs.mkdirSync(profile, { recursive: true })
  const app = await _electron.launch({ executablePath, args: ['--no-sandbox', '--disable-gpu'], env: { ...process.env, APPDATA: profile, LOCALAPPDATA: profile }, timeout: 60000 })
  let guestServer
  try {
    await app.firstWindow()
    let page = app.windows()[0]
    for (const candidate of app.windows()) {
      if (await (await app.browserWindow(candidate)).evaluate(window => window.isVisible())) { page = candidate; break }
    }
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.getByText('Новое подключение', { exact: true }).or(page.getByRole('button', { name: 'Начать', exact: true })).first().waitFor({ state: 'visible', timeout: 60000 })
      assert.equal(await page.locator('html').getAttribute('lang'), 'ru-RU')
    } catch (error) {
      await page.screenshot({ path: path.join(profile, 'russian-failure.png') })
      const state = await Promise.all(app.windows().map(async item => ({ url: item.url(), body: await item.locator('body').innerText().catch(() => '') })))
      fs.writeFileSync(path.join(profile, 'renderer-state.json'), JSON.stringify(state, null, 2))
      console.error('CI-only window state:', JSON.stringify(state))
      throw error
    }
    await page.screenshot({ path: path.join(profile, 'russian-onboarding.png') })
    assert.deepEqual(errors, [])
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), process.env.EXPECTED_DESKTOP_VERSION)
    guestServer = require('node:http').createServer((_request, response) => response.end('<!doctype html><title>Untrusted fixture</title>'))
    await new Promise(resolve => guestServer.listen(0, '127.0.0.1', resolve))
    const guestId = await page.evaluate(async port => {
      const guest = document.createElement('webview')
      guest.id = 'security-guest-fixture'
      guest.setAttribute('nodeintegration', '')
      guest.setAttribute('preload', 'file:///untrusted/preload/content-preload.js')
      guest.setAttribute('src', `http://127.0.0.1:${port}/`)
      guest.style.cssText = 'width:100px;height:100px'
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Guest fixture did not load')), 15000)
        guest.addEventListener('dom-ready', () => { clearTimeout(timer); resolve(guest.getWebContentsId()) }, { once: true })
        document.body.appendChild(guest)
      })
    }, guestServer.address().port)
    const preferences = await app.evaluate(({ webContents }, id) => {
      const value = webContents.fromId(id).getLastWebPreferences()
      return { node: value.nodeIntegration, sandbox: value.sandbox, isolated: value.contextIsolation, preload: value.preload }
    }, guestId)
    assert.equal(preferences.node, false)
    assert.equal(preferences.sandbox, true)
    assert.equal(preferences.isolated, true)
    assert.ok(!String(preferences.preload ?? '').includes('untrusted'))
    const guestSurface = await page.evaluate(async () => {
      const guest = document.getElementById('security-guest-fixture')
      return await guest.executeJavaScript('({relay:typeof window.electronAPI?.send,node:typeof require,keys:Object.keys(window.electronAPI ?? {}).sort()})')
    })
    assert.equal(guestSurface.relay, 'function')
    assert.equal(guestSurface.node, 'undefined')
    assert.deepEqual(guestSurface.keys, ['load','onEvent','send'])
    await page.evaluate(() => document.getElementById('security-guest-fixture').remove())
    console.log('PACKAGED_GUEST_TRUST_BOUNDARY_VERIFIED')
    console.log('NSIS_RUSSIAN_ONBOARDING_RENDERED_NO_PAGE_ERRORS')
  } finally { await app.close(); if (guestServer) await new Promise(resolve => guestServer.close(resolve)) }
})().catch(error => { console.error(error); process.exitCode = 1 })

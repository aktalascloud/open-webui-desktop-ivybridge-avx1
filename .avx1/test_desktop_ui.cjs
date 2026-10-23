const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { _electron } = require(process.env.TEST_PLAYWRIGHT)
;(async () => {
  const executablePath = process.argv[2]
  const profile = process.argv[3]
  fs.mkdirSync(profile, { recursive: true })
  const app = await _electron.launch({ executablePath, args: ['--no-sandbox', '--disable-gpu'], env: { ...process.env, APPDATA: profile, LOCALAPPDATA: profile }, timeout: 60000 })
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
    console.log('NSIS_RUSSIAN_ONBOARDING_RENDERED_NO_PAGE_ERRORS')
  } finally { await app.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })

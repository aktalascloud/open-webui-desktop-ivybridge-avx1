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
    const page = await app.firstWindow()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.getByText('Новое подключение', { exact: true }).waitFor({ state: 'visible', timeout: 60000 })
    await page.screenshot({ path: path.join(profile, 'russian-onboarding.png') })
    assert.deepEqual(errors, [])
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), process.env.EXPECTED_DESKTOP_VERSION)
    console.log('NSIS_RUSSIAN_ONBOARDING_RENDERED_NO_PAGE_ERRORS')
  } finally { await app.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })

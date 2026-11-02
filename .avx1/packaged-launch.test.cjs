const assert = require('node:assert/strict')
const { test } = require('node:test')
const { assertProductionFuses, debuggerEndpoint } = require('./packaged-launch.cjs')
const { FuseV1Options } = require('@electron/fuses')
const { FuseState } = require('@electron/fuses/dist/constants')

test('packaged smoke refuses weakened shipping fuses', () => {
  const fuses = {}
  for (const key of ['EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']) fuses[FuseV1Options[key]] = FuseState.DISABLE
  for (const key of ['EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar']) fuses[FuseV1Options[key]] = FuseState.ENABLE
  assertProductionFuses(fuses)
  for (const key of Object.keys(fuses)) {
    assert.throws(() => assertProductionFuses({ ...fuses, [key]: fuses[key] === FuseState.ENABLE ? FuseState.DISABLE : FuseState.ENABLE }))
  }
})

test('CDP endpoint accepts only the spawned Chromium loopback browser endpoint', () => {
  assert.equal(debuggerEndpoint('noise\nDevTools listening on ws://127.0.0.1:1234/devtools/browser/abc-def\n'), 'ws://127.0.0.1:1234/devtools/browser/abc-def')
  assert.equal(debuggerEndpoint('DevTools listening on ws://example.com:1234/devtools/browser/abc'), undefined)
  assert.equal(debuggerEndpoint('Debugger listening on ws://127.0.0.1:1234/abc'), undefined)
})

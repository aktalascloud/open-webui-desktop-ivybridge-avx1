import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import ts from 'typescript'

const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true)
let uninstall
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'ipcMain.handle' &&
      node.arguments[0]?.text === 'package:uninstall') uninstall = node.arguments[1].getText(tree)
  ts.forEachChild(node, visit)
}
visit(tree)
assert.ok(uninstall)

test('project-managed packages never reach direct pip uninstall; standalone ownership remains supported', async () => {
  const calls = []
  let managed = true
  const runtime = { getConfig: async () => ({ localServer: { managedBackend: managed } }),
    uninstallPackage: name => { calls.push(name); return true },
    sendToRenderer() {}, isPackageInstalled: () => true, updateTray() {} }
  const handler = new Function('runtime', `with (runtime) { return (${stripTypeScriptTypes(uninstall)}) }`)(runtime)
  for (const name of ['open-webui', 'open-terminal']) await assert.rejects(handler({}, name), /Project-managed/)
  assert.deepEqual(calls, [])
  managed = false
  assert.equal(await handler({}, 'open-terminal'), true)
  assert.deepEqual(calls, ['open-terminal'])
})

const component = readFileSync(new URL('../src/renderer/src/lib/components/Main/Settings/OpenTerminal.svelte', import.meta.url), 'utf8')
const script = component.slice(component.indexOf('>') + 1, component.indexOf('</script>'))
const settings = ts.createSourceFile('settings.ts', script, ts.ScriptTarget.Latest, true)
let update
for (const node of settings.statements) {
  if (ts.isVariableStatement(node)) {
    const item = node.declarationList.declarations.find(declaration => declaration.name.getText(settings) === 'updatePackage')
    if (item) update = item.initializer.getText(settings)
  }
}
assert.ok(update)
function fixture(installer) {
  const runtime = { updating: false, operationError: '', otInfo: null, version: null,
    window: { electronAPI: { updateOpenTerminal: installer, getPackageVersion: async () => 'new-version',
      getOpenTerminalInfo: async () => ({ status: 'failed' }) } } }
  Object.defineProperty(runtime, 'busy', { get: () => runtime.updating })
  return { runtime, update: new Function('runtime', `with (runtime) { return (${stripTypeScriptTypes(update)}) }`)(runtime) }
}

test('actual settings update invokes the controller and ignores duplicate clicks while pending', async () => {
  let finish, calls = 0
  const f = fixture(() => { calls++; return new Promise(resolve => { finish = resolve }) })
  const pending = f.update()
  await f.update()
  assert.equal(calls, 1)
  finish({ status: 'started', external: true })
  await pending
  assert.equal(f.runtime.version, 'new-version')
  assert.equal(f.runtime.updating, false)
  assert.equal(f.runtime.operationError, '')
})

test('actual settings update displays failure and clears busy state instead of reporting success', async () => {
  const f = fixture(async () => { throw Error('synthetic controller refusal') })
  await f.update()
  assert.equal(f.runtime.operationError, 'synthetic controller refusal')
  assert.equal(f.runtime.updating, false)
  assert.equal(f.runtime.version, null)
  assert.equal(f.runtime.otInfo.status, 'failed')
})

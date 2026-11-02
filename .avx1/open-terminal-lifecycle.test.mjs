import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import ts from 'typescript'

const serviceSource = readFileSync(new URL('../src/main/process/managedService.ts', import.meta.url), 'utf8')
  .replace("'./outputBuffer'", JSON.stringify(new URL('../src/main/process/outputBuffer.ts', import.meta.url).href))
const { ManagedService, waitForReady } = await import(`data:text/javascript;base64,${Buffer.from(
  stripTypeScriptTypes(serviceSource, { mode: 'transform' })
).toString('base64')}`)
const source = readFileSync(new URL('../src/main/utils/open-terminal.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('terminal.ts', source, ts.ScriptTarget.Latest, true)
const body = stripTypeScriptTypes(tree.statements.filter(node => !ts.isImportDeclaration(node))
  .map(node => node.getText(tree)).join('\n').replace(/^export /gm, ''))

function fixture(managed = true) {
  const calls = [], requests = [], writes = [], launches = []
  const config = { localServer: { managedBackend: managed },
    openTerminal: { port: 39284, apiKey: 'synthetic-key', cwd: 'synthetic-home' }, envVars: {} }
  let exit
  const child = { pid: 42, onData: callback => { child.output = callback; return { dispose() {} } },
    onExit: callback => { exit = callback; return { dispose() {} } },
    kill: force => { calls.push(['kill', force]); exit({ exitCode: 0 }) }, write() {}, resize() {} }
  const dependencies = {
    ManagedService, waitForReady,
    crypto: { randomBytes: () => { calls.push('generate-key'); return { toString: () => 'synthetic-generated' } } },
    os: { homedir: () => 'synthetic-home' }, log: { info() {} },
    spawnPty: launch => { launches.push(launch); return child },
    getConfig: async () => config,
    setConfig: async value => { writes.push(value); Object.assign(config, value) },
    getPythonPath: () => 'synthetic-python',
    isPythonInstalled: () => true,
    isPackageInstalled: () => true,
    installPython: async () => { calls.push('install-python'); return true },
    installPackage: async () => { calls.push('install-package'); return true },
    portInUse: async () => { calls.push('port-check'); return false },
    pythonEnv: () => ({ KEEP: 'yes', OPEN_TERMINAL_API_KEY_FILE: 'unrelated-private-path', open_terminal_api_key: 'unrelated-key' }),
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ status: 'ok' }) } }
  }
  const module = new Function('dependencies', `with (dependencies) { ${body};
    return {startOpenTerminal, stopOpenTerminal, updateOpenTerminal, getOpenTerminalInfo, terminalService}; }`)(dependencies)
  return { ...module, config, calls, requests, writes, launches, dependencies, child }
}

test('managed Terminal authenticates without spawning, installing, changing a key or stopping the external process', async () => {
  const f = fixture()
  const info = await f.startOpenTerminal()
  assert.equal(info.status, 'started')
  assert.equal(info.external, true)
  assert.equal(info.pid, null)
  assert.equal(info.apiKey, 'synthetic-key')
  assert.equal(f.requests[0].url, 'http://127.0.0.1:39284/api/health')
  assert.equal(f.requests[0].options.headers.Authorization, 'Bearer synthetic-key')
  assert.equal(f.requests[0].options.redirect, 'error')
  await f.stopOpenTerminal()
  await f.terminalService.shutdown()
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.writes, [])
  assert.deepEqual(f.launches, [])
  assert.equal(f.getOpenTerminalInfo().apiKey, null)
})

test('missing credentials or failed external authentication never falls back to another port or owned launch', async () => {
  for (const missingKey of [false, true]) {
    const f = fixture()
    if (missingKey) f.config.openTerminal.apiKey = ''
    f.dependencies.fetch = async () => ({ ok: false, status: 401 })
    await assert.rejects(f.startOpenTerminal())
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.launches, [])
    assert.deepEqual(f.writes, [])
    assert.equal(f.getOpenTerminalInfo().apiKey, null)
  }
})

test('occupied standalone port fails before installing or mutating private settings', async () => {
  const f = fixture(false)
  f.dependencies.portInUse = async () => true
  await assert.rejects(f.startOpenTerminal(), /already in use/)
  assert.deepEqual(f.launches, [])
  assert.deepEqual(f.writes, [])
  assert.deepEqual(f.calls, [])
})

test('concurrent owned starts share one child and retain configured key outside argv', async () => {
  const f = fixture(false)
  const [left, right] = await Promise.all([f.startOpenTerminal(), f.startOpenTerminal()])
  assert.equal(f.launches.length, 1)
  assert.equal(left.pid, 42)
  assert.equal(right.pid, 42)
  assert.equal(f.launches[0].env.OPEN_TERMINAL_API_KEY, 'synthetic-key')
  assert.equal(f.launches[0].env.OPEN_TERMINAL_API_KEY_FILE, undefined)
  assert.equal(f.launches[0].env.open_terminal_api_key, undefined)
  assert.equal(f.launches[0].args.includes('synthetic-key'), false)
  assert.deepEqual(f.writes, [])
  await f.stopOpenTerminal()
  assert.deepEqual(f.calls.filter(Array.isArray), [['kill', false]])
})

test('new standalone key is generated once and preserves freshly read settings', async () => {
  const f = fixture(false)
  f.config.openTerminal.apiKey = ''
  await f.startOpenTerminal()
  assert.equal(f.calls.filter(value => value === 'generate-key').length, 1)
  assert.deepEqual(f.writes, [{ openTerminal: { port: 39284, cwd: 'synthetic-home', apiKey: 'synthetic-generated' } }])
  await f.stopOpenTerminal()
})

test('cancelled preparation finishes its installer without spawning or generating a replacement key', async () => {
  const f = fixture(false)
  let finish, entered
  const installing = new Promise(resolve => { entered = resolve })
  f.dependencies.isPackageInstalled = () => false
  f.dependencies.installPackage = () => { entered(); return new Promise(resolve => { finish = resolve }) }
  const pending = f.startOpenTerminal()
  const rejection = assert.rejects(pending, /cancelled/)
  await installing
  const stopping = f.stopOpenTerminal()
  finish(true)
  await stopping
  await rejection
  assert.deepEqual(f.launches, [])
  assert.deepEqual(f.writes, [])
})

test('owned Terminal output retains the shared byte bound for a single oversized chunk', async () => {
  const f = fixture(false)
  await f.startOpenTerminal()
  f.child.output('界'.repeat(200000))
  assert.ok(Buffer.byteLength(f.terminalService.logs) < 262200)
  assert.ok(!f.terminalService.logs.includes('\ufffd'))
  await f.stopOpenTerminal()
})

test('managed update invokes the guarded installer once; concurrent start shares the update and never spawns', async () => {
  const f = fixture()
  await f.startOpenTerminal()
  let finish, entered
  const installing = new Promise(resolve => { entered = resolve })
  f.dependencies.installPackage = () => { f.calls.push('install-package'); entered(); return new Promise(resolve => { finish = resolve }) }
  const update = f.updateOpenTerminal()
  assert.equal(f.updateOpenTerminal(), update)
  await installing
  const start = f.startOpenTerminal()
  assert.equal(start, update)
  finish(true)
  assert.equal((await update).status, 'started')
  assert.equal((await start).apiKey, 'synthetic-key')
  assert.deepEqual(f.calls, ['install-package'])
  assert.deepEqual(f.launches, [])
  assert.deepEqual(f.writes, [])
})

test('stop during an atomic update waits for its completion and prevents reattachment', async () => {
  const f = fixture()
  await f.startOpenTerminal()
  let finish, entered
  const installing = new Promise(resolve => { entered = resolve })
  f.dependencies.installPackage = () => { entered(); return new Promise(resolve => { finish = resolve }) }
  const update = f.updateOpenTerminal()
  const rejection = assert.rejects(update, /cancelled/)
  await installing
  const stopping = f.stopOpenTerminal()
  finish(true)
  await stopping
  await rejection
  assert.equal(f.getOpenTerminalInfo().status, 'stopped')
  assert.deepEqual(f.launches, [])
  assert.deepEqual(f.writes, [])
})

test('failed installer is not retried, does not change key or spawn a fallback, and releases its barrier', async () => {
  const f = fixture()
  f.dependencies.installPackage = async () => { f.calls.push('install-package'); throw Error('synthetic update failure') }
  await assert.rejects(f.updateOpenTerminal(), /update failure/)
  assert.deepEqual(f.calls, ['install-package'])
  assert.deepEqual(f.launches, [])
  assert.deepEqual(f.writes, [])
  assert.equal((await f.startOpenTerminal()).status, 'started')
  assert.deepEqual(f.calls, ['install-package'])
})

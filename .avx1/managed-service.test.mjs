import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

const moduleUrl = new URL('../src/main/process/managedService.ts', import.meta.url)
const source = readFileSync(moduleUrl, 'utf8').replace(
  "'./outputBuffer'",
  JSON.stringify(new URL('../src/main/process/outputBuffer.ts', import.meta.url).href)
)
const { ManagedService } = await import(`data:text/javascript;base64,${Buffer.from(
  stripTypeScriptTypes(source, { mode: 'transform' })
).toString('base64')}`)

function externalFixture() {
  let spawns = 0
  const service = new ManagedService(() => { spawns++; throw Error('external spawn') }, true)
  return { service, assertNoSpawn: () => assert.equal(spawns, 0) }
}

test('external readiness is shared; input, stop and shutdown never own a process', async () => {
  const { service, assertNoSpawn } = externalFixture()
  let probes = 0
  const prepare = async () => ({ external: true, url: 'http://127.0.0.1:8080',
    ready: async () => { probes++ } })
  const states = []
  service.subscribe(event => { if (event.type === 'state') states.push(event.info.status) })
  const first = service.start(prepare)
  assert.equal(service.start(prepare), first)
  await first
  assert.equal(probes, 1)
  assert.equal(service.info.pid, null)
  assert.equal(service.info.reachable, true)
  service.write(service.info.runId, 'never sent')
  service.resize(service.info.runId, 80, 24)
  await service.stop()
  assert.equal(service.info.status, 'stopped')
  await service.shutdown()
  assertNoSpawn()
  assert.deepEqual(states, ['starting', 'starting', 'started', 'stopping', 'stopped', 'stopping', 'stopped'])
  await assert.rejects(service.start(prepare), /shutting down/)
})

test('failed external health probe does not spawn a replacement or acquire a PID', async () => {
  const { service, assertNoSpawn } = externalFixture()
  await assert.rejects(service.start(async () => ({ external: true, url: 'http://127.0.0.1:8080',
    ready: async () => { throw Error('unavailable') } })), /unavailable/)
  assert.equal(service.info.status, 'failed')
  assert.equal(service.info.pid, null)
  assert.equal(service.info.reachable, false)
  await service.shutdown()
  assertNoSpawn()
})

test('stop cancels a non-cooperative external health read without killing any process', async () => {
  const { service, assertNoSpawn } = externalFixture()
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const pending = service.start(async () => ({ external: true, url: 'http://127.0.0.1:8080',
    ready: async () => { entered(); await new Promise(() => {}) } }))
  const rejection = assert.rejects(pending, /cancelled/)
  await started
  await service.stop()
  await rejection
  assert.equal(service.info.status, 'stopped')
  assertNoSpawn()
})

test('owned PTY still receives input and exits through graceful lifecycle', async () => {
  let onExit
  const calls = []
  const child = { pid: 42,
    onData: () => ({ dispose() {} }),
    onExit: callback => { onExit = callback; return { dispose() {} } },
    write: data => calls.push(['write', data]),
    resize: (cols, rows) => calls.push(['resize', cols, rows]),
    kill: force => { calls.push(['kill', force]); onExit({ exitCode: 0 }) } }
  const service = new ManagedService(() => child, true)
  await service.start(async () => ({ file: 'synthetic-python', args: [], env: {},
    url: 'http://127.0.0.1:8081', ready: async () => {} }))
  service.write(service.info.runId - 1, 'stale')
  service.write(service.info.runId, 'hello')
  service.resize(service.info.runId, 80, 24)
  await service.stop()
  assert.deepEqual(calls, [['write', 'hello'], ['resize', 80, 24], ['kill', false]])
  assert.equal(service.info.pid, null)
  assert.equal(service.info.status, 'stopped')
})

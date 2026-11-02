import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import ts from 'typescript'
import { VoiceInputSessions, isOwnedVoiceGuest } from '../src/main/voice-input-session.ts'

const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const callbacks = new Map()
let requireCaller
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'requireVoiceCaller') requireCaller = node.getText(tree)
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'ipcMain.handle' &&
      ts.isStringLiteral(node.arguments[0])) callbacks.set(node.arguments[0].text, node.arguments[1].getText(tree))
  ts.forEachChild(node, visit)
}
visit(tree)
assert.ok(requireCaller)

function fixture() {
  const voice = { mainFrame: {}, getURL: () => 'file:///app/voice-input.html' }
  const target = { connectionId: 'local', url: 'http://127.0.0.1:8080', guestId: 7 }
  let current = { ...target }, token = 'synthetic-A'
  const posts = [], events = []
  const sessions = new VoiceInputSessions(async () => token)
  const runtime = {
    voiceSessions: sessions,
    voiceInputWindow: { webContents: voice, hide() {} },
    voiceInputRecording: true,
    nativeVoiceURL: () => 'file:///app/voice-input.html',
    currentVoiceTarget: async () => ({ ...current }),
    fetch: async (url, options) => {
      posts.push({ url, options })
      return { ok: true, json: async () => ({ text: 'server transcript' }) }
    },
    Buffer,
    Notification: class { show() {} }, nativeText: value => value,
    log: { error() {} }, playChime() {}, showMainWindow() {},
    sendToRenderer: (type, data) => events.push({ type, data })
  }
  runtime.requireVoiceCaller = new Function('runtime', `with (runtime) { ${stripTypeScriptTypes(requireCaller)}; return requireVoiceCaller }`)(runtime)
  function callback(name) {
    const body = callbacks.get(name)
    assert.ok(body, name)
    return new Function('runtime', `with (runtime) { return (${stripTypeScriptTypes(body)}) }`)(runtime)
  }
  return { runtime, sessions, posts, events, target,
    event: { sender: voice, senderFrame: voice.mainFrame }, callback,
    select: value => { current = { ...target, ...value } },
    token: value => { token = value } }
}

test('real IPC posts once to the captured target and delivers only the server result', async () => {
  const f = fixture()
  const id = await f.sessions.begin(f.target)
  const result = await f.callback('voiceInput:transcribe')(f.event, id, new ArrayBuffer(16))
  assert.deepEqual(result, { text: 'server transcript' })
  assert.equal(f.posts.length, 1)
  assert.equal(f.posts[0].url, 'http://127.0.0.1:8080/api/v1/audio/transcriptions')
  assert.equal(f.posts[0].options.redirect, 'error')
  assert.equal(f.posts[0].options.headers.Authorization, 'Bearer synthetic-A')
  await f.callback('voiceInput:done')(f.event, id, 'renderer-forged transcript')
  assert.deepEqual(f.events, [{ type: 'query', data: { query: 'server transcript', connectionId: 'local', url: f.target.url } }])
  await assert.rejects(f.callback('voiceInput:transcribe')(f.event, id, new ArrayBuffer(16)))
  assert.equal(f.posts.length, 1)
})

test('real IPC rejects other frames and invalid buffers before any network call', async () => {
  const f = fixture()
  const id = await f.sessions.begin(f.target)
  await assert.rejects(f.callback('voiceInput:transcribe')({ ...f.event, senderFrame: {} }, id, new ArrayBuffer(16)), /caller/)
  await assert.rejects(f.callback('voiceInput:transcribe')(f.event, id, { byteLength: 16 }), /buffer/)
  assert.equal(f.posts.length, 0)
  assert.equal(f.sessions.id, id)
})

test('connection selection changes prevent upload and transcript delivery to the new account', async () => {
  const f = fixture()
  let id = await f.sessions.begin(f.target)
  f.select({ connectionId: 'remote', url: 'https://other.invalid', guestId: 8 })
  await assert.rejects(f.callback('voiceInput:transcribe')(f.event, id, new ArrayBuffer(16)), /connection changed/)
  assert.equal(f.posts.length, 0)
  f.select({})
  id = await f.sessions.begin(f.target)
  await f.callback('voiceInput:transcribe')(f.event, id, new ArrayBuffer(16))
  f.select({ connectionId: 'remote', url: 'https://other.invalid', guestId: 8 })
  await assert.rejects(f.callback('voiceInput:done')(f.event, id), /connection changed/)
  assert.deepEqual(f.events, [])
})

test('uncertain transport failure cannot be submitted again and stale close cannot cancel a newer recording', async () => {
  const f = fixture()
  f.runtime.fetch = async () => { f.posts.push('uncertain'); throw Error('synthetic transport failure') }
  const first = await f.sessions.begin(f.target)
  await assert.rejects(f.callback('voiceInput:transcribe')(f.event, first, new ArrayBuffer(16)))
  await assert.rejects(f.callback('voiceInput:transcribe')(f.event, first, new ArrayBuffer(16)))
  assert.equal(f.posts.length, 1)
  const second = await f.sessions.begin(f.target)
  f.callback('voiceInput:close')(f.event, first)
  assert.equal(f.sessions.id, second)
})

test('guest registry accepts only configured guests owned by the trusted main frame and its partition', async () => {
  const f = fixture()
  const owner = { mainFrame: {} }, partition = {}, other = {}
  const guest = { id: 7, hostWebContents: owner, session: partition,
    getType: () => 'webview', isDestroyed: () => false, getURL: () => f.target.url }
  Object.assign(f.runtime, {
    mainWindow: { webContents: owner }, voiceGuests: new Map(),
    getConfig: async () => ({ connections: [] }),
    buildLocalConnection: () => ({ id: 'local', url: f.target.url }),
    resolveConnectionUrl: connection => connection.url,
    webContents: { fromId: id => id === 7 ? guest : undefined },
    session: { fromPartition: value => value === 'persist:connection-local' ? partition : other },
    isOwnedVoiceGuest
  })
  const event = { sender: owner, senderFrame: owner.mainFrame }
  const register = f.callback('connection:guest')
  await assert.rejects(register({ ...event, senderFrame: {} }, 'local', 7), /registration/)
  await assert.rejects(register(event, 'unknown', 7), /Unknown connection/)
  await register(event, 'local', 7)
  assert.equal(f.runtime.voiceGuests.get('local'), 7)
  guest.session = other
  await assert.rejects(register(event, 'local', 7), /Invalid connection guest/)
  f.callback('connection:guest:remove')(event, 'local', 8)
  assert.equal(f.runtime.voiceGuests.get('local'), 7)
  f.callback('connection:guest:remove')(event, 'local', 7)
  assert.equal(f.runtime.voiceGuests.size, 0)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { stripTypeScriptTypes } from 'node:module'
import { handleGuestSend, isGuestSendType, isGuestLoadPage, canRelayDesktopEvent } from '../src/renderer/src/lib/guest-protocol.ts'
import { handleGuestRequest } from '../src/renderer/src/lib/guest-requests.ts'

const component = readFileSync(new URL('../src/renderer/src/lib/components/Main/Connections/ConnectionView.svelte', import.meta.url), 'utf8')
const script = component.slice(component.indexOf('>') + 1, component.indexOf('</script>'))
const tree = ts.createSourceFile('view.ts', script, ts.ScriptTarget.Latest, true)
const node = tree.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'attachWebview')
assert.ok(node)
const body = stripTypeScriptTypes(node.getText(tree), { mode: 'transform' })

function fixture(connectionId = 'local', serverUrl = 'http://127.0.0.1:8080') {
  const calls = []
  const listeners = new Map()
  let address = serverUrl
  const api = {
    getOpenTerminalInfo: async () => { calls.push('terminal'); return { status: 'started', url: 'http://127.0.0.1:39284', apiKey: 'synthetic' } },
    getOllamaInfo: async () => ({ reachable: true, url: 'http://127.0.0.1:11434' }),
    getLlamaCppInfo: async () => ({ reachable: true, url: 'http://127.0.0.1:18881' }),
    getAppInfo: async () => ({ version: 'fixture', platform: 'win32', username: 'private' }),
    getVersion: async () => 'fixture',
    setAuthToken: async token => calls.push(['token', token]),
    isWindowFocused: async () => ({ isFocused: true }),
    openInBrowser: async url => calls.push(['open', url]),
    notification: async (...args) => calls.push(['notification', ...args]),
    setConfig: async value => calls.push(['config', value]),
    registerConnectionGuest: async (...args) => calls.push(['register', ...args]),
    unregisterConnectionGuest: async (...args) => calls.push(['unregister', ...args])
  }
  const sent = []
  const wv = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name) },
    getURL: () => address, getTitle: () => 'fixture', getWebContentsId: () => 7,
    send: (channel, data) => sent.push({ channel, data })
  }
  const factory = new Function('window', 'serverUrl', 'connectionId', 'handleGuestSend', 'isGuestSendType',
    'isGuestLoadPage', 'canRelayDesktopEvent', 'handleGuestRequest', `
    let webview, webviewBackground, webviewTitle, canRefresh, webviewError, webviewLoading;
    const active = true, onSetView = () => {}, $i18n = { t: key => key };
    const config = { update() {} }, $config = { theme: 'system' };
    ${body}; return attachWebview;
  `)
  const attach = factory({ electronAPI: api }, serverUrl, connectionId, handleGuestSend, isGuestSendType,
    isGuestLoadPage, canRelayDesktopEvent, handleGuestRequest)
  const attachment = attach(wv)
  return { api, calls, sent, listeners, attachment, navigate: value => { address = value },
    ipc: (channel, payload) => listeners.get('ipc-message')?.({ channel, args: [payload] }) }
}

test('per-connection guest requests retain safe native API and reject privileged commands', async () => {
  const f = fixture()
  await f.ipc('webview:send', { type: 'app:info', _requestId: '1' })
  assert.deepEqual(f.sent.at(-1).data.data, { version: 'fixture', platform: 'win32', arch: undefined })
  await f.ipc('webview:send', { type: 'resetApp', _requestId: '2' })
  assert.deepEqual(f.sent.at(-1).data.data, { error: 'Desktop request rejected' })
  await f.ipc('webview:send', { type: 'getVersion', _requestId: '3' })
  assert.equal(f.sent.at(-1).data.data, 'fixture')
  await f.ipc('webview:send', { type: 'openInBrowser', url: 'file:///private', _requestId: '4' })
  assert.deepEqual(f.calls, [])
})

test('local capability replay never reads private Terminal state for remote guests', async () => {
  const remote = fixture('remote', 'https://saved.invalid')
  await remote.ipc('webview:ready')
  assert.deepEqual(remote.calls, [])
  assert.deepEqual(remote.sent, [])
  const local = fixture()
  await local.ipc('webview:ready')
  assert.deepEqual(local.calls, ['terminal'])
  assert.equal(local.sent.length, 3)
  assert.equal(local.sent[0].data.type, 'connections:terminal')
  assert.equal(local.sent[0].data.data.key, 'synthetic')
  assert.equal(local.sent[2].data.data.config.provider, 'ollama')
  assert.equal(local.sent[2].data.data.url, 'http://127.0.0.1:11434/v1')
})

test('navigation during an awaited capability read or API response blocks later delivery', async () => {
  const f = fixture()
  let finish
  f.api.getOpenTerminalInfo = () => new Promise(resolve => { finish = resolve })
  const replay = f.ipc('webview:ready')
  f.navigate('https://evil.invalid')
  finish({ status: 'started', url: 'http://127.0.0.1:39284', apiKey: 'synthetic' })
  await replay
  assert.deepEqual(f.sent, [])
  const g = fixture()
  g.api.getAppInfo = () => new Promise(resolve => { finish = resolve })
  const response = g.ipc('webview:send', { type: 'app:info', _requestId: '1' })
  g.navigate('https://evil.invalid')
  finish({ version: 'fixture' })
  await response
  assert.deepEqual(g.sent, [])
})

test('destroy removes listeners and suppresses a pending readiness replay', async () => {
  const f = fixture()
  let finish
  f.api.getOpenTerminalInfo = () => new Promise(resolve => { finish = resolve })
  const replay = f.ipc('webview:ready')
  f.attachment.destroy()
  finish({ status: 'started', url: 'http://127.0.0.1:39284', apiKey: 'synthetic' })
  await replay
  assert.equal(f.listeners.size, 0)
  assert.deepEqual(f.sent, [])
})

test('the mounted guest registers and unregisters its own connection identity without relaying tokens', async () => {
  const f = fixture('remote', 'https://saved.invalid')
  f.listeners.get('dom-ready')()
  await Promise.resolve()
  assert.deepEqual(f.calls, [['register', 'remote', 7]])
  f.attachment.destroy()
  await Promise.resolve()
  assert.deepEqual(f.calls, [['register', 'remote', 7], ['unregister', 'remote', 7]])
})

const connections = readFileSync(new URL('../src/renderer/src/lib/components/Main/Connections.svelte', import.meta.url), 'utf8')
const connectionScript = connections.slice(connections.indexOf('>') + 1, connections.indexOf('</script>'))
const connectionTree = ts.createSourceFile('connections.ts', connectionScript, ts.ScriptTarget.Latest, true)
let connectCode
ts.forEachChild(connectionTree, node => {
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations.find(item => item.name.getText(connectionTree) === 'connect')
    if (declaration) connectCode = stripTypeScriptTypes('const connect = ' + declaration.initializer.getText(connectionTree))
  }
})
assert.ok(connectCode)
function connectionFixture(connectTo) {
  const defaults = []
  return new Function('window', `
    let connectRequest = 0, showingLogs = false, activeConnectionId = '', view = 'welcome', connectingId = '', error = '';
    let openConnections = new Map(); const $i18n = { t: key => key };
    ${connectCode};
    return { connect, state: () => ({activeConnectionId, view, connectingId, error, openConnections}) };
  `)({ electronAPI: { connectTo, setDefaultConnection: async id => { defaults.push(id) } } })
}

test('late completion cannot replace the newer selected connection', async () => {
  const pending = new Map()
  const f = connectionFixture(id => new Promise(resolve => pending.set(id, resolve)))
  const first = f.connect('local')
  await Promise.resolve()
  const second = f.connect('remote')
  await Promise.resolve()
  pending.get('remote')({ url: 'https://saved.invalid' })
  assert.equal(await second, true)
  pending.get('local')({ url: 'http://127.0.0.1:8080' })
  assert.equal(await first, false)
  assert.equal(f.state().activeConnectionId, 'remote')
  assert.equal(f.state().view, 'connected')
  assert.equal(f.state().openConnections.has('local'), false)
})

test('failed local start reports failure without claiming an open connection', async () => {
  const f = connectionFixture(async () => null)
  assert.equal(await f.connect('local'), false)
  assert.equal(f.state().error, 'error.serverStartFailed')
  assert.equal(f.state().connectingId, '')
  assert.equal(f.state().openConnections.size, 0)
})

test('explicit reopen retains the selected view while a sidebar toggle hides it without discarding it', async () => {
  const f = connectionFixture(async () => ({ url: 'https://saved.invalid' }))
  await f.connect('remote')
  assert.equal(await f.connect('remote', false), true)
  assert.equal(f.state().view, 'connected')
  await f.connect('remote')
  assert.equal(f.state().view, 'welcome')
  assert.equal(f.state().openConnections.size, 1)
})

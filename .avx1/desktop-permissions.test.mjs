import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { isConfiguredConnectionURL } from '../src/main/guest-webview.ts'

// Evaluate the real registered callbacks with synthetic Electron authorities.
// No windows, media devices or screen enumeration are used.
const text = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true)
function callbacks(name) {
  const found = []
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === name) found.push(node.arguments[0].getText(tree))
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}
const [voiceCode, browserCode] = callbacks('setPermissionRequestHandler')
const [displayCode] = callbacks('setDisplayMediaRequestHandler')
assert.equal(callbacks('setPermissionRequestHandler').length, 2)
const configured = ['https://saved.invalid']

test('voice permission belongs only to its native audio frame', () => {
  const owner = {}
  const url = 'file:///app/voice-input.html'
  const voice = new Function('voiceInputWindow', 'voiceInputURL', `return (${voiceCode})`)(
    { webContents: owner }, url)
  const details = { isMainFrame: true, requestingUrl: url, mediaTypes: ['audio'] }
  function check(content, permission, request) {
    let granted
    voice(content, permission, result => { granted = result }, request)
    return granted
  }
  assert.equal(check(owner, 'media', details), true)
  assert.equal(check({}, 'media', details), false)
  assert.equal(check(owner, 'media', { ...details, requestingUrl: 'https://evil.invalid' }), false)
  assert.equal(check(owner, 'media', { ...details, isMainFrame: false }), false)
  assert.equal(check(owner, 'media', { ...details, mediaTypes: ['audio', 'video'] }), false)
  assert.equal(check(owner, 'media', { ...details, mediaTypes: [] }), false)
  assert.equal(check(owner, 'display-capture', details), false)
})

test('saved browser permissions check requesting frame and limit filesystem access to reads', () => {
  const browser = new Function('isConfiguredConnectionURL', 'connectionURLs', `return (${browserCode})`)(
    isConfiguredConnectionURL, () => configured)
  function check(top, permission, details) {
    let granted
    browser({ getURL: () => top }, permission, result => { granted = result }, details)
    return granted
  }
  const details = { requestingUrl: 'https://saved.invalid/chat' }
  assert.equal(check('https://saved.invalid', 'media', details), true)
  assert.equal(check('https://saved.invalid', 'media', { requestingUrl: 'https://evil.invalid' }), false)
  assert.equal(check('https://evil.invalid', 'media', details), false)
  assert.equal(check('https://saved.invalid', 'fileSystem', { ...details, fileAccessType: 'readable' }), true)
  assert.equal(check('https://saved.invalid', 'fileSystem', { ...details, fileAccessType: 'writable' }), false)
  assert.equal(check('https://saved.invalid', 'unknown', details), false)
})

test('display capture rejects unknown origins and redirects, and handles source failures', async () => {
  let enumerate = 0
  let resolveSources
  const capturer = { getSources: () => { enumerate++; return new Promise(resolve => { resolveSources = resolve }) } }
  function handler(capture = capturer) {
    return new Function('isConfiguredConnectionURL', 'connectionURLs', 'desktopCapturer', `return (${displayCode})`)(
      isConfiguredConnectionURL, () => configured, capture)
  }
  const display = handler()
  const request = { securityOrigin: 'https://saved.invalid', frame: { url: 'https://saved.invalid/chat' } }
  let granted
  display({ ...request, securityOrigin: 'https://evil.invalid' }, value => { granted = value })
  assert.deepEqual(granted, {})
  assert.equal(enumerate, 0)
  display(request, value => { granted = value })
  request.frame.url = 'https://evil.invalid'
  resolveSources([{ id: 'synthetic-screen' }])
  await Promise.resolve()
  assert.deepEqual(granted, {})
  request.frame.url = 'https://saved.invalid/chat'
  display(request, value => { granted = value })
  resolveSources([{ id: 'synthetic-screen' }])
  await Promise.resolve()
  assert.deepEqual(granted, { video: { id: 'synthetic-screen' }, audio: 'loopback' })
  handler({ getSources: () => Promise.reject(Error('synthetic failure')) })(request, value => { granted = value })
  await Promise.resolve()
  assert.deepEqual(granted, {})
})

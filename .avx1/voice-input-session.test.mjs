import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VoiceInputSessions, readOwnedVoiceToken, isOwnedVoiceGuest } from '../src/main/voice-input-session.ts'

const target = { connectionId: 'local', url: 'http://127.0.0.1:8080', guestId: 7 }
function guestFixture() {
  const host = {}, partition = {}
  let url = target.url, token = 'synthetic-A', reads = 0
  const guest = { id: 7, isDestroyed: () => false, getType: () => 'webview', getURL: () => url,
    hostWebContents: host, session: partition,
    executeJavaScript: async source => {
      assert.equal(source, "localStorage.getItem('token') || ''")
      reads++
      return token
    } }
  return { guest, host, partition, navigate: value => { url = value }, token: value => { token = value }, reads: () => reads }
}

test('only the exact owned guest, partition and origin can supply the token', async () => {
  const f = guestFixture()
  assert.equal(await readOwnedVoiceToken(f.guest, target, f.host, f.partition), 'synthetic-A')
  for (const overrides of [{ id: 8 }, { hostWebContents: {} }, { session: {} }, { getType: () => 'window' },
    { isDestroyed: () => true }, { getURL: () => 'https://other.invalid' }]) {
    assert.equal(isOwnedVoiceGuest({ ...f.guest, ...overrides }, target, f.host, f.partition), false)
  }
  assert.equal(isOwnedVoiceGuest(f.guest, { ...target, url: 'http://user:password@127.0.0.1:8080' }, f.host, f.partition), false)
  assert.equal(f.reads(), 1)
})

test('redirect while reading storage rejects the result', async () => {
  const f = guestFixture()
  f.guest.executeJavaScript = async () => { f.navigate('https://other.invalid'); return 'synthetic-A' }
  await assert.rejects(readOwnedVoiceToken(f.guest, target, f.host, f.partition), /changed/)
})

test('empty or malformed current token never falls back to another browser context', async () => {
  const f = guestFixture()
  for (const value of ['', null, { token: 'synthetic' }, 'x'.repeat(16385)]) {
    f.token(value)
    await assert.rejects(readOwnedVoiceToken(f.guest, target, f.host, f.partition), /Not authenticated/)
  }
  assert.equal(f.reads(), 4)
})

test('one captured account gets one submission and one server-result delivery', async () => {
  const sessions = new VoiceInputSessions(async () => 'synthetic-A')
  const id = await sessions.begin(target)
  const claim = await sessions.claim(id, target)
  assert.equal(claim.url, target.url)
  assert.equal(claim.token, 'synthetic-A')
  await assert.rejects(sessions.claim(id, target), /already submitted/)
  sessions.finish(id, '  transcript  ')
  assert.deepEqual(await sessions.deliver(id, target), { target, text: 'transcript' })
  assert.equal(claim.signal.aborted, true)
  await assert.rejects(sessions.deliver(id, target), /changed/)
})

test('changed connection, guest or base path rejects before upload', async () => {
  for (const change of [{ connectionId: 'remote' }, { guestId: 8 }, { url: target.url + '/other' }]) {
    const sessions = new VoiceInputSessions(async () => 'synthetic-A')
    const id = await sessions.begin(target)
    await assert.rejects(sessions.claim(id, { ...target, ...change }), /connection changed/)
  }
})

test('switching the signed-in account rejects both upload and later delivery', async () => {
  let token = 'synthetic-A'
  const sessions = new VoiceInputSessions(async () => token)
  let id = await sessions.begin(target)
  token = 'synthetic-B'
  await assert.rejects(sessions.claim(id, target), /account changed/)
  token = 'synthetic-A'
  id = await sessions.begin(target)
  await sessions.claim(id, target)
  sessions.finish(id, 'private transcript')
  token = 'synthetic-B'
  await assert.rejects(sessions.deliver(id, target), /account changed/)
})

test('a superseded recording aborts its request and stale completion cannot affect the new recording', async () => {
  const sessions = new VoiceInputSessions(async () => 'synthetic-A')
  const first = await sessions.begin(target)
  const claim = await sessions.claim(first, target)
  const second = await sessions.begin(target)
  assert.equal(claim.signal.aborted, true)
  assert.throws(() => sessions.finish(first, 'late'), /expired/)
  sessions.cancel(first)
  assert.equal(sessions.id, second)
  assert.equal((await sessions.claim(second, target)).signal.aborted, false)
})

test('simultaneous transcription claims reserve before awaiting token lookup', async () => {
  let reads = 0, finish
  const sessions = new VoiceInputSessions(async () => {
    if (++reads === 1) return 'synthetic-A'
    return new Promise(resolve => { finish = resolve })
  })
  const id = await sessions.begin(target)
  const pending = sessions.claim(id, target)
  await assert.rejects(sessions.claim(id, target), /already submitted/)
  finish('synthetic-A')
  await pending
})

test('cancel during token lookup invalidates a pending recording start', async () => {
  let finish
  const sessions = new VoiceInputSessions(() => new Promise(resolve => { finish = resolve }))
  const pending = sessions.begin(target)
  sessions.cancel()
  finish('synthetic-A')
  await assert.rejects(pending, /superseded/)
  assert.equal(sessions.id, undefined)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

const component = readFileSync(new URL('../src/renderer/src/components/VoiceInput.svelte', import.meta.url), 'utf8')
const script = stripTypeScriptTypes(component.slice(component.indexOf('>') + 1, component.indexOf('</script>'))
  .replace(/^\s*import .* from 'svelte'\s*$/m, ''))

function stream() {
  let stopped = 0
  return { getTracks: () => [{ stop: () => stopped++ }], stopped: () => stopped }
}
function fixture(getUserMedia) {
  const calls = [], recorders = []
  let interval
  const api = { checkMicPermission: async () => 'granted',
    transcribe: async id => { calls.push(['transcribe', id]); return { text: 'synthetic' } },
    done: async id => { calls.push(['done', id]) }, close: async id => { calls.push(['close', id]) },
    error: (...args) => calls.push(['error', ...args]), onRecordingState() {} }
  class Recorder {
    static isTypeSupported() { return true }
    constructor(input, options) { this.stream = input; this.mimeType = options.mimeType; this.state = 'inactive'; recorders.push(this) }
    start() { this.state = 'recording' }
    stop() { this.state = 'inactive'; this.onstop?.() }
    emit() { this.ondataavailable({ data: new Blob([new Uint8Array(8192)]) }) }
  }
  class Context {
    createAnalyser() { return { frequencyBinCount: 2, getByteFrequencyData() {} } }
    createMediaStreamSource() { return { connect() {} } }
    close() { return Promise.resolve() }
  }
  const run = new Function('window', 'navigator', '$state', 'onMount', 'onDestroy', 'MediaRecorder',
    'AudioContext', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', `
    ${script}; return {startRecording, stopRecording, cancelRecording, state: () => ({sessionId, recording, transcribing})};
  `)({ voiceInputAPI: api }, { mediaDevices: { getUserMedia } }, value => value, () => {}, () => {}, Recorder,
    Context, () => 1, () => {}, callback => { callback(); return 1 }, () => {},
    callback => { interval = callback; return 1 }, () => { interval = undefined })
  return { ...run, api, calls, recorders, tick: () => interval?.() }
}

test('cancel before delayed microphone grant stops the acquired stream without creating a recorder', async () => {
  let grant
  const audio = stream()
  const f = fixture(() => new Promise(resolve => { grant = resolve }))
  const pending = f.startRecording(1)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  assert.equal(typeof grant, 'function')
  f.cancelRecording()
  grant(audio)
  await pending
  assert.equal(audio.stopped(), 1)
  assert.equal(f.recorders.length, 0)
  assert.deepEqual(f.calls, [['close', 1]])
})

test('late transcription cannot deliver text or close a newer recording', async () => {
  const firstAudio = stream(), secondAudio = stream()
  let captures = 0, finish, submitted
  const submission = new Promise(resolve => { submitted = resolve })
  const f = fixture(async () => ++captures === 1 ? firstAudio : secondAudio)
  f.api.transcribe = async id => {
    f.calls.push(['transcribe', id])
    submitted()
    return new Promise(resolve => { finish = resolve })
  }
  await f.startRecording(1)
  f.recorders[0].emit()
  f.tick()
  const pending = f.stopRecording()
  await submission
  await f.startRecording(2)
  finish({ text: 'late private transcript' })
  await pending
  assert.deepEqual(f.calls, [['transcribe', 1]])
  assert.equal(f.state().sessionId, 2)
  assert.equal(f.state().recording, true)
  assert.ok(firstAudio.stopped() > 0)
  assert.equal(secondAudio.stopped(), 0)
})

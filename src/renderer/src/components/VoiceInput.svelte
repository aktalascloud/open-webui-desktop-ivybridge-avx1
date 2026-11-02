<script lang="ts">
  import { onMount, onDestroy } from 'svelte'

  const api = window.voiceInputAPI

  let sessionId = 0
  let recording = $state(false)
  let transcribing = $state(false)
  let duration = $state(0)
  let errorMsg = $state('')

  // Waveform
  let levels: number[] = $state(Array(5).fill(0.15))
  let animFrame: number | null = null

  let timer: ReturnType<typeof setInterval> | null = null
  let errorTimer: ReturnType<typeof setTimeout> | null = null

  // Audio
  let mediaRecorder: MediaRecorder | null = null
  let audioChunks: Blob[] = []
  let mediaStream: MediaStream | null = null
  let analyser: AnalyserNode | null = null
  let audioCtx: AudioContext | null = null
  let dataArray: Uint8Array<ArrayBuffer> | null = null

  // Dragging
  let dragging = false
  let dragStart = { mx: 0, my: 0, wx: 0, wy: 0 }

  const formatDuration = (s: number): string => {
    const m = Math.floor(s / 60)
    return `${m}:${(s % 60).toString().padStart(2, '0')}`
  }

  const animateLevel = () => {
    if (analyser && dataArray) {
      analyser.getByteFrequencyData(dataArray)
      // Sample 5 frequency bands
      const bands = 5
      const step = Math.floor(dataArray.length / bands)
      levels = Array.from({ length: bands }, (_, i) => {
        const val = dataArray![i * step] / 255
        return Math.max(0.15, val)
      })
    } else {
      levels = levels.map(() => 0.15 + Math.random() * 0.6)
    }
    animFrame = requestAnimationFrame(animateLevel)
  }

  const showError = (msg: string, id = sessionId) => {
    if (id !== sessionId) return
    cleanup()
    errorMsg = msg
    if (errorTimer) clearTimeout(errorTimer)
    errorTimer = setTimeout(() => {
      if (id !== sessionId) return
      errorMsg = ''
      api?.close(id)
      sessionId = 0
    }, 3000)
  }

  const startRecording = async (id: number) => {
    cleanup()
    sessionId = id
    if (errorTimer) { clearTimeout(errorTimer); errorTimer = null }
    errorMsg = ''
    recording = true
    duration = 0
    const chunks: Blob[] = []
    audioChunks = chunks
    animateLevel()
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (id !== sessionId || !recording) return
    try {
      const permission = await api?.checkMicPermission()
      if (id !== sessionId || !recording) return
      if (permission === 'denied') throw new Error('Microphone access denied. Check system permissions.')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (id !== sessionId || !recording) { stream.getTracks().forEach(track => track.stop()); return }
      mediaStream = stream
      audioCtx = new AudioContext()
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 64
      dataArray = new Uint8Array(analyser.frequencyBinCount)
      audioCtx.createMediaStreamSource(stream).connect(analyser)
      const recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
      })
      mediaRecorder = recorder
      recorder.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data) }
      recorder.start(250)
      timer = setInterval(() => { if (id === sessionId) duration++ }, 1000)
    } catch (error: any) {
      if (id !== sessionId) return
      const message = error?.name === 'NotFoundError'
        ? 'No microphone found. Connect a microphone and try again.'
        : error?.message || 'Mic access failed'
      showError(message, id)
      api?.error(id, message)
    }
  }

  const cleanup = () => {
    recording = false
    transcribing = false
    if (timer) { clearInterval(timer); timer = null }
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null }
    levels = Array(5).fill(0.15)
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop()
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop())
      mediaStream = null
    }
    if (audioCtx) {
      audioCtx.close()
      audioCtx = null
      analyser = null
    }
    mediaRecorder = null
  }

  const cancelRecording = () => {
    const id = sessionId
    sessionId = 0
    cleanup()
    api?.close(id)
  }

  const stopRecording = async () => {
    const id = sessionId
    const recorder = mediaRecorder
    if (!recorder || recorder.state === 'inactive' || duration < 1) { cancelRecording(); return }
    const chunks = audioChunks
    const stream = mediaStream
    const context = audioCtx
    recording = false
    if (timer) { clearInterval(timer); timer = null }
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null }
    levels = Array(5).fill(0.15)
    const audioBlob = await new Promise<Blob>(resolve => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }))
      recorder.stop()
    })
    stream?.getTracks().forEach(track => track.stop())
    void context?.close()
    if (id !== sessionId) return
    if (mediaStream === stream) mediaStream = null
    if (audioCtx === context) { audioCtx = null; analyser = null }
    if (mediaRecorder === recorder) mediaRecorder = null
    if (audioBlob.size < 4096) { cancelRecording(); return }
    transcribing = true
    try {
      const buffer = await audioBlob.arrayBuffer()
      if (id !== sessionId) return
      const result = await api?.transcribe(id, buffer)
      if (id !== sessionId) return
      if (result?.text?.trim()) await api?.done(id)
      else await api?.close(id)
      if (id === sessionId) { sessionId = 0; cleanup() }
    } catch (error: any) {
      if (id !== sessionId) return
      const message = error?.message || 'Transcription failed'
      showError(message, id)
      api?.error(id, message)
    }
  }

  const onMouseDown = (e: MouseEvent) => {
    dragging = true
    dragStart = { mx: e.screenX, my: e.screenY, wx: window.screenX, wy: window.screenY }
  }

  const onMouseMove = (e: MouseEvent) => {
    if (!dragging) return
    window.moveTo(
      dragStart.wx + (e.screenX - dragStart.mx),
      dragStart.wy + (e.screenY - dragStart.my)
    )
  }

  const onMouseUp = () => { dragging = false }

  onMount(() => {
    api?.onRecordingState((data) => {
      if (data.recording && data.sessionId !== sessionId) void startRecording(data.sessionId)
      else if (!data.recording && data.sessionId === sessionId && recording) void stopRecording()
    })
  })

  onDestroy(() => {
    sessionId = 0
    cleanup()
    if (errorTimer) clearTimeout(errorTimer)
  })
</script>

<svelte:window
  onkeydown={(e) => { if (e.key === 'Escape') cancelRecording() }}
  onmousemove={onMouseMove}
  onmouseup={onMouseUp}
/>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="pill" onmousedown={onMouseDown}>
  {#if recording}
    <div class="bars">
      {#each levels as level}
        <div class="bar" style="height: {6 + level * 22}px"></div>
      {/each}
    </div>
    <span class="time">{formatDuration(duration)}</span>
  {:else if transcribing}
    <div class="loader"></div>
  {:else if errorMsg}
    <span class="err">{errorMsg}</span>
  {/if}
</div>

<style>
  @font-face {
    font-family: 'Archivo';
    src: url('../lib/assets/fonts/Archivo-Variable.ttf');
    font-display: swap;
  }
  :global(*) { margin: 0; padding: 0; box-sizing: border-box; }
  :global(html), :global(body), :global(#app) {
    height: 100%; width: 100%;
    background: transparent;
    overflow: hidden;
    user-select: none;
    -webkit-font-smoothing: antialiased;
  }

  .pill {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    display: inline-flex;
    align-items: center;
    gap: 12px;
    padding: 0 20px;
    height: 44px;
    border-radius: 22px;
    cursor: grab;
    font-family: 'Archivo', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    animation: appear 0.15s ease-out;

    background: rgba(30, 30, 30, 0.78);
    backdrop-filter: blur(40px) saturate(1.8);
    -webkit-backdrop-filter: blur(40px) saturate(1.8);
    border: 0.5px solid rgba(255, 255, 255, 0.12);
    box-shadow:
      0 2px 12px rgba(0, 0, 0, 0.35),
      inset 0 0.5px 0 rgba(255, 255, 255, 0.06);
  }

  .pill:active { cursor: grabbing; }

  @keyframes appear {
    from { opacity: 0; transform: translate(-50%, -50%) scale(0.92); }
    to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  }

  .bars {
    display: flex;
    align-items: center;
    gap: 3px;
    height: 28px;
  }

  .bar {
    width: 4px;
    border-radius: 99px;
    background: #fff;
    opacity: 0.9;
    transition: height 60ms ease-out;
    min-height: 6px;
  }

  .time {
    font-size: 14px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: rgba(255, 255, 255, 0.85);
    letter-spacing: 0.01em;
  }

  .loader {
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255, 255, 255, 0.15);
    border-top-color: rgba(255, 255, 255, 0.8);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .err {
    font-size: 12px;
    font-weight: 500;
    color: #ff6b6b;
  }
</style>

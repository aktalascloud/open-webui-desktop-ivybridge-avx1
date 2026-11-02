import { ipcRenderer, contextBridge } from 'electron'

export type VoiceInputAPI = typeof api

const api = {
  // Main process tells us to start/stop recording
  onRecordingState: (
    callback: (data: { recording: boolean; sessionId: number }) => void
  ): void => {
    ipcRenderer.on('voiceInput:state', (_event, data) => {
      callback(data)
    })
  },

  // Request microphone permission (macOS system-level)
  checkMicPermission: (): Promise<string> => {
    return ipcRenderer.invoke('voiceInput:micPermission')
  },

  // Send recorded audio to main process for transcription
  transcribe: (sessionId: number, audioBuffer: ArrayBuffer): Promise<any> => {
    return ipcRenderer.invoke('voiceInput:transcribe', sessionId, audioBuffer)
  },

  // Notify main process that transcription completed
  done: (sessionId: number): Promise<void> => {
    return ipcRenderer.invoke('voiceInput:done', sessionId)
  },

  // Close/hide the voice input window
  close: (sessionId: number): Promise<void> => {
    return ipcRenderer.invoke('voiceInput:close', sessionId)
  },

  // Report an error
  error: (sessionId: number, message: string): void => {
    ipcRenderer.invoke('voiceInput:error', sessionId, message)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('voiceInputAPI', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.voiceInputAPI = api
}

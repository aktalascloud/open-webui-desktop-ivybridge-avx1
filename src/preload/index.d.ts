import type { DesktopAPI } from './index'
import type { SpotlightAPI } from './spotlight-preload'
import type { VoiceInputAPI } from './voice-input-preload'

declare global {
  interface Window {
    electron: { process: { versions: NodeJS.ProcessVersions } }
    electronAPI: DesktopAPI
    spotlightAPI: SpotlightAPI
    voiceInputAPI: VoiceInputAPI
    api: unknown
  }
}

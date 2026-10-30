import type { WebPreferences } from 'electron'

/** Constrain remote guests to the shipped relay preload and Chromium sandbox. */
export function secureGuestWebPreferences(
  preferences: WebPreferences,
  source: string | undefined,
  contentPreload: string
): boolean {
  preferences.nodeIntegration = false
  preferences.nodeIntegrationInWorker = false
  preferences.nodeIntegrationInSubFrames = false
  preferences.contextIsolation = true
  preferences.sandbox = true
  preferences.webSecurity = true
  preferences.allowRunningInsecureContent = false
  preferences.preload = contentPreload
  try {
    const url = new URL(source ?? '')
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch {
    return false
  }
}

export function isConfiguredConnectionURL(value: string, connections: string[]): boolean {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true
    return connections.some((entry) => {
      try { return new URL(entry).origin === url.origin } catch { return false }
    })
  } catch { return false }
}

export function isConfiguredCertificateHost(hostname: string, connections: string[]): boolean {
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) return true
  return connections.some((entry) => {
    try {
      const url = new URL(entry)
      return url.protocol === 'https:' && !url.username && !url.password && url.hostname === hostname
    } catch { return false }
  })
}

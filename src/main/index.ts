// @ts-nocheck
import { VoiceInputSessions, isOwnedVoiceGuest, readOwnedVoiceToken, type VoiceTarget } from './voice-input-session'
import { secureGuestWebPreferences, isConfiguredConnectionURL, isConfiguredCertificateHost } from './guest-webview'

import {
  app,
  net,
  shell,
  session,
  webContents,
  systemPreferences,
  clipboard,
  nativeImage,
  nativeTheme,
  desktopCapturer,
  BrowserWindow,
  globalShortcut,
  Notification,
  Menu,
  ipcMain,
  Tray,
  dialog
} from 'electron'
import path, { join } from 'path'
import { pathToFileURL } from 'node:url'
import { readFile, statfs } from 'fs/promises'

import { electronApp, optimizer, is } from '@electron-toolkit/utils'

import {
  getLogFilePath,
  getConfig,
  getUserDataPath,
  getInstallDir,
  installPackage,
  installPython,
  isPackageInstalled,
  isPythonInstalled,
  getPackageVersion,
  uninstallPackage,
  isUvInstalled,
  openUrl,
  resetApp,
  setConfig,
  startServer,
  webuiService,
  uninstallPython,
  validateRemoteUrl,
  type Connection,
  type AppConfig
} from './utils'

import {
  setupLlamaCpp,
  startLlamaCpp,
  llamaService,
  stopLlamaCpp,
  getLlamaCppInfo,
  getLlamaCppAssetName,
  checkLlamaCppUpdate,
  updateLlamaCpp,
  uninstallLlamaCpp
} from './utils/llamacpp'

import {
  listModels,
  downloadModel,
  deleteModel,
  cancelDownload,
  getModelsDir,
  searchModels,
  getRepoFiles
} from './utils/huggingface'

import { startOpenTerminal, stopOpenTerminal, getOpenTerminalInfo, terminalService, updateOpenTerminal } from './utils/open-terminal'

import { attachTerminal } from './process/terminalChannel'

import { initUpdater, checkForUpdates, downloadUpdate, installUpdate, getUpdateState, setAutomaticUpdates } from './updater'

import log from 'electron-log'
import { nativeText, setNativeLanguage } from './native-i18n'
log.transports.file.resolvePathFn = () => getLogFilePath('main')

import icon from '../../resources/icon.png?asset'

import { existsSync, writeFileSync, unlinkSync } from 'fs'

if (process.platform === 'linux') {
  if (process.env.FLATPAK_ID) app.setDesktopName(`${process.env.FLATPAK_ID}.desktop`)
  // Work around /dev/shm access failures in AppImage and other containerised
  // environments.  AppImage's FUSE mount can restrict child-process access to
  // /dev/shm even when --no-sandbox is set, causing FATAL crashes in the
  // Chromium zygote/renderer with "Unable to access(W_OK|X_OK) /dev/shm".
  // This flag tells Chromium to use /tmp for shared memory instead (#136).
  app.commandLine.appendSwitch('disable-dev-shm-usage')

  // Use the native Wayland backend when available instead of XWayland.
  // This is required for xdg-desktop-portal features like GlobalShortcuts
  // to work (the portal is enabled by default in Chromium 134+ / Electron 33+).
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
}

// ─── GPU Crash Recovery ─────────────────────────────────
// When the GPU process crashes fatally (common on certain NVIDIA/Intel
// driver + Windows combos), we write a marker file and relaunch with
// --disable-gpu-sandbox so the user doesn't have to manually edit
// shortcut properties. On the next launch the marker is detected and
// the switch is applied preemptively.

// Retry Linux's default graphics after an Electron upgrade instead of keeping an old workaround forever.
const gpuCrashMarkerPath = join(
  app.getPath('userData'),
  process.platform === 'linux' ? `.gpu-sandbox-disabled-${process.versions.electron}` : '.gpu-sandbox-disabled'
)
const gpuSandboxDisabled = existsSync(gpuCrashMarkerPath) || app.commandLine.hasSwitch('disable-gpu-sandbox')

if (gpuSandboxDisabled) {
  log.info('GPU sandbox disabled due to previous GPU process crash')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  // Keep webview compositing available when falling back from a Linux GPU crash.
  if (process.platform === 'linux' && !app.commandLine.hasSwitch('use-angle')) {
    log.info('Using software rendering after a previous GPU process crash')
    app.commandLine.appendSwitch('use-gl', 'angle')
    app.commandLine.appendSwitch('use-angle', 'swiftshader')
  }
}

// Prevent Chromium from permanently blocking WebGL / 3-D APIs after
// repeated GPU process crashes within the same session.
app.disableDomainBlockingFor3DAPIs()

// ─── State ──────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null
let spotlightWindow: BrowserWindow | null = null
let voiceInputWindow: BrowserWindow | null = null
let voiceInputRecording = false
let tray: Tray | null = null
let isQuiting = false

let CONFIG: AppConfig | null = null

const voiceGuests = new Map<string, number>()
const nativeVoiceURL = () => is.dev && process.env['ELECTRON_RENDERER_URL']
  ? `${process.env['ELECTRON_RENDERER_URL']}/voice-input.html`
  : pathToFileURL(join(__dirname, '../renderer/voice-input.html')).href

async function currentVoiceTarget(): Promise<VoiceTarget> {
  const connection = await getDefaultConnection()
  const guestId = connection && voiceGuests.get(connection.id)
  if (!connection || guestId === undefined) {
    throw new Error('Open the selected connection and sign in before using voice input.')
  }
  return { connectionId: connection.id, url: resolveConnectionUrl(connection).replace(/\/+$/, ''), guestId }
}

const voiceSessions = new VoiceInputSessions(async (target) => {
  const current = await currentVoiceTarget()
  if (current.connectionId !== target.connectionId || current.url !== target.url || current.guestId !== target.guestId) {
    throw new Error('Voice input connection changed')
  }
  const token = await readOwnedVoiceToken(webContents.fromId(target.guestId) ?? undefined, target,
    mainWindow?.webContents, session.fromPartition(`persist:connection-${target.connectionId}`))
  const after = await currentVoiceTarget()
  if (after.connectionId !== target.connectionId || after.url !== target.url || after.guestId !== target.guestId) {
    throw new Error('Voice input connection changed')
  }
  return token
})

function requireVoiceCaller(event): void {
  if (!voiceInputWindow || event.sender !== voiceInputWindow.webContents ||
      event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== nativeVoiceURL()) {
    throw new Error('Invalid voice input caller')
  }
}

// ─── Global Shortcuts ───────────────────────────────────

/**
 * Try to register a single global shortcut.  Returns true on success.
 * On failure a user-facing notification is shown (unless `silent` is set).
 */
function tryRegisterShortcut(
  accel: string,
  label: string,
  callback: () => void,
  silent = false
): boolean {
  try {
    const ok = globalShortcut.register(accel, callback)
    if (ok) {
      log.info(`${label} shortcut "${accel}" registered`)
      return true
    }
    log.warn(`${label} shortcut "${accel}" could not be registered (returned false)`)
    if (!silent) {
      new Notification({
        title: nativeText(label),
        body: `${nativeText('Could not register shortcut')} \"${accel}\". ${nativeText('It may be in use by another application.')}`
      }).show()
    }
    return false
  } catch (error) {
    log.warn(`${label} shortcut "${accel}" registration threw:`, error)
    if (!silent) {
      new Notification({
        title: nativeText(label),
        body: `${nativeText('Failed to register shortcut')} \"${accel}\". ${nativeText('It may conflict with another application.')}`
      }).show()
    }
    return false
  }
}

const showMainWindow = (): void => {
  if (!mainWindow) {
    createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

const registerShortcuts = (globalAccel?: string, spotlightAccel?: string, voiceInputAccel?: string, callAccel?: string): void => {
  globalShortcut.unregisterAll()

  // Global shortcut – bring main window to foreground
  if (globalAccel) {
    tryRegisterShortcut(globalAccel, 'Open WebUI', showMainWindow)
  }

  // Spotlight shortcut – toggle the spotlight input bar
  if (spotlightAccel) {
    tryRegisterShortcut(spotlightAccel, 'Spotlight', () => {
      const text = CONFIG?.spotlightClipboardPaste !== false
        ? (clipboard.readText()?.trim() || '')
        : ''
      toggleSpotlight(text)
    })
  }

  // Voice input shortcut – toggle microphone recording
  if (voiceInputAccel && CONFIG?.voiceInputEnabled !== false) {
    tryRegisterShortcut(voiceInputAccel, 'Voice Input', () => {
      toggleVoiceInput()
    })
  } else {
    log.info(`Voice input shortcut skipped — accel="${voiceInputAccel}", enabled=${CONFIG?.voiceInputEnabled}`)
  }

  // Call shortcut – open the voice/video call overlay
  if (callAccel && CONFIG?.callEnabled !== false) {
    tryRegisterShortcut(callAccel, 'Call', () => {
      toggleCall()
    })
  } else {
    log.info(`Call shortcut skipped — accel="${callAccel}", enabled=${CONFIG?.callEnabled}`)
  }
}

// ─── Spotlight Window ───────────────────────────────────
// Bar position within the fullscreen window (persisted to config).
let spotlightBarOffset: { x: number; y: number } | null = null

function loadSpotlightPosition(): void {
  if (CONFIG?.spotlightPosition) {
    spotlightBarOffset = { ...CONFIG.spotlightPosition }
  }
}

function createSpotlightWindow(): BrowserWindow {
  const { screen } = require('electron')
  const cursorPoint = screen.getCursorScreenPoint()
  const activeDisplay = screen.getDisplayNearestPoint(cursorPoint)
  const { x: sx, y: sy, width: sw, height: sh } = activeDisplay.bounds

  spotlightWindow = new BrowserWindow({
    x: sx,
    y: sy,
    width: sw,
    height: sh,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    focusable: true,
    // Ensure the window appears on whichever Space/desktop the user is
    // currently on, rather than pulling them back to the primary Space.
    visibleOnAllWorkspaces: true,
    icon: path.join(__dirname, 'assets/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/spotlight-preload.js'),
      sandbox: false,
      webviewTag: false
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    spotlightWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/spotlight.html`)
  } else {
    spotlightWindow.loadFile(join(__dirname, '../renderer/spotlight.html'))
  }

  // Hide on blur — but only when the window was truly visible and settled.
  let blurArmed = false
  spotlightWindow.on('focus', () => {
    blurArmed = false
    setTimeout(() => {
      blurArmed = true
    }, 200)
  })
  spotlightWindow.on('blur', () => {
    if (blurArmed) {
      spotlightWindow?.hide()
    }
  })

  spotlightWindow.on('closed', () => {
    spotlightWindow = null
  })

  return spotlightWindow
}

function showAndFocusSpotlight(win: BrowserWindow, initialQuery?: string): void {
  // On macOS, avoid `app.focus({ steal: true })` — it activates the whole
  // application and causes the window manager to switch back to whichever
  // Space the app was originally launched on (#179).  Instead, ensure the
  // window is visible on all workspaces and focus it directly.
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true })
  }

  // Reposition fullscreen window to the active display
  const { screen } = require('electron')
  const cursorPoint = screen.getCursorScreenPoint()
  const activeDisplay = screen.getDisplayNearestPoint(cursorPoint)
  const { x: sx, y: sy, width: sw, height: sh } = activeDisplay.bounds
  win.setBounds({ x: sx, y: sy, width: sw, height: sh })

  // Hide main window so it doesn't appear behind the transparent overlay
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.hide()
  }

  win.show()
  win.focus()
  win.webContents.focus()

  // Send initial data to the renderer (bar offset + optional query)
  win.webContents.send('spotlight:init', {
    barOffset: spotlightBarOffset,
    screenSize: { width: sw, height: sh },
    query: initialQuery || ''
  })
}

function toggleSpotlight(selectedText?: string): void {
  if (spotlightWindow && !spotlightWindow.isDestroyed()) {
    if (spotlightWindow.isVisible()) {
      spotlightWindow.hide()
    } else {
      showAndFocusSpotlight(spotlightWindow, selectedText)
    }
  } else {
    const win = createSpotlightWindow()
    win.once('ready-to-show', () => {
      showAndFocusSpotlight(win, selectedText)
    })
  }
}

// ─── Voice Input Window ─────────────────────────────────

function createVoiceInputWindow(): BrowserWindow {
  const { screen } = require('electron')
  const cursorPoint = screen.getCursorScreenPoint()
  const activeDisplay = screen.getDisplayNearestPoint(cursorPoint)
  const { x: sx, y: sy, width: sw } = activeDisplay.bounds

  const winW = 340
  const winH = 72

  voiceInputWindow = new BrowserWindow({
    x: sx + Math.round((sw - winW) / 2),
    y: sy + 120,
    width: winW,
    height: winH,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    focusable: true,
    icon: path.join(__dirname, 'assets/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/voice-input-preload.js'),
      partition: 'voice-input',
      sandbox: false,
      webviewTag: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  // Keep voice permission isolated from saved WebUI browser sessions.
  const voiceInputURL = nativeVoiceURL()
  voiceInputWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(webContents === voiceInputWindow?.webContents && permission === 'media' &&
        details.isMainFrame && details.requestingUrl === voiceInputURL &&
        'mediaTypes' in details && Array.isArray(details.mediaTypes) &&
        details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio'))
    }
  )

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    voiceInputWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/voice-input.html`)
  } else {
    voiceInputWindow.loadFile(join(__dirname, '../renderer/voice-input.html'))
  }

  voiceInputWindow.on('closed', () => {
    voiceInputWindow = null
    voiceInputRecording = false
  })

  return voiceInputWindow
}

function playChime(ascending: boolean): Promise<void> {
  return new Promise((resolve) => {
    const { execFile } = require('child_process')
    const fs = require('fs')
    const file = ascending ? 'chime-start.wav' : 'chime-stop.wav'
    const soundPath = app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'sounds', file)
      : join(app.getAppPath(), 'resources', 'sounds', file)

    const exists = fs.existsSync(soundPath)
    log.info(`playChime: ${ascending ? 'start' : 'stop'}, path=${soundPath}, exists=${exists}`)

    if (!exists) { resolve(); return }

    if (process.platform === 'darwin') {
      execFile('afplay', [soundPath], (err, stdout, stderr) => {
        if (err) log.warn('afplay error:', err.message, stderr)
        resolve()
      })
    } else if (process.platform === 'win32') {
      execFile('powershell', ['-NoProfile', '-Command',
        `(New-Object Media.SoundPlayer '${soundPath}').PlaySync()`
      ], () => resolve())
    } else {
      execFile('paplay', [soundPath], (err) => {
        if (err) execFile('aplay', [soundPath], () => resolve())
        else resolve()
      })
    }
  })
}

async function toggleVoiceInput(): Promise<void> {
  if (voiceInputRecording) {
    // Stop recording — chime plays in done/close handler after mic is released
    voiceInputRecording = false
    if (voiceInputWindow && !voiceInputWindow.isDestroyed()) {
      voiceInputWindow.webContents.send('voiceInput:state', { recording: false, sessionId: voiceSessions.id })
    }
    return
  }

  // Pre-flight: check microphone permission on macOS
  if (process.platform === 'darwin') {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone')
    if (micStatus !== 'granted') {
      const granted = await systemPreferences.askForMediaAccess('microphone')
      if (!granted) {
        log.warn('Voice input: microphone permission denied')
        new Notification({
          title: nativeText('Voice Input'),
          body: nativeText('Microphone access denied. Enable it in System Settings → Privacy & Security → Microphone, then restart the app.')
        }).show()
        return
      }
    }
  }

  let sessionId: number
  try {
    sessionId = await voiceSessions.begin(await currentVoiceTarget())
  } catch (error) {
    log.warn('Voice input preflight failed:', error instanceof Error ? error.message : 'unavailable')
    new Notification({ title: nativeText('Voice Input'), body: nativeText(error instanceof Error ? error.message : 'Voice input unavailable') }).show()
    return
  }

  // Start recording — chime plays concurrently (separate audio output path from mic input)
  voiceInputRecording = true
  playChime(true)

  if (voiceInputWindow && !voiceInputWindow.isDestroyed()) {
    voiceInputWindow.show()
    voiceInputWindow.focus()
    voiceInputWindow.webContents.send('voiceInput:state', { recording: true, sessionId })
  } else {
    const win = createVoiceInputWindow()
    win.once('ready-to-show', () => {
      if (voiceSessions.id !== sessionId) return
      win.show()
      win.focus()
      setTimeout(() => {
        if (voiceSessions.id === sessionId && !win.isDestroyed()) win.webContents.send('voiceInput:state', { recording: true, sessionId })
      }, 100)
    })
  }
}

// ─── Call Shortcut ──────────────────────────────────────

async function toggleCall(): Promise<void> {
  // Pre-flight: check a connection is configured
  try {
    const conn = await getDefaultConnection()
    if (!conn) {
      log.warn('Call: no connection configured')
      new Notification({
        title: nativeText('Call'),
        body: nativeText('No connection configured. Set up a connection in Settings before using the call shortcut.')
      }).show()
      return
    }

    const url = resolveConnectionUrl(conn)
    sendToRenderer('call', { connectionId: conn.id, url })

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  } catch (err: any) {
    log.warn('Call: config check failed:', err)
  }
}

// ─── Windows ────────────────────────────────────────────

const DEFAULT_WINDOW_WIDTH = 1280
const DEFAULT_WINDOW_HEIGHT = 800
const MIN_WINDOW_WIDTH = 360
const MIN_WINDOW_HEIGHT = 360
const BOUNDS_SAVE_DEBOUNCE_MS = 500
const MIN_VISIBLE_OVERLAP_PX = 100

/** Last known non-maximized bounds, used to preserve restore geometry. */
let lastNormalBounds: Electron.Rectangle | null = null

/** Debounced persistence of the current window geometry to config. */
let boundsDebounceTimer: ReturnType<typeof setTimeout> | null = null

function debounceSaveWindowBounds(win: BrowserWindow): void {
  if (boundsDebounceTimer) clearTimeout(boundsDebounceTimer)
  boundsDebounceTimer = setTimeout(() => {
    if (win.isDestroyed()) return
    const maximized = win.isMaximized()
    const bounds = maximized ? (lastNormalBounds ?? win.getNormalBounds()) : win.getBounds()
    setConfig({ windowBounds: bounds, windowMaximized: maximized }).catch((err) =>
      log.warn('Failed to save window bounds:', err)
    )
  }, BOUNDS_SAVE_DEBOUNCE_MS)
}

/**
 * Returns true when at least `MIN_VISIBLE_OVERLAP_PX` of the saved
 * rectangle would be visible on one of the connected displays.
 */
function isBoundsOnVisibleDisplay(bounds: { x: number; y: number }): boolean {
  const { screen } = require('electron')
  const targetPoint = { x: bounds.x + MIN_VISIBLE_OVERLAP_PX / 2, y: bounds.y + MIN_VISIBLE_OVERLAP_PX / 2 }
  const display = screen.getDisplayNearestPoint(targetPoint)
  const { x, y, width, height } = display.workArea
  return (
    bounds.x + MIN_VISIBLE_OVERLAP_PX > x &&
    bounds.x < x + width &&
    bounds.y + MIN_VISIBLE_OVERLAP_PX > y &&
    bounds.y < y + height
  )
}

function trackNormalBounds(win: BrowserWindow): void {
  if (!win.isDestroyed() && !win.isMaximized()) {
    lastNormalBounds = win.getBounds()
  }
}

function createMainWindow(show = true): void {
  const saved = CONFIG?.windowBounds
  const windowOpts: Electron.BrowserWindowConstructorOptions = {
    width: saved?.width ?? DEFAULT_WINDOW_WIDTH,
    height: saved?.height ?? DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    icon: path.join(__dirname, 'assets/icon.png'),
    show: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 10, y: 10 },
    autoHideMenuBar: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    ...(process.platform === 'linux' ? { icon } : {}),
    ...(process.platform !== 'darwin'
      ? { titleBarOverlay: {
          height: 32,
          color: '#00000000',
          symbolColor: (CONFIG?.theme === 'dark' ||
            (CONFIG?.theme !== 'light' && nativeTheme.shouldUseDarkColors)) ? '#ffffff' : '#000000'
        } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
    }
  }

  // Restore position only when the saved location is still on a visible display
  // (e.g. an external monitor may have been disconnected since last session).
  if (saved?.x != null && saved?.y != null && isBoundsOnVisibleDisplay(saved)) {
    windowOpts.x = saved.x
    windowOpts.y = saved.y
  }

  mainWindow = new BrowserWindow(windowOpts)
  mainWindow.setIcon(icon)

  if (CONFIG?.windowMaximized) {
    // Maximizing also shows the window; wait until it is opened from the tray.
    mainWindow.once('show', () => mainWindow?.maximize())
  }

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools()
  }

  if (show) {
    mainWindow.on('ready-to-show', () => {
      mainWindow?.show()
    })
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    openUrl(details.url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openUrl(url)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // ── Persist window bounds on geometry changes ──
  const onBoundsChanged = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    trackNormalBounds(mainWindow)
    debounceSaveWindowBounds(mainWindow)
  }
  mainWindow.on('resize', onBoundsChanged)
  mainWindow.on('move', onBoundsChanged)
  mainWindow.on('maximize', onBoundsChanged)
  mainWindow.on('unmaximize', onBoundsChanged)

  mainWindow.on('close', (event) => {
    if (!isQuiting) {
      if (CONFIG?.runInBackground === false) {
        isQuiting = true
        app.quit()
      } else {
        event.preventDefault()
        mainWindow?.hide()
      }
    }
  })
}

// ─── Tray ───────────────────────────────────────────────

const updateTray = () => {
  setNativeLanguage(CONFIG?.language)
  if (!CONFIG) return
  if (process.platform === 'darwin' && CONFIG.showMenuBarIcon === false) {
    tray?.destroy(); tray = null; return
  }
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
    tray.setToolTip('Open WebUI Desktop')
    if (process.platform === 'linux') tray.on('click', showMainWindow)
  }

  // Remote connections from config
  const remoteItems = (CONFIG.connections || []).map((conn) => ({
    label: `${conn.id === CONFIG.defaultConnectionId ? '★ ' : ''}${conn.name}`,
    sublabel: conn.url,
    click: async () => {
      const result = await connectTo(conn)
      if (result) sendToRenderer('connection:open', result)
    }
  }))

  // Virtual local connection (when package is installed)
  const localItem = isPackageInstalled('open-webui')
    ? [{
        label: `${CONFIG.defaultConnectionId === 'local' ? '★ ' : ''}${nativeText('Open WebUI (Local)')}`,
        sublabel: webuiService.info.url || `http://127.0.0.1:${CONFIG.localServer?.port ?? 8080}`,
        click: async () => {
          const result = await connectTo(buildLocalConnection())
          if (result) sendToRenderer('connection:open', result)
        }
      }]
    : []

  const allItems = [...localItem, ...remoteItems]

  const trayMenuTemplate = [
    {
      label: nativeText('Show Open WebUI'),
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      }
    },
    { label: nativeText('Open in Browser'), enabled: webuiService.info.reachable,
      click: () => { if (webuiService.info.url) openUrl(webuiService.info.url) } },
    { type: 'separator' },
    ...(allItems.length > 0
      ? [
          { label: nativeText('Connections'), enabled: false },
          ...allItems,
          { type: 'separator' }
        ]
      : []),
    ...(webuiService.info.status === 'started' && webuiService.info.url
      ? [
          {
            label: `${nativeText('Local')}: ${webuiService.info.url}`,
            click: () => {
              if (webuiService.info.url) clipboard.writeText(webuiService.info.url)
            }
          },
          { type: 'separator' }
        ]
      : []),
    {
      label: nativeText('Quit Open WebUI'),
      accelerator: 'CommandOrControl+Q',
      click: () => {
        isQuiting = true
        app.quit()
      }
    }
  ]

  const trayMenu = Menu.buildFromTemplate(trayMenuTemplate)
  tray?.setContextMenu(trayMenu)
}

const buildLocalConnection = (): Connection => {
  const port = CONFIG?.localServer?.port ?? 8080
  return {
    id: 'local',
    name: 'Open WebUI',
    type: 'local',
    url: webuiService.info.url || `http://127.0.0.1:${port}`
  }
}

// Resolve the default connection.  'local' is a virtual ID that
// synthesises a Connection on the fly; everything else is looked
// up in the persisted connections array (remote only).
const getDefaultConnection = async (): Promise<Connection | null> => {
  const config = await getConfig()
  if (!config.defaultConnectionId) return null
  if (config.defaultConnectionId === 'local') return buildLocalConnection()
  return config.connections.find((c) => c.id === config.defaultConnectionId) ?? null
}

// Resolve the URL for a connection, preferring the live webuiService.info.url
// for local connections and normalising 0.0.0.0 to localhost.
const resolveConnectionUrl = (conn: Connection): string => {
  let url = conn.url
  if (conn.type === 'local' && webuiService.info.url) url = webuiService.info.url
  if (url.startsWith('http://0.0.0.0')) url = url.replace('http://0.0.0.0', 'http://localhost')
  return url
}

const connectTo = async (connection: Connection) => {
  let url = connection.url

  if (connection.type === 'local') {
    // Start local server if needed
    if (webuiService.info.status !== 'started') {
      const started = await startServerHandler()
      if (!started) return null
    }
    url = webuiService.info.url || connection.url


  }

  // Normalize URL
  if (url.startsWith('http://0.0.0.0')) {
    url = url.replace('http://0.0.0.0', 'http://localhost')
  }

  return { url, connectionId: connection.id }
}

// Open the configured local backend after readiness succeeds.
const openLocalWebUI = async () => {
  if (!isPackageInstalled('open-webui')) return null
  if (!await startServerHandler()) return null
  return { url: webuiService.info.url }
}

// ─── Server Lifecycle ───────────────────────────────────

webuiService.subscribe((event) => {
  if (event.type !== 'state') return
  sendToRenderer('server:info', event.info)
  sendToRenderer('status:server', event.info.status)
  if (event.info.reachable) sendToRenderer('server:ready', { url: event.info.url })
  updateTray()
})

let registeredLlamaUrl: string | null = null
llamaService.subscribe((event) => {
  if (event.type !== 'state') return
  const info = event.info
  sendToRenderer('llamacpp:info', getLlamaCppInfo())
  sendToRenderer('status:llamacpp', info.status)
  const nextUrl = info.reachable ? info.url : null
  if (registeredLlamaUrl !== nextUrl) {
    if (registeredLlamaUrl) sendToRenderer('connections:openai', { action: 'remove', url: `${registeredLlamaUrl}/v1` })
    if (nextUrl) sendToRenderer('connections:openai', {
      action: 'add', url: `${nextUrl}/v1`, config: { provider: 'llama.cpp', connection_type: 'local' }
    })
    registeredLlamaUrl = nextUrl
    sendToRenderer('models:refresh')
  }
  if (info.reachable) sendToRenderer('llamacpp:ready', info)
})

let registeredTerminalUrl: string | null = null
terminalService.subscribe(event => {
  if (event.type !== 'state' || isQuiting) return
  const info = getOpenTerminalInfo()
  sendToRenderer('open-terminal:info', info)
  sendToRenderer('status:open-terminal', info.status)
  const nextUrl = info.reachable ? info.url : null
  if (registeredTerminalUrl !== nextUrl) {
    if (registeredTerminalUrl) sendToRenderer('connections:terminal', { action: 'remove', url: registeredTerminalUrl })
    if (nextUrl && info.apiKey) sendToRenderer('connections:terminal', { action: 'add', url: nextUrl, key: info.apiKey })
    registeredTerminalUrl = nextUrl
  }
  if (info.reachable) sendToRenderer('open-terminal:ready', info)
})

const startServerHandler = async (): Promise<boolean> => {
  if (isQuiting) return false
  try {
    await startServer((status) => sendToRenderer('status:install', status))
    return true
  } catch (error) {
    if (webuiService.info.status === 'failed') {
      log.error('Failed to start server:', error)
      sendToRenderer('error', { message: `Failed to start server: ${error?.message}` })
    }
    return false
  }
}

const stopServerHandler = async (): Promise<boolean> => {
  try {
    await webuiService.stop()
    return true
  } catch (error) {
    log.error('Failed to stop server:', error)
    return false
  }
}

const resetAppHandler = async () => {
  try {
    await webuiService.stop()
    // Stop and uninstall llama.cpp if running
    try {
      await uninstallLlamaCpp()
      sendToRenderer('status:llamacpp', null)
    } catch (e) {
      log.warn('Failed to uninstall llama.cpp during reset:', e)
    }
    // Remove GPU crash marker so sandbox is re-tested on next launch
    try {
      if (existsSync(gpuCrashMarkerPath)) {
        unlinkSync(gpuCrashMarkerPath)
        log.info('GPU crash marker removed during reset')
      }
    } catch (e) {
      log.warn('Failed to remove GPU crash marker during reset:', e)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await resetApp()
    CONFIG = await getConfig() // reload from defaults since config.json was deleted
    setAutomaticUpdates(CONFIG.automaticUpdates)
    new Notification({ title: nativeText('Open WebUI'), body: nativeText('Application has been reset.') }).show()
  } catch (error) {
    log.error('Failed to reset:', error)
    new Notification({ title: nativeText('Open WebUI'), body: nativeText(`Reset failed: ${error.message}`) }).show()
  }
}

// ─── Helpers ────────────────────────────────────────────

const sendToRenderer = (type: string, data?: any) => {
  if (type === 'status:install' && typeof data === 'string') data = nativeText(data)
  if (type === 'error' && data?.message) data = { ...data, message: nativeText(data.message) }
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('main:data', { type, data })
  }
}

// ─── App Lifecycle ──────────────────────────────────────

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.setAboutPanelOptions({
    applicationName: 'Open WebUI',
    iconPath: icon,
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    website: 'https://openwebui.com',
    copyright: `© ${new Date().getFullYear()} Open WebUI`
  })

  app.whenReady().then(async () => {
    CONFIG = await getConfig()
    loadSpotlightPosition()
    log.info('Config loaded')

    app.name = 'Open WebUI'
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(icon)
    }
    electronApp.setAppUserModelId('com.openwebui.desktop')

    // ─── GPU Process Crash Recovery ──────────────────
    // If the GPU process exits fatally (e.g. sandbox init failure on
    // certain NVIDIA/Intel drivers), write a marker and relaunch with
    // the saved GPU workaround (software rendering on Linux) so the user
    // doesn't have to manually edit shortcut targets (see issue #110).
    app.on('child-process-gone', (_event, details) => {
      if (details.type === 'GPU') {
        log.error(
          `GPU process gone: reason=${details.reason}, exitCode=${details.exitCode}`
        )

        // Only auto-recover from fatal crashes, not normal/clean exits
        if (
          details.reason === 'crashed' ||
          details.reason === 'launch-failed' ||
          details.reason === 'abnormal-exit'
        ) {
          if (!gpuSandboxDisabled) {
            log.info('Writing GPU crash marker and relaunching with --disable-gpu-sandbox')
            try {
              writeFileSync(gpuCrashMarkerPath, new Date().toISOString(), 'utf-8')
            } catch (e) {
              log.warn('Failed to write GPU crash marker:', e)
            }
            app.relaunch({ args: [...process.argv.slice(1), '--disable-gpu-sandbox'] })
            app.exit(0)
          }
        }
      }
    })

    // If we previously set the GPU sandbox marker and this session
    // started successfully, log it so it's visible in diagnostics.
    if (gpuSandboxDisabled) {
      log.info('Running with GPU sandbox disabled (marker file present)')
    }

    // TLS exceptions are confined to saved user connections and loopback.
    const connectionURLs = () => (CONFIG?.connections ?? []).map((connection) => connection.url).filter((url) => typeof url === 'string')
    app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
      event.preventDefault()
      callback(isConfiguredConnectionURL(url, connectionURLs()))
    })
    const certificatePolicy = (request, callback) => {
      callback(isConfiguredCertificateHost(request.hostname, connectionURLs()) ? 0 : -3)
    }
    session.defaultSession.setCertificateVerifyProc(certificatePolicy)
    app.on('session-created', (newSession) => {
      newSession.setCertificateVerifyProc(certificatePolicy)

      // Grant media / notification permissions for webview partition sessions
      // so that auth flows, media capture, and notifications work correctly.
      newSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        if (!isConfiguredConnectionURL(details.requestingUrl, connectionURLs()) ||
            !isConfiguredConnectionURL(webContents?.getURL() ?? '', connectionURLs())) {
          callback(false)
          return
        }
        if (permission === 'fileSystem') {
          callback(isConfiguredConnectionURL(webContents?.getURL() ?? '', connectionURLs()) &&
            'fileAccessType' in details && details.fileAccessType === 'readable')
          return
        }
        const allowed = ['media', 'display-capture', 'mediaKeySystem', 'notifications', 'clipboard-read', 'clipboard-sanitized-write']
        callback(allowed.includes(permission) && isConfiguredConnectionURL(webContents?.getURL() ?? '', connectionURLs()))
      })

      newSession.setDisplayMediaRequestHandler(
        (request, callback) => {
          const permitted = () => request.frame &&
            isConfiguredConnectionURL(request.securityOrigin, connectionURLs()) &&
            new URL(request.frame.url).origin === request.securityOrigin
          try {
            if (!permitted()) { callback({}); return }
          } catch { callback({}); return }
          desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
            try {
              callback(permitted() && sources[0] ? { video: sources[0], audio: 'loopback' } : {})
            } catch { callback({}) }
          }, () => callback({}))
        },
        { useSystemPicker: true }
      )
    })

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)

      // Auto-reload when the renderer process dies so the user doesn't
      // see a permanent blank/grey screen.
      window.webContents.on('render-process-gone', (_event, details) => {
        log.error(
          `Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`
        )
        if (details.reason !== 'clean-exit') {
          window.webContents.reload()
        }
      })
    })

    // Log webview guest renderer crashes for diagnostics — the existing
    // 'crashed' listener in Content.svelte surfaces these to the user.
    app.on('web-contents-created', (_event, contents) => {
      contents.on('will-attach-webview', (event, preferences, params) => {
        if (!secureGuestWebPreferences(preferences, params.src, join(__dirname, '../preload/content-preload.js'))) event.preventDefault()
      })
      contents.on('render-process-gone', (_e, details) => {
        if (details.reason !== 'clean-exit') {
          log.error(
            `WebContents render-process-gone: type=${contents.getType()}, ` +
            `reason=${details.reason}, exitCode=${details.exitCode}`
          )
        }
      })

      if (contents.getType() === 'webview') {
        // Keep OAuth navigation and popups in their session; ordinary tabs open externally.
        contents.setWindowOpenHandler(({ url, disposition, features }) => {
          const isWebUrl = /^https?:\/\//i.test(url)
          // Shift-clicking a link also requests a new window, but has no popup features.
          if (disposition === 'new-window' && features && (isWebUrl || url === 'about:blank')) {
            return {
              action: 'allow',
              overrideBrowserWindowOptions: {
                webPreferences: {
                  session: contents.session,
                  nodeIntegration: false,
                  contextIsolation: true,
                  sandbox: true,
                  webviewTag: false
                }
              }
            }
          }
          if (isWebUrl) openUrl(url)
          return { action: 'deny' }
        })

        // ── Native right-click context menu (#161) ──────────────────
        // Electron <webview> guests don't show a context menu by default,
        // which blocks right-click → Paste / Autofill / password-manager
        // integration on login pages.  Build a native menu with standard
        // editing actions, spell-check suggestions, and link/image handling.
        contents.on('context-menu', (_event, params) => {
          const menuItems: Electron.MenuItemConstructorOptions[] = []

          // Spell-check suggestions (if any)
          if (params.misspelledWord && params.dictionarySuggestions?.length) {
            for (const suggestion of params.dictionarySuggestions) {
              menuItems.push({
                label: suggestion,
                click: () => contents.replaceMisspelling(suggestion)
              })
            }
            menuItems.push({ type: 'separator' })
          }

          // Link handling
          if (params.linkURL) {
            menuItems.push({
              label: nativeText('Open Link in Browser'),
              click: () => openUrl(params.linkURL)
            })
            menuItems.push({
              label: nativeText('Copy Link'),
              click: () => clipboard.writeText(params.linkURL)
            })
            menuItems.push({ type: 'separator' })
          }

          // Editable field actions (input, textarea, contenteditable)
          if (params.isEditable) {
            menuItems.push(
              { label: nativeText('Undo'), role: 'undo', enabled: params.editFlags.canUndo },
              { label: nativeText('Redo'), role: 'redo', enabled: params.editFlags.canRedo },
              { type: 'separator' },
              { label: nativeText('Cut'), role: 'cut', enabled: params.editFlags.canCut },
              { label: nativeText('Copy'), role: 'copy', enabled: params.editFlags.canCopy },
              { label: nativeText('Paste'), role: 'paste', enabled: params.editFlags.canPaste },
              { label: nativeText('Select All'), role: 'selectAll', enabled: params.editFlags.canSelectAll }
            )
          } else if (params.selectionText) {
            // Non-editable text selection
            menuItems.push(
              { label: nativeText('Copy'), role: 'copy', enabled: params.editFlags.canCopy }
            )
          }

          if (params.mediaType === 'image') {
            if (menuItems.length > 0 && menuItems[menuItems.length - 1].type !== 'separator') {
              menuItems.push({ type: 'separator' })
            }
            menuItems.push(
              {
                label: 'Copy Image',
                enabled: params.hasImageContents,
                click: () => contents.copyImageAt(params.x, params.y)
              },
              {
                label: 'Save Image As…',
                enabled: !!params.srcURL,
                click: () => contents.downloadURL(params.srcURL)
              }
            )
          }

          if (menuItems.length > 0) {
            Menu.buildFromTemplate(menuItems).popup()
          }
        })
      }
    })

    // ─── IPC Handlers ─────────────────────────────────

    ipcMain.handle('get:version', () => app.getVersion())

    ipcMain.handle('app:info', () => ({
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      username: require('os').userInfo().username,
      gpuSandboxDisabled
    }))

    ipcMain.handle('window:isFocused', () => ({ isFocused: mainWindow?.isFocused() ?? false }))
    ipcMain.handle('app:contentPreloadPath', () => {
      return `file://${join(__dirname, '../preload/content-preload.js')}`
    })

    ipcMain.handle('app:defaultDataPath', () => {
      return join(getUserDataPath(), 'data')
    })

    ipcMain.handle('app:installDir', () => {
      return getInstallDir()
    })

    ipcMain.handle('system:diskSpace', async () => {
      try {
        const stats = await statfs(getUserDataPath())
        return { free: stats.bavail * stats.bsize }
      } catch (error) {
        log.error('Failed to check disk space:', error)
        return { free: -1 }
      }
    })

    ipcMain.handle('get:config', () => getConfig())
    ipcMain.on('window:theme', (event, dark) => {
      if (process.platform === 'darwin' || !mainWindow || mainWindow.isDestroyed()) return
      if (event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) return
      if (typeof dark !== 'boolean') return
      mainWindow.setTitleBarOverlay({ symbolColor: dark ? '#ffffff' : '#000000' })
    })
    ipcMain.handle('set:config', async (_event, config) => {
      if ('automaticUpdates' in config && typeof config.automaticUpdates !== 'boolean') {
        throw new Error('automaticUpdates must be a boolean')
      }
      await setConfig(config)
      CONFIG = await getConfig()
      updateTray()
      setAutomaticUpdates(CONFIG.automaticUpdates)
      registerShortcuts(CONFIG.globalShortcut, CONFIG.spotlightShortcut, CONFIG.voiceInputShortcut, CONFIG.callShortcut)
    })

    // Python/uv
    ipcMain.handle('install:python', async () => {
      try {
        sendToRenderer('status:install', 'Downloading Python…')
        const res = await installPython(undefined, (status: string) => {
          sendToRenderer('status:install', status)
        })
        sendToRenderer('status:python', res)
        return res
      } catch (error) {
        sendToRenderer('status:python', false)
        sendToRenderer('error', { message: error?.message ?? 'Python installation failed. Please check your internet connection and try again.' })
        return false
      }
    })

    ipcMain.handle('status:python', async () => {
      return (await isPythonInstalled()) && (await isUvInstalled())
    })

    // Package
    ipcMain.handle('install:package', async () => {
      try {
        CONFIG = await getConfig()
        const owuiVersion = CONFIG?.localServer?.version || undefined

        await webuiService.stop()
        sendToRenderer('status:install', 'Installing Open WebUI…')
        await installPackage('open-webui', owuiVersion, (status: string) => {
          sendToRenderer('status:install', status)
        })
        sendToRenderer('status:package', true)
        // Notify renderer of install state change
        sendToRenderer('packages:changed', {
          'open-webui': isPackageInstalled('open-webui')
        })
        updateTray()
        return true
      } catch (error) {
        sendToRenderer('status:package', false)
        sendToRenderer('error', { message: error?.message ?? 'Package installation failed. Please check your internet connection and try again.' })
        return false
      }
    })

    ipcMain.handle('status:package', async () => isPackageInstalled('open-webui'))

    // Server
    ipcMain.handle('server:start', () => startServerHandler())
    ipcMain.handle('server:stop', () => stopServerHandler())
    ipcMain.handle('server:restart', async () => {
      if (!(await stopServerHandler())) return false
      return startServerHandler()
    })
    ipcMain.handle('server:logs', () => [webuiService.logs])
    ipcMain.handle('server:logs:clear', () => webuiService.clearLogs())
    ipcMain.handle('server:info', () => webuiService.info)

    ipcMain.on('terminal:connect', (event, serviceId: string, connectionId: number) => {
      if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) return
      const service = serviceId === 'server' ? webuiService : serviceId === 'llamacpp' ? llamaService : serviceId === 'open-terminal' ? terminalService : null
      if (!service || !Number.isSafeInteger(connectionId)) return
      attachTerminal(service, event.sender, connectionId)
    })

    ipcMain.handle('server:open', () => openLocalWebUI())

    // Connections (remote only — local is virtual)
    ipcMain.handle('connections:list', async () => {
      const config = await getConfig()
      return config.connections
    })

    ipcMain.handle('connections:add', async (_event, connection: Connection) => {
      const config = await getConfig()
      config.connections.push(connection)
      if (!config.defaultConnectionId) {
        config.defaultConnectionId = connection.id
      }
      await setConfig(config)
      CONFIG = config
      updateTray()
      sendToRenderer('connections:changed', config.connections)
      return config.connections
    })

    ipcMain.handle('connections:remove', async (_event, id: string) => {
      const config = await getConfig()
      config.connections = config.connections.filter((c) => c.id !== id)
      if (config.defaultConnectionId === id) {
        config.defaultConnectionId = config.connections[0]?.id || 'local'
      }
      await setConfig(config)
      CONFIG = config
      updateTray()
      sendToRenderer('connections:changed', config.connections)
      return config.connections
    })

    ipcMain.handle('connections:update', async (_event, id: string, updates: Partial<Connection>) => {
      const config = await getConfig()
      const idx = config.connections.findIndex((c) => c.id === id)
      if (idx !== -1) {
        config.connections[idx] = { ...config.connections[idx], ...updates }
        await setConfig(config)
        CONFIG = config
        updateTray()
        sendToRenderer('connections:changed', config.connections)
      }
      return config.connections
    })

    ipcMain.handle('connections:setDefault', async (_event, id: string) => {
      const config = await getConfig()
      config.defaultConnectionId = id
      await setConfig(config)
      CONFIG = config
      updateTray()
    })

    ipcMain.handle('connections:connect', async (_event, id: string) => {
      // 'local' is a virtual connection — synthesize it
      if (id === 'local') {
        return await connectTo(buildLocalConnection())
      }
      const config = await getConfig()
      const conn = config.connections.find((c) => c.id === id)
      if (conn) {
        return await connectTo(conn)
      }
      return null
    })

    ipcMain.handle('validate:url', async (_event, url: string) => {
      return await validateRemoteUrl(url)
    })

    // Updater
    ipcMain.handle('updater:state', () => getUpdateState())
    ipcMain.handle('updater:check', () => checkForUpdates())
    ipcMain.handle('updater:download', () => downloadUpdate())
    ipcMain.handle('updater:install', () => installUpdate())

    // Changelog
    ipcMain.handle('app:changelog', async () => {
      try {
        const changelogPath = app.isPackaged
          ? join(process.resourcesPath, 'CHANGELOG.md')
          : join(app.getAppPath(), 'CHANGELOG.md')
        return await readFile(changelogPath, 'utf-8')
      } catch {
        return null
      }
    })

    // Guest registration comes only from the trusted desktop frame. It stores
    // identity, never a token; the selected owned guest supplies current auth.
    ipcMain.handle('connection:guest', async (event, connectionId: string, guestId: number) => {
      if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame ||
          typeof connectionId !== 'string' || !Number.isSafeInteger(guestId)) throw new Error('Invalid guest registration')
      const config = await getConfig()
      const connection = connectionId === 'local' ? buildLocalConnection()
        : config.connections.find(item => item.id === connectionId)
      if (!connection) throw new Error('Unknown connection')
      const target = { connectionId, guestId, url: resolveConnectionUrl(connection) }
      if (!isOwnedVoiceGuest(webContents.fromId(guestId) ?? undefined, target, mainWindow?.webContents,
          session.fromPartition(`persist:connection-${connectionId}`))) throw new Error('Invalid connection guest')
      voiceGuests.set(connectionId, guestId)
    })
    ipcMain.handle('connection:guest:remove', (event, connectionId: string, guestId: number) => {
      if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) return
      if (voiceGuests.get(connectionId) === guestId) voiceGuests.delete(connectionId)
    })

    // Misc
    ipcMain.handle('app:reset', () => resetAppHandler())

    // Spotlight
    ipcMain.handle('spotlight:submit', async (_event, query: string, images?: string[]) => {
      const conn = await getDefaultConnection()
      if (!conn) {
        mainWindow?.show()
        mainWindow?.focus()
        return
      }

      const url = resolveConnectionUrl(conn)

      // Build files payload from screenshot images
      const files = images?.map((dataUrl, i) => ({
        name: `screenshot-${Date.now()}-${i + 1}.png`,
        mimeType: 'image/png',
        dataUrl
      }))

      sendToRenderer('query', { query, connectionId: conn.id, url, files })

      spotlightWindow?.hide()
      // Show main window so it can receive and display the submitted query
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
      }
    })
    ipcMain.handle('spotlight:close', () => {
      spotlightWindow?.hide()
    })

    // Persist bar offset within the fullscreen spotlight window
    ipcMain.handle('spotlight:savePosition', async (_event, offset: { x: number; y: number }) => {
      spotlightBarOffset = offset
      setConfig({ spotlightPosition: offset }).catch((err) =>
        log.warn('Failed to persist spotlight bar position:', err)
      )
    })

    // Capture a region of the screen (called from Spotlight renderer after drag)
    ipcMain.handle(
      'spotlight:captureRegion',
      async (_event, rect: { x: number; y: number; width: number; height: number }) => {
        try {
          // ── Permission check (macOS) ──
          if (process.platform === 'darwin') {
            const status = systemPreferences.getMediaAccessStatus('screen')
            if (status !== 'granted') {
              log.warn(`spotlight:captureRegion — screen recording permission: ${status}`)
              new Notification({
                title: nativeText('Screen Recording Permission Required'),
                body: nativeText('Open WebUI needs Screen Recording access to capture screenshots. Please enable it in System Settings → Privacy & Security → Screen Recording, then restart the app.')
              }).show()
              // Open the correct System Preferences pane
              shell.openExternal(
                'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
              ).catch(() => {})
              return 'no-permission'
            }
          }

          // Make spotlight invisible (but don't hide it — hiding triggers macOS
          // window activation which brings up the main window behind it)
          spotlightWindow?.setOpacity(0)
          // Small delay to let the window fully disappear before capture
          await new Promise((r) => setTimeout(r, 150))

          const { screen } = require('electron')
          const cursorPoint = screen.getCursorScreenPoint()
          const display = screen.getDisplayNearestPoint(cursorPoint)
          const scaleFactor = display.scaleFactor || 1

          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: {
              width: Math.round(display.bounds.width * scaleFactor),
              height: Math.round(display.bounds.height * scaleFactor)
            }
          })

          // Find the source matching this display
          const source =
            sources.find((s) => s.display_id === String(display.id)) || sources[0]
          if (!source) {
            spotlightWindow?.setOpacity(1)
            return null
          }

          const fullImage = source.thumbnail
          // Validate thumbnail is not empty (can happen without permission)
          if (fullImage.isEmpty()) {
            log.warn('spotlight:captureRegion — captured thumbnail is empty (likely no permission)')
            spotlightWindow?.setOpacity(1)
            return null
          }

          const cropped = fullImage.crop({
            x: Math.round(rect.x * scaleFactor),
            y: Math.round(rect.y * scaleFactor),
            width: Math.round(rect.width * scaleFactor),
            height: Math.round(rect.height * scaleFactor)
          })

          // Restore spotlight visibility
          if (spotlightWindow && !spotlightWindow.isDestroyed()) {
            spotlightWindow.setOpacity(1)
          }

          return cropped.toDataURL()
        } catch (err) {
          log.error('spotlight:captureRegion failed:', err)
          // Restore spotlight on error
          spotlightWindow?.setOpacity(1)
          return null
        }
      }
    )

    // ── Voice Input ─────────────────────────────────────

    // Check microphone permission (macOS)
    ipcMain.handle('voiceInput:micPermission', async (event) => {
      requireVoiceCaller(event)
      if (process.platform === 'darwin') {
        const status = systemPreferences.getMediaAccessStatus('microphone')
        if (status !== 'granted') {
          const granted = await systemPreferences.askForMediaAccess('microphone')
          return granted ? 'granted' : 'denied'
        }
        return 'granted'
      }
      return 'granted' // Windows/Linux don't need explicit permission
    })

    // Transcribe audio via the connected server's STT endpoint
    ipcMain.handle('voiceInput:transcribe', async (event, sessionId: number, audioBuffer: ArrayBuffer) => {
      requireVoiceCaller(event)
      if (!(audioBuffer instanceof ArrayBuffer)) {
        throw new Error('Invalid voice input buffer')
      }
      try {
        const { token, url, signal } = await voiceSessions.claim(sessionId, await currentVoiceTarget())

        // Build multipart form data manually using Node.js
        const boundary = '----VoiceInput' + Date.now()
        const buffer = Buffer.from(audioBuffer)
        const filename = `recording-${Date.now()}.wav`

        const header = [
          `--${boundary}`,
          `Content-Disposition: form-data; name="file"; filename="${filename}"`,
          `Content-Type: audio/wav`,
          '',
          ''
        ].join('\r\n')

        const footer = `\r\n--${boundary}--\r\n`
        const headerBuf = Buffer.from(header, 'utf-8')
        const footerBuf = Buffer.from(footer, 'utf-8')
        const body = Buffer.concat([headerBuf, buffer, footerBuf])

        const response = await fetch(`${url}/api/v1/audio/transcriptions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`
          },
          body, redirect: 'error', signal
        })

        if (!response.ok) {
          // Provider error bodies can contain private details; do not log/relay them.
          throw new Error(`Transcription failed (HTTP ${response.status}). Check that your server has Speech-to-Text configured.`)
        }

        const result = await response.json()
        voiceSessions.finish(sessionId, result?.text)
        return { text: result.text }
      } catch (error: any) {
        const wasCurrent = voiceSessions.id === sessionId
        voiceSessions.cancel(sessionId)
        if (!wasCurrent) throw new Error('Voice input expired')
        voiceInputRecording = false
        voiceInputWindow?.hide()
        log.error('voiceInput:transcribe failed:', error instanceof Error ? error.message : 'unavailable')
        new Notification({
          title: nativeText('Voice Input Failed'),
          body: error?.message || 'Transcription failed. Check logs for details.'
        }).show()
        throw error
      }
    })

    // Voice input completed — deliver text to chat
    ipcMain.handle('voiceInput:done', async (event, sessionId: number) => {
      requireVoiceCaller(event)
      const result = await voiceSessions.deliver(sessionId, await currentVoiceTarget())
      voiceInputRecording = false
      playChime(false)
      voiceInputWindow?.hide()
      if (!result.text) return
      sendToRenderer('query', { query: result.text, connectionId: result.target.connectionId, url: result.target.url })
      showMainWindow()
    })

    // Voice input window requests close
    ipcMain.handle('voiceInput:close', (event, sessionId: number) => {
      requireVoiceCaller(event)
      if (voiceSessions.id !== sessionId) return
      voiceSessions.cancel(sessionId)
      voiceInputRecording = false
      playChime(false)
      if (voiceInputWindow && !voiceInputWindow.isDestroyed()) {
        voiceInputWindow.hide()
      }
    })

    // Voice input error
    ipcMain.handle('voiceInput:error', (event, sessionId: number, message: string) => {
      requireVoiceCaller(event)
      if (voiceSessions.id !== sessionId) return
      voiceSessions.cancel(sessionId)
      voiceInputWindow?.hide()
      log.warn('Voice input error:', typeof message === 'string' ? message.slice(0, 1000) : 'unavailable')
      voiceInputRecording = false
      new Notification({
        title: nativeText('Voice Input Error'),
        body: message || 'An unknown error occurred with voice input.'
      }).show()
    })

    // Open Terminal
    ipcMain.handle('open-terminal:start', async () => {
      if (isQuiting) return null
      try {
        return await startOpenTerminal(null, status => sendToRenderer('status:open-terminal-setup', status))
      } catch (error) {
        sendToRenderer('error', { message: error instanceof Error ? error.message : 'Open Terminal failed' })
        return null
      } finally { sendToRenderer('status:open-terminal-setup', '') }
    })
    ipcMain.handle('open-terminal:update', async () => {
      if (isQuiting) throw new Error('Application is shutting down')
      try {
        return await updateOpenTerminal(status => sendToRenderer('status:open-terminal-setup', status))
      } finally { sendToRenderer('status:open-terminal-setup', '') }
    })
    ipcMain.handle('open-terminal:stop', async () => {
      await stopOpenTerminal()
      return true
    })

    ipcMain.handle('open-terminal:info', () => getOpenTerminalInfo())
    ipcMain.handle('open-terminal:status', () => isPackageInstalled('open-terminal'))

    // llama.cpp
    ipcMain.handle('llamacpp:setup', async () => {
      try {
        const binary = await setupLlamaCpp((status) => {
          sendToRenderer('status:llamacpp-setup', status)
        })
        sendToRenderer('llamacpp:info', getLlamaCppInfo())
        return binary
      } catch (error) {
        log.error('Failed to setup llamacpp:', error)
        sendToRenderer('error', { message: `llamacpp setup failed: ${error?.message}` })
        return null
      }
    })

    ipcMain.handle('llamacpp:start', async () => {
      if (isQuiting) return null
      try {
        return await startLlamaCpp((status) => sendToRenderer('status:llamacpp-setup', status))
      } catch (error) {
        if (llamaService.info.status === 'failed') {
          log.error('Failed to start llamacpp:', error)
          sendToRenderer('error', { message: `llamacpp failed: ${error?.message}` })
        }
        return null
      } finally { sendToRenderer('status:llamacpp-setup', '') }
    })
    ipcMain.handle('llamacpp:stop', async () => {
      await stopLlamaCpp()
      return true
    })
    ipcMain.handle('llamacpp:info', () => getLlamaCppInfo())
    ipcMain.handle('llamacpp:asset-name', (_event, variant?: string) => getLlamaCppAssetName(variant))
    ipcMain.handle('llamacpp:logs', () => [llamaService.logs])

    ipcMain.handle('llamacpp:uninstall', async () => {
      try {
        await uninstallLlamaCpp()
        sendToRenderer('llamacpp:info', getLlamaCppInfo())
        await setConfig({ llamaCpp: { ...CONFIG?.llamaCpp, enabled: false } })
        CONFIG = await getConfig()
        return true
      } catch (error) {
        log.error('Failed to uninstall llamacpp:', error)
        return false
      }
    })

    // Hugging Face models
    ipcMain.handle('huggingface:models:list', () => listModels())
    ipcMain.handle('huggingface:models:dir', () => getModelsDir())
    ipcMain.handle('huggingface:models:delete', (_event, repo: string, filename: string) => {
      return deleteModel(repo, filename)
    })
    ipcMain.handle('huggingface:models:cancel', (_event, repo?: string, filename?: string) => {
      cancelDownload(repo, filename)
      return true
    })
    ipcMain.handle('huggingface:search', async (_event, query: string, token?: string) => {
      return searchModels(query, token)
    })
    ipcMain.handle('huggingface:repo:files', async (_event, repo: string, token?: string) => {
      return getRepoFiles(repo, token)
    })
    ipcMain.handle('huggingface:models:download', async (_event, repo: string, filename: string, token?: string, expectedSize?: number) => {
      try {
        sendToRenderer('status:huggingface-download', { repo, filename, status: 'downloading', percent: 0 })
        const filepath = await downloadModel(repo, filename, (progress) => {
          sendToRenderer('status:huggingface-download', {
            repo, filename,
            status: 'downloading',
            percent: progress.percent,
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes
          })
        }, token, expectedSize)
        sendToRenderer('status:huggingface-download', { repo, filename, status: 'done', filepath })
        return filepath
      } catch (error) {
        log.error('Failed to download model:', error)
        sendToRenderer('status:huggingface-download', { repo, filename, status: 'failed', error: error?.message })
        sendToRenderer('error', { message: `Model download failed: ${error?.message}` })
        return null
      }
    })

    ipcMain.handle('package:version', (_event, packageName: string) => getPackageVersion(packageName))
    ipcMain.handle('package:uninstall', async (_event, packageName: string) => {
      const config = await getConfig()
      if (config.localServer?.managedBackend === true && ['open-webui', 'open-terminal'].includes(packageName)) {
        throw new Error('Project-managed packages must be maintained through the project controller')
      }
      const result = uninstallPackage(packageName)
      // Notify renderer of install state change
      sendToRenderer('packages:changed', {
        'open-webui': isPackageInstalled('open-webui')
      })
      updateTray()
      return result
    })

    ipcMain.handle('dialog:selectFolder', async () => {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: nativeText('Select a folder'),
        buttonLabel: nativeText('Select folder'),
        properties: ['openDirectory']
      })
      return result.canceled ? null : result.filePaths[0] ?? null
    })

    ipcMain.handle('app:launchAtLogin:get', () => {
      return app.getLoginItemSettings().openAtLogin
    })
    ipcMain.handle('app:launchAtLogin:set', (_event, enabled: boolean) => {
      app.setLoginItemSettings({ openAtLogin: enabled })
    })

    ipcMain.handle('open:browser', async (_event, { url }) => {
      if (!url) throw new Error('No URL provided')
      let normalizedUrl = url
      if (normalizedUrl.startsWith('http://0.0.0.0')) {
        normalizedUrl = normalizedUrl.replace('http://0.0.0.0', 'http://localhost')
      }
      await openUrl(normalizedUrl)
    })

    ipcMain.handle('open:path', async (_event, folderPath: string) => {
      if (!folderPath) throw new Error('No path provided')
      await shell.openPath(folderPath)
    })

    ipcMain.handle('notification', async (_event, { title, body }) => {
      new Notification({ title, body }).show()
    })

    ipcMain.handle('llamacpp:check-update', async () => {
      try {
        return await checkLlamaCppUpdate()
      } catch (error) {
        log.error('Failed to check llamacpp update:', error)
        throw error
      }
    })

    ipcMain.handle('llamacpp:update', async () => {
      try {
        const result = await updateLlamaCpp((status) => {
          sendToRenderer('status:llamacpp-setup', status)
        })
        sendToRenderer('llamacpp:info', getLlamaCppInfo())
        return result
      } catch (error) {
        log.error('Failed to update llamacpp:', error)
        sendToRenderer('error', { message: `llamacpp update failed: ${error?.message}` })
        throw error
      }
    })

    // ─── Startup ──────────────────────────────────────

    updateTray()



    // Global shortcut
    registerShortcuts(CONFIG.globalShortcut, CONFIG.spotlightShortcut, CONFIG.voiceInputShortcut, CONFIG.callShortcut)

    createMainWindow(!CONFIG.startMinimized)
    // Show startup logs immediately while the service prepares and becomes ready.
    if (CONFIG?.llamaCpp?.enabled) {
      startLlamaCpp((status) => sendToRenderer('status:llamacpp-setup', status))
        .catch((error) => log.error('Auto-start llama.cpp failed:', error))
        .finally(() => sendToRenderer('status:llamacpp-setup', ''))
    }

    if (CONFIG?.openTerminal?.enabled) {
      startOpenTerminal(null, status => sendToRenderer('status:open-terminal-setup', status))
        .catch(error => log.warn('Open Terminal auto-connect failed:', error instanceof Error ? error.message : 'unavailable'))
        .finally(() => sendToRenderer('status:open-terminal-setup', ''))
    }

    // Initialize auto-updater
    initUpdater(sendToRenderer, CONFIG.automaticUpdates)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
      else {
        mainWindow?.show()
        mainWindow?.focus()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  let cleanupComplete = false
  let cleanupStarted = false
  app.on('before-quit', (event) => {
    if (cleanupComplete) return
    event.preventDefault()
    if (cleanupStarted) return
    cleanupStarted = true
    isQuiting = true
    voiceSessions.cancel()
    Promise.allSettled([llamaService.shutdown(), webuiService.shutdown(), terminalService.shutdown()]).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') log.error('Service shutdown failed:', result.reason)
      }
      cleanupComplete = true
      app.quit()
    })
  })
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    mainWindow = null
    tray?.destroy()
    tray = null
  })
}

import crypto from 'node:crypto'
import os from 'node:os'
import log from 'electron-log'
import { ManagedService, waitForReady } from '../process/managedService'
import { spawnPty } from '../process/nativePty'
import {
  getPythonPath, getConfig, setConfig, installPackage, isPackageInstalled,
  isPythonInstalled, installPython, portInUse, pythonEnv
} from './index'

export const terminalService = new ManagedService(spawnPty)
let apiKey: string | null = null
let updateGeneration = 0
let updatePending: Promise<ReturnType<typeof getOpenTerminalInfo>> | undefined

terminalService.subscribe(event => {
  if (event.type === 'state' && ['stopped', 'failed'].includes(event.info.status)) apiKey = null
})

export const getOpenTerminalInfo = () => ({
  ...terminalService.info,
  apiKey: terminalService.info.reachable ? apiKey : null
})

async function authenticatedReady(url: string, key: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(`${url}/api/health`, {
    headers: { Authorization: `Bearer ${key}` },
    redirect: 'error', signal
  })
  if (!response.ok) return false
  return (await response.json())?.status === 'ok'
}

async function startTerminal(port: number | null, onStatus: ((status: string) => void) | undefined, upgrade = false) {
  await terminalService.start(async signal => {
    let config = await getConfig()
    const desiredPort = port ?? config.openTerminal?.port ?? 39284
    if (!Number.isInteger(desiredPort) || desiredPort < 1 || desiredPort > 65535) {
      throw new Error('Invalid Open Terminal port')
    }
    const url = `http://127.0.0.1:${desiredPort}`
    if (config.localServer?.managedBackend === true) {
      let key = config.openTerminal?.apiKey
      if (typeof key !== 'string' || !key) throw new Error('Managed Open Terminal credentials are unavailable')
      if (upgrade) {
        await installPackage('open-terminal', undefined, onStatus, signal)
        signal.throwIfAborted()
        config = await getConfig()
        if (config.localServer?.managedBackend !== true || (config.openTerminal?.port ?? 39284) !== desiredPort) {
          throw new Error('Open Terminal configuration changed during update')
        }
        key = config.openTerminal?.apiKey
        if (typeof key !== 'string' || !key) throw new Error('Managed Open Terminal credentials are unavailable')
      }
      apiKey = key
      return {
        external: true as const, url,
        ready: async (signal: AbortSignal) => {
          if (!await authenticatedReady(url, key, AbortSignal.any([signal, AbortSignal.timeout(5000)]))) {
            throw new Error('Managed Open Terminal is unavailable or needs the current authenticated health endpoint. Use the project launcher.')
          }
        }
      }
    }
    // An occupied configured port is not authority to create another instance.
    if (await portInUse(desiredPort, '127.0.0.1')) throw new Error('Open Terminal port is already in use')
    signal.throwIfAborted()
    if (!isPythonInstalled() && !await installPython(undefined, onStatus, signal)) {
      throw new Error('Python installation failed')
    }
    if (upgrade || !isPackageInstalled('open-terminal')) await installPackage('open-terminal', undefined, onStatus, signal)
    signal.throwIfAborted()
    // Re-read before saving a newly generated key, preserving concurrent settings.
    const fresh = await getConfig()
    if (fresh.localServer?.managedBackend === true || (port ?? fresh.openTerminal?.port ?? 39284) !== desiredPort) {
      throw new Error('Open Terminal configuration changed during update')
    }
    let key = fresh.openTerminal?.apiKey
    if (!key) {
      key = crypto.randomBytes(24).toString('base64url')
      await setConfig({ openTerminal: { ...fresh.openTerminal, apiKey: key } })
    }
    if (typeof key !== 'string') throw new Error('Invalid Open Terminal credentials')
    apiKey = key
    const env = pythonEnv(fresh.envVars ?? {})
    for (const name of Object.keys(env)) {
      if (/^OPEN_TERMINAL_API_KEY(?:_FILE)?$/i.test(name)) delete env[name]
    }
    env.OPEN_TERMINAL_API_KEY = key
    env.PYTHONUNBUFFERED = '1'
    onStatus?.('Starting Open Terminal…')
    log.info('Starting owned Open Terminal at configured loopback port')
    return {
      file: getPythonPath(),
      args: ['-c', 'from open_terminal.cli import main; main()', 'run', '--host', '127.0.0.1',
        '--port', String(desiredPort), '--cwd', fresh.openTerminal?.cwd || os.homedir()],
      env, url,
      ready: (signal: AbortSignal) => waitForReady(probe => authenticatedReady(url, key, probe), signal)
    }
  })
  return getOpenTerminalInfo()
}

export function startOpenTerminal(port: number | null = null, onStatus?: (status: string) => void) {
  return updatePending ?? startTerminal(port, onStatus)
}

export function updateOpenTerminal(onStatus?: (status: string) => void) {
  if (updatePending) return updatePending
  const generation = ++updateGeneration
  // Reserve before stopping; concurrent starts/updates share this transaction.
  const pending = Promise.resolve().then(async () => {
    await terminalService.stop()
    if (generation !== updateGeneration) throw new Error('Open Terminal update cancelled')
    // The shared lifecycle owns preparation: stop/shutdown waits for the atomic
    // installer and prevents spawning or attaching after cancellation.
    return startTerminal(null, onStatus, true)
  }).finally(() => { if (updatePending === pending) updatePending = undefined })
  updatePending = pending
  return pending
}

export function stopOpenTerminal() {
  updateGeneration++
  return terminalService.stop()
}

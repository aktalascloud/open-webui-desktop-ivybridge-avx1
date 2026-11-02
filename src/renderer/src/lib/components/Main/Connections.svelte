<script lang="ts">
  import { isGuestPushType, canRelayDesktopEvent } from '../../guest-protocol'
  import { onMount } from 'svelte'
  import { fade } from 'svelte/transition'
  import { connections, config, serverInfo } from '../../stores'
  import i18n from '../../i18n'

  import Sidebar from './Connections/Sidebar.svelte'
  import Content from './Connections/Content.svelte'
  import TerminalDock from './Connections/TerminalDock.svelte'

  interface Props {
    onOpenSettings: () => void
    sidebarOpen?: boolean
    activeConnectionName?: string
  }

  let {
    onOpenSettings,
    sidebarOpen = $bindable(true),
    activeConnectionName = $bindable('')
  }: Props = $props()


  let url = $state('')
  let connecting = $state(false)
  let error = $state('')
  let view = $state('welcome') // welcome | install | connected
  let installPhase = $state('idle') // idle | working | error
  let installError = $state('')
  let toastVisible = $state(false)
  let toastTimeout: ReturnType<typeof setTimeout> | null = null
  let installStatus = $state('')
  let settingsOpen = $state(false)
  let activeConnectionId = $state('')
  let connectingId = $state('')
  let openConnections: Map<string, string> = $state(new Map())
  let localInstalled = $state(false)
  let openTerminalInstalled = $state(false)
  let showAddConnectionModal = $state(false)

  // Active log panel
  let content: Content | undefined = $state()
  let terminalDock: TerminalDock | undefined = $state()
  let canRefresh = $state(false)
  let terminalInfo = $state<{ pid?: number | null; error?: string | null; external?: boolean } | null>(null)

  const serverStatus = $derived($serverInfo?.status)
  const serverReachable = $derived($serverInfo?.reachable)

  const localConn = $derived(localInstalled
    ? { id: 'local', name: 'Open WebUI', type: 'local' as const, url: `http://127.0.0.1:${$config?.localServer?.port ?? 8080}` }
    : null
  )
  const remoteConnections = $derived($connections ?? [])

  // Open Terminal state
  let openTerminalStatus = $state<string | null>(null)

  // Llama Server state
  let llamaCppStatus = $state<string | null>(null)
  let llamaCppInfo = $state<{ url?: string; pid?: number; binaryPath?: string } | null>(null)
  let llamaCppSetupStatus = $state('')
  let openTerminalSetupStatus = $state('')

  const startInstall = async (options?: { installOpenTerminal?: boolean; installLlamaCpp?: boolean; installDir?: string }) => {
    if (installPhase === 'working') return
    installPhase = 'working'
    installError = ''
    installStatus = ''
    toastVisible = false
    try {
      // Save custom install directory before anything else
      if (options?.installDir) {
        const currentDir = await window.electronAPI.getInstallDir()
        if (options.installDir !== currentDir) {
          await window.electronAPI.setConfig({ installDir: options.installDir })
        }
      }

      // Check disk space before installing (minimum 5 GB)
      const MINIMUM_DISK_BYTES = 5 * 1024 * 1024 * 1024
      const disk = await window.electronAPI.getDiskSpace()
      if (disk?.free >= 0 && disk.free < MINIMUM_DISK_BYTES) {
        const availableGB = (disk.free / (1024 * 1024 * 1024)).toFixed(1)
        throw new Error($i18n.t('error.diskSpaceDetail', { available: availableGB }))
      }

      // Ensure Python and uv are installed before attempting package install
      const pythonReady = await window.electronAPI.getPythonStatus()
      if (!pythonReady) {
        const pythonOk = await window.electronAPI.installPython()
        if (!pythonOk) throw new Error($i18n.t('error.pythonInstallFailed'))
      }

      const ok = await window.electronAPI.installPackage()
      if (!ok) throw new Error($i18n.t('error.installFailedGeneric'))

      // Start optional services after packages are installed to avoid
      // concurrent uv installs fighting over the lockfile
      if (options?.installOpenTerminal) {
        await toggleOpenTerminal()
      }
      if (options?.installLlamaCpp) {
        await toggleLlamaCpp()
      }

      installStatus = $i18n.t('main.install.startingServer')
      await window.electronAPI.startServer()
      await window.electronAPI.getServerInfo()

      installStatus = $i18n.t('main.install.settingUpConnection')
      await window.electronAPI.setDefaultConnection('local')
      config.set(await window.electronAPI.getConfig())

      // Now connect — the server is ready
      installStatus = ''
      if (!await connect('local', false)) throw new Error(error || $i18n.t('error.serverStartFailed'))
      installPhase = 'idle'
    } catch (e: any) {
      installPhase = 'error'
      installError = e?.message || $i18n.t('error.somethingWentWrong')
      toastVisible = true
      if (toastTimeout) clearTimeout(toastTimeout)
      toastTimeout = setTimeout(() => { toastVisible = false }, 5000)
    }
  }

  const addConnection = async () => {
    if (!url.trim()) return
    let u = url.trim()
    if (!u.startsWith('http')) u = 'https://' + u
    error = ''
    try {
      new URL(u)
    } catch {
      error = $i18n.t('setup.invalidUrl')
      return
    }
    connecting = true
    try {
      const valid = await window.electronAPI.validateUrl(u)
      if (!valid) {
        error = $i18n.t('setup.couldNotReachServer')
        connecting = false
        return
      }
      await window.electronAPI.addConnection({
        id: crypto.randomUUID(),
        name: new URL(u).hostname,
        type: 'remote',
        url: u
      })
      config.set(await window.electronAPI.getConfig())
      url = ''
      error = ''
      showAddConnectionModal = false
      view = 'welcome'
    } catch {
      error = $i18n.t('setup.connectionFailed')
    } finally {
      connecting = false
    }
  }

  let connectRequest = 0
  const connect = async (id: string, toggle = true): Promise<boolean> => {
    const request = ++connectRequest
    if (toggle && activeConnectionId === id && view === 'connected') {
      connectingId = ''
      activeConnectionId = ''
      view = 'welcome'
      return true
    }
    connectingId = id
    error = ''
    try {
      await window.electronAPI.setDefaultConnection(id)
      const result = await window.electronAPI.connectTo(id)
      if (request !== connectRequest) return false
      if (!result?.url) throw new Error($i18n.t('error.serverStartFailed'))
      openConnections.set(id, result.url)
      openConnections = new Map(openConnections)
      activeConnectionId = id
      view = 'connected'
      return true
    } catch (failure) {
      if (request === connectRequest) error = failure instanceof Error ? failure.message : String(failure)
      return false
    } finally {
      if (request === connectRequest) connectingId = ''
    }
  }

  const disconnect = () => {
    connectRequest++
    connectingId = ''
    activeConnectionId = ''
    view = 'welcome'
  }

  const remove = async (id: string) => {
    await window.electronAPI.removeConnection(id)
    config.set(await window.electronAPI.getConfig())
    if (activeConnectionId === id) {
      disconnect()
    }
    openConnections.delete(id)
    openConnections = new Map(openConnections)
  }

  $effect(() => {
    if (activeConnectionId === 'local') {
      activeConnectionName = localConn?.name ?? 'Open WebUI'
    } else {
      const conn = ($connections ?? []).find((c) => c.id === activeConnectionId)
      activeConnectionName = conn?.name ?? ''
    }
  })

  const openGithub = () => {
    settingsOpen = false
    window.electronAPI?.openInBrowser?.('https://github.com/open-webui/desktop')
  }

  // ── Log panel PTY helpers ─────────────────────────────
  const selectLog = (log: string) => terminalDock?.select(log === 'llama-server' ? 'llamacpp' : log as 'server' | 'open-terminal')

  // ── Webview event delivery ─────────────────────────────
  // Single path: all events from the main process flow through here.
  // User queries are targeted; local credentials stay in the owned local view.
  const sendToWebview = (event: any, connId?: string) => {
    if (!isGuestPushType(event?.type)) return
    if ((event.type === 'query' || event.type === 'call') && !connId) return
    const container = document.querySelector('.content-webview-container')
    if (!container) return
    const webviews = connId
      ? [container.querySelector(`webview[partition="persist:connection-${connId}"]`) as any].filter(Boolean)
      : Array.from(container.querySelectorAll('webview'))
    for (const wv of webviews as any[]) {
      const localOnly = event.type === 'connections:terminal' || event.type === 'connections:openai'
      if (localOnly && wv.getAttribute('partition') !== 'persist:connection-local') continue
      const deliver = () => {
        if (!canRelayDesktopEvent(event.type, wv.getURL(), localConn?.url, !!connId)) return false
        wv.send('desktop:event', event)
        return true
      }
      try { if (deliver()) continue } catch { /* Wait for the owned view. */ }
      const onReady = () => {
        wv.removeEventListener('dom-ready', onReady)
        try { deliver() } catch { /* A closed view owns no delivery. */ }
      }
      wv.addEventListener('dom-ready', onReady)
    }
  }

  // Listen for events from main process
  onMount(() => {
    const unsubscribe = window.electronAPI.onData((data: any) => {
      // ── Connection opened (startup, tray click) ───────
      if (data.type === 'connection:open' && data.data?.url) {
        const connId = data.data.connectionId ?? ''
        const incomingUrl = data.data.url

        if (!openConnections.has(connId)) {
          openConnections.set(connId, incomingUrl)
          openConnections = new Map(openConnections)
        }

        if (view !== 'connected') {
          activeConnectionId = connId
          if (installPhase !== 'working') view = 'connected'
        }
        return
      }

      // ── Spotlight / desktop query ─────────────────────
      if (data.type === 'query' && (data.data?.query || data.data?.files?.length)) {
        const connId = data.data.connectionId ?? ''
        const query = data.data.query
        const files = data.data.files
        const baseUrl = data.data.url ?? ''

        if (!openConnections.has(connId)) {
          openConnections.set(connId, baseUrl)
          openConnections = new Map(openConnections)
        } else {
        }
        activeConnectionId = connId
        if (installPhase !== 'working') view = 'connected'

        // Targeted delivery — wait a frame for the webview DOM to exist
        requestAnimationFrame(() => {
          sendToWebview({ type: 'query', data: { query, files } }, connId)
        })
        return
      }

      // ── Call shortcut ─────────────────────────────────
      if (data.type === 'call' && data.data?.connectionId) {
        const connId = data.data.connectionId ?? ''
        const baseUrl = data.data.url ?? ''

        if (!openConnections.has(connId)) {
          openConnections.set(connId, baseUrl)
          openConnections = new Map(openConnections)
        } else {
        }
        activeConnectionId = connId
        if (installPhase !== 'working') view = 'connected'

        // Targeted delivery — wait a frame for the webview DOM to exist
        requestAnimationFrame(() => {
          sendToWebview({ type: 'call' }, connId)
        })
        return
      }

      // ── Desktop-only state (not forwarded to webviews) ─
      if (data.type === 'open-terminal:info') { terminalInfo = data.data; openTerminalStatus = data.data?.status; return }
      if (data.type === 'llamacpp:info') { llamaCppInfo = data.data; llamaCppStatus = data.data?.status; return }
      if (data.type === 'status:open-terminal') { openTerminalStatus = data.data; return }
      if (data.type === 'status:open-terminal-setup') { openTerminalSetupStatus = data.data ?? ''; return }
      if (data.type === 'open-terminal:ready') { openTerminalStatus = 'started'; openTerminalSetupStatus = ''; return }
      if (data.type === 'status:llamacpp') { llamaCppStatus = data.data; return }
      if (data.type === 'status:llamacpp-setup') { llamaCppSetupStatus = data.data ?? ''; return }
      if (data.type === 'llamacpp:ready') { llamaCppInfo = data.data; llamaCppStatus = 'started'; llamaCppSetupStatus = ''; return }
      if (data.type === 'status:install') { installStatus = data.data ?? ''; return }
      if (data.type === 'packages:changed') {
        localInstalled = !!data.data?.['open-webui']
        return
      }
      if (data.type === 'connections:changed') {
        connections.set(data.data ?? [])
        return
      }

      // ── Everything else → broadcast to all webviews ───
      sendToWebview(data)
    })

    // Auto-connect to the default connection on startup so the webview
    // is pre-loaded and ready for spotlight queries.
    window.electronAPI.getConfig().then((cfg: any) => {
      connections.set(cfg?.connections ?? [])
      sidebarOpen = cfg?.showSidebar !== false
      if (cfg?.defaultConnectionId && !activeConnectionId) {
        connect(cfg.defaultConnectionId)
      }
    })

    // Check current Open Terminal state on mount
    window.electronAPI.getOpenTerminalInfo().then((info: any) => {
      terminalInfo = info
      if (info?.status) {
        openTerminalStatus = info.status
      }
    })

    // Check if Open Terminal package is installed
    window.electronAPI.getOpenTerminalStatus().then((installed: boolean) => {
      openTerminalInstalled = installed
    })

    // Check if Open WebUI package is installed
    window.electronAPI.getPackageVersion('open-webui').then((v: string | null) => {
      localInstalled = v !== null
    })

    // Check llama-server state on mount
    window.electronAPI.getLlamaCppInfo().then((info: any) => {
      if (info?.status) {
        llamaCppStatus = info.status
      }
      if (info?.binaryPath || info?.status) {
        llamaCppInfo = info
      }
    })
    return () => { unsubscribe(); if (toastTimeout) clearTimeout(toastTimeout) }
  })

  const toggleOpenTerminal = async () => {
    if (openTerminalStatus === 'starting') return
    if (openTerminalStatus === 'started') {
      openTerminalStatus = 'stopping'
      await window.electronAPI.stopOpenTerminal()
      openTerminalStatus = null
      openTerminalSetupStatus = ''
    } else {
      openTerminalStatus = 'starting'
      openTerminalSetupStatus = ''
      const result = await window.electronAPI.startOpenTerminal()
      if (result) {
        openTerminalStatus = 'started'
      } else {
        openTerminalStatus = 'failed'
      }
      openTerminalSetupStatus = ''
    }
  }

  const toggleLlamaCpp = async () => {
    if (llamaCppStatus === 'starting' || llamaCppStatus === 'setting-up') return
    if (llamaCppStatus === 'started') {
      llamaCppStatus = 'stopping'
      await window.electronAPI.stopLlamaCpp()
      llamaCppStatus = null
      llamaCppInfo = null
    } else {
      llamaCppStatus = 'starting'
      const result = await window.electronAPI.startLlamaCpp()
      if (result) {
        llamaCppInfo = result
        llamaCppStatus = 'started'
      } else {
        llamaCppStatus = 'failed'
      }
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="h-full w-full flex flex-col bg-[#f5f5f7] dark:bg-[#0a0a0a] text-[#1d1d1f] dark:text-[#fafafa]" in:fade={{ duration: 200 }}>
  <div class="flex-1 min-h-0 flex">
    {#if sidebarOpen}
      <Sidebar
        {activeConnectionId}
        {connectingId}
        {localConn}
        {localInstalled}
        {remoteConnections}
        {serverStatus}
        {serverReachable}
        bind:settingsOpen
        onConnect={connect}
        onDisconnect={disconnect}
        onAddView={() => { showAddConnectionModal = true }}
        {onOpenSettings}
        onRename={async (id, name) => {
          await window.electronAPI.updateConnection(id, { name })
        }}
        onRemove={remove}
        {openGithub}
      />
    {/if}

    <Content bind:this={content} bind:canRefresh
      {sidebarOpen}
      {view}
      {activeConnectionId}
      {connectingId}
      {openConnections}
      {localConn}
      {localInstalled}
      {remoteConnections}
      {installPhase}
      {installError}
      {installStatus}
      {toastVisible}
      bind:url
      bind:connecting
      bind:error
      bind:showAddConnectionModal
      onStartInstall={startInstall}
      onAddConnection={addConnection}
      onSetView={(v) => { if (v === 'settings') onOpenSettings(); else view = v }}
      onOpenWebUI={(id) => { void connect(id, false) }}
      onOpenTerminal={() => selectLog('server')}
    />
  </div>

  <TerminalDock bind:this={terminalDock} {onOpenSettings} {sidebarOpen}
    onToggleSidebar={() => {
      sidebarOpen = !sidebarOpen
      void window.electronAPI.setConfig({ showSidebar: sidebarOpen })
    }}
    onRefresh={() => content?.refresh()} {canRefresh}
    services={[
      ...(localInstalled || (serverStatus && serverStatus !== 'stopped') ? [{
        id: 'server' as const, label: $i18n.t('statusBar.server'), status: serverStatus,
        pid: $serverInfo?.pid, browserUrl: $serverInfo?.reachable ? $serverInfo.url : undefined,
        detail: $serverInfo?.error || installStatus,
        runningAction: $config?.localServer?.managedBackend ? 'reconnect' as const : 'restart' as const,
        onStart: async () => {
          if (!localInstalled) { await startInstall(); return }
          if (!await connect('local', false)) throw new Error(error || $i18n.t('error.serverStartFailed'))
        },
        onRunningAction: async () => {
          if (!await window.electronAPI.restartServer()) throw new Error($i18n.t('error.serverRestartFailed'))
          if (!await connect('local', false)) throw new Error(error || $i18n.t('error.serverStartFailed'))
        }
      }] : []),
      ...(openTerminalInstalled || (openTerminalStatus && openTerminalStatus !== 'stopped') ? [{
        id: 'open-terminal' as const, label: $i18n.t('sidebar.openTerminal'), status: openTerminalStatus,
        pid: terminalInfo?.pid, detail: terminalInfo?.error || openTerminalSetupStatus,
        runningAction: $config?.localServer?.managedBackend ? 'reconnect' as const : 'stop' as const,
        onStart: async () => {
          const result = await window.electronAPI.startOpenTerminal()
          if (!result) throw new Error($i18n.t('error.terminalStartFailed'))
        },
        onRunningAction: async () => {
          await window.electronAPI.stopOpenTerminal()
          if ($config?.localServer?.managedBackend && !await window.electronAPI.startOpenTerminal()) {
            throw new Error($i18n.t('error.terminalStartFailed'))
          }
        }
      }] : []),
      ...(llamaCppInfo?.binaryPath || (llamaCppStatus && llamaCppStatus !== 'stopped') ? [{
        id: 'llamacpp' as const, label: $i18n.t('sidebar.llamaCpp'), status: llamaCppStatus,
        pid: llamaCppInfo?.pid, detail: llamaCppSetupStatus,
        runningAction: 'stop' as const,
        onStart: async () => { if (!await window.electronAPI.startLlamaCpp()) throw new Error($i18n.t('error.serverStartFailed')) },
        onRunningAction: () => window.electronAPI.stopLlamaCpp()
      }] : [])
    ]}
  />
</div>

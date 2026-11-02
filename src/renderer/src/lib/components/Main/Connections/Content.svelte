<script lang="ts">
  import ConnectionView from './ConnectionView.svelte'
  import AddConnectionModal from './AddConnectionModal.svelte'
  let {
    canRefresh = $bindable(false),
    view, activeConnectionId, connectingId, openConnections, localInstalled,
    installPhase, installError, installStatus, toastVisible,
    url = $bindable(''), connecting = $bindable(false), error = $bindable(''),
    showAddConnectionModal = $bindable(false),
    onStartInstall, onAddConnection, onSetView, onOpenWebUI, onOpenTerminal
  }: {
    canRefresh?: boolean; sidebarOpen: boolean; view: string; activeConnectionId: string; connectingId: string;
    openConnections: Map<string, string>; localConn: unknown; localInstalled: boolean;
    remoteConnections: unknown[]; installPhase: string; installError: string;
    installStatus: string; toastVisible: boolean; url: string; connecting: boolean;
    error: string; showAddConnectionModal: boolean;
    onStartInstall: (options?: { installOpenTerminal?: boolean; installLlamaCpp?: boolean; installDir?: string }) => void;
    onAddConnection: () => void; onSetView: (view: string) => void;
    onOpenWebUI: (id: string) => void; onOpenTerminal: () => void;
  } = $props()
  let views: Record<string, ConnectionView> = {}
  let refreshable: Record<string, boolean> = $state({})
  $effect(() => { canRefresh = view === 'connected' && !!refreshable[activeConnectionId] })
  export function refresh(): void { views[activeConnectionId]?.refresh() }
</script>

<div class="content-webview-container flex-1 flex min-h-0 min-w-0 relative">
  {#each [...openConnections] as [connectionId, serverUrl] (connectionId)}
    <div class="flex-1 min-h-0 min-w-0" style:display={view === 'connected' && activeConnectionId === connectionId ? 'flex' : 'none'}>
      <ConnectionView bind:this={views[connectionId]} bind:canRefresh={refreshable[connectionId]} {connectionId} {serverUrl} active={view === 'connected' && activeConnectionId === connectionId}
        connecting={connectingId === connectionId} launchError={error}
        {localInstalled} {installPhase} {installError} {installStatus} {toastVisible}
        {onStartInstall} {onSetView} onOpenWebUI={() => onOpenWebUI(connectionId)} {onOpenTerminal} />
    </div>
  {/each}
  {#if view !== 'connected'}
    <ConnectionView serverUrl="" {connecting} launchError={error}
      {localInstalled} {installPhase} {installError} {installStatus} {toastVisible}
      {onStartInstall} {onSetView} onOpenWebUI={() => onOpenWebUI('local')} {onOpenTerminal} />
  {/if}
  {#if showAddConnectionModal}
    <AddConnectionModal bind:url bind:connecting bind:error onConnect={onAddConnection}
      onCancel={() => { showAddConnectionModal = false; error = '' }} />
  {/if}
</div>

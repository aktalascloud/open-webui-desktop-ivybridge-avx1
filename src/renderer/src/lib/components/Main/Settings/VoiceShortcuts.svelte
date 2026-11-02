<script lang="ts">
  import { config } from '../../../stores'
  import i18n from '../../../i18n'
  import Switch from '../../common/Switch.svelte'
  // Spotlight shortcut recorder
  let spotlightShortcutValue = $state('')
  let spotlightRecording = $state(false)
  let spotlightShortcutInputEl = $state<HTMLButtonElement | null>(null)

  // Voice input shortcut recorder
  let voiceInputShortcutValue = $state('')
  let voiceInputRecording = $state(false)
  let voiceInputShortcutInputEl = $state<HTMLButtonElement | null>(null)
  let voiceInputEnabled = $state(true)

  // Call shortcut recorder
  let callShortcutValue = $state('')
  let callRecording = $state(false)
  let callShortcutInputEl = $state<HTMLButtonElement | null>(null)
  let callEnabled = $state(true)

  // Spotlight clipboard paste
  let spotlightClipboardPaste = $state(true)

  $effect(() => {
    if ($config?.spotlightShortcut !== undefined) {
      spotlightShortcutValue = $config.spotlightShortcut ?? ''
    }
    if ($config?.spotlightClipboardPaste !== undefined) {
      spotlightClipboardPaste = $config.spotlightClipboardPaste ?? true
    }
  })

  $effect(() => {
    if ($config?.voiceInputShortcut !== undefined) {
      voiceInputShortcutValue = $config.voiceInputShortcut ?? ''
    }
    if ($config?.voiceInputEnabled !== undefined) {
      voiceInputEnabled = $config.voiceInputEnabled ?? true
    }
  })

  $effect(() => {
    if ($config?.callShortcut !== undefined) {
      callShortcutValue = $config.callShortcut ?? ''
    }
    if ($config?.callEnabled !== undefined) {
      callEnabled = $config.callEnabled ?? true
    }
  })

  const keyToElectron = (e: KeyboardEvent): string | null => {
    const parts: string[] = []
    if (e.metaKey || e.ctrlKey) parts.push('CommandOrControl')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')

    // Ignore bare modifier presses
    const ignore = ['Control', 'Meta', 'Alt', 'Shift']
    if (ignore.includes(e.key)) return null

    // Use e.code to get the physical key (avoids macOS Alt producing unicode like √ for V)
    const codeMap: Record<string, string> = {
      Space: 'Space',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Enter: 'Return',
      Backquote: '`',
      Minus: '-',
      Equal: '=',
      BracketLeft: '[',
      BracketRight: ']',
      Backslash: '\\',
      Semicolon: ';',
      Quote: "'",
      Comma: ',',
      Period: '.',
      Slash: '/'
    }

    let key: string
    if (codeMap[e.code]) {
      key = codeMap[e.code]
    } else if (e.code.startsWith('Key')) {
      key = e.code.slice(3) // KeyA → A
    } else if (e.code.startsWith('Digit')) {
      key = e.code.slice(5) // Digit1 → 1
    } else if (e.code.startsWith('F') && /^F\d+$/.test(e.code)) {
      key = e.code // F1, F2, etc.
    } else {
      key = e.key.length === 1 ? e.key.toUpperCase() : e.key
    }

    parts.push(key)
    return parts.join('+')
  }

  const displayShortcut = (accel: string): string => {
    if (!accel) return ''
    const isMac = navigator.platform.includes('Mac')
    return accel
      .replace(/CommandOrControl/g, isMac ? '⌘' : 'Ctrl')
      .replace(/Alt/g, isMac ? '⌥' : 'Alt')
      .replace(/Shift/g, isMac ? '⇧' : 'Shift')
      .replace(/\+/g, ' + ')
  }

  const handleSpotlightShortcutKeydown = async (e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (e.key === 'Escape') {
      spotlightRecording = false
      return
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      spotlightShortcutValue = ''
      spotlightRecording = false
      await window.electronAPI.setConfig({ spotlightShortcut: '' })
      config.set(await window.electronAPI.getConfig())
      return
    }

    const accel = keyToElectron(e)
    if (accel) {
      spotlightShortcutValue = accel
      spotlightRecording = false
      await window.electronAPI.setConfig({ spotlightShortcut: accel })
      config.set(await window.electronAPI.getConfig())
    }
  }

  const handleVoiceInputShortcutKeydown = async (e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (e.key === 'Escape') {
      voiceInputRecording = false
      return
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      voiceInputShortcutValue = ''
      voiceInputRecording = false
      await window.electronAPI.setConfig({ voiceInputShortcut: '' })
      config.set(await window.electronAPI.getConfig())
      return
    }

    const accel = keyToElectron(e)
    if (accel) {
      voiceInputShortcutValue = accel
      voiceInputRecording = false
      await window.electronAPI.setConfig({ voiceInputShortcut: accel })
      config.set(await window.electronAPI.getConfig())
    }
  }

  const handleCallShortcutKeydown = async (e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (e.key === 'Escape') {
      callRecording = false
      return
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      callShortcutValue = ''
      callRecording = false
      await window.electronAPI.setConfig({ callShortcut: '' })
      config.set(await window.electronAPI.getConfig())
      return
    }

    const accel = keyToElectron(e)
    if (accel) {
      callShortcutValue = accel
      callRecording = false
      await window.electronAPI.setConfig({ callShortcut: accel })
      config.set(await window.electronAPI.getConfig())
    }
  }

</script>
<div class="flex flex-col divide-y divide-white/[0.04]">
  <div class="py-4 flex items-center justify-between">
    <div>
      <div class="text-[13px] opacity-70">{$i18n.t('settings.general.spotlightShortcut')}</div>
      <div class="text-[11px] opacity-25 mt-0.5">
        {#if spotlightRecording}
          {$i18n.t('settings.general.globalShortcutRecording')}
        {:else}
          {$i18n.t('settings.general.spotlightShortcutDesc')}
        {/if}
      </div>
    </div>
    <div class="flex items-center gap-1.5">
      <button
        bind:this={spotlightShortcutInputEl}
        class="text-[12px] px-3 py-1.5 border-none outline-none rounded-xl transition min-w-[80px] text-center
          {spotlightRecording
            ? 'bg-black/[0.08] dark:bg-white/[0.10] text-[#1d1d1f] dark:text-[#fafafa] opacity-80 animate-pulse'
            : 'bg-black/[0.04] dark:bg-white/[0.06] text-[#1d1d1f] dark:text-[#fafafa] opacity-60 hover:opacity-80'}"
        onclick={() => {
          spotlightRecording = true
          spotlightShortcutInputEl?.focus()
        }}
        onkeydown={(e) => {
          if (spotlightRecording) handleSpotlightShortcutKeydown(e)
        }}
        onblur={() => {
          spotlightRecording = false
        }}
      >
        {#if spotlightRecording}
          <span class="text-[11px]">{$i18n.t('settings.general.pressShortcut')}</span>
        {:else if spotlightShortcutValue}
          {displayShortcut(spotlightShortcutValue)}
        {:else}
          <span class="opacity-40">{$i18n.t('common.disabled')}</span>
        {/if}
      </button>
      {#if spotlightShortcutValue && !spotlightRecording}
        <button
          aria-label={$i18n.t('settings.general.clearShortcut')}
          class="opacity-20 hover:opacity-50 transition bg-transparent border-none text-[#1d1d1f] dark:text-[#fafafa] p-0.5 shrink-0"
          onclick={async () => {
            spotlightShortcutValue = ''
            await window.electronAPI.setConfig({ spotlightShortcut: '' })
            config.set(await window.electronAPI.getConfig())
          }}
        >
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      {/if}
    </div>
  </div>

  <div class="py-4 flex items-center justify-between">
    <div>
      <div class="text-[13px] opacity-70">{$i18n.t('settings.general.clipboardAutoPaste')}</div>
      <div class="text-[11px] opacity-25 mt-0.5">{$i18n.t('settings.general.clipboardAutoPasteDesc')}</div>
    </div>
    <Switch
      checked={spotlightClipboardPaste}
      label={$i18n.t('settings.general.toggleClipboardAutoPaste')}
      onchange={async (value) => {
        spotlightClipboardPaste = value
        await window.electronAPI.setConfig({ spotlightClipboardPaste: value })
        config.set(await window.electronAPI.getConfig())
      }}
    />
  </div>

  <div class="py-4 flex items-center justify-between">
    <div>
      <div class="text-[13px] opacity-70">{$i18n.t('settings.general.voiceInput')}</div>
      <div class="text-[11px] opacity-25 mt-0.5">{$i18n.t('settings.general.voiceInputDesc')}</div>
    </div>
    <Switch
      checked={voiceInputEnabled}
      label={$i18n.t('settings.general.toggleVoiceInput')}
      onchange={async (value) => {
        voiceInputEnabled = value
        await window.electronAPI.setConfig({ voiceInputEnabled: value })
        config.set(await window.electronAPI.getConfig())
      }}
    />
  </div>

  {#if voiceInputEnabled}
  <div class="py-4 flex items-center justify-between">
    <div>
      <div class="text-[13px] opacity-70">{$i18n.t('settings.general.voiceInputShortcut')}</div>
      <div class="text-[11px] opacity-25 mt-0.5">
        {#if voiceInputRecording}
          {$i18n.t('settings.general.pressShortcut')}
        {:else}
          {$i18n.t('settings.general.voiceInputShortcutDesc')}
        {/if}
      </div>
    </div>
    <div class="flex items-center gap-1.5">
      <button
        bind:this={voiceInputShortcutInputEl}
        class="text-[12px] px-3 py-1.5 border-none outline-none rounded-xl transition min-w-[80px] text-center
          {voiceInputRecording
            ? 'bg-black/[0.08] dark:bg-white/[0.10] text-[#1d1d1f] dark:text-[#fafafa] opacity-80 animate-pulse'
            : 'bg-black/[0.04] dark:bg-white/[0.06] text-[#1d1d1f] dark:text-[#fafafa] opacity-60 hover:opacity-80'}"
        onclick={() => {
          voiceInputRecording = true
          voiceInputShortcutInputEl?.focus()
        }}
        onkeydown={(e) => {
          if (voiceInputRecording) handleVoiceInputShortcutKeydown(e)
        }}
        onblur={() => {
          voiceInputRecording = false
        }}
      >
        {#if voiceInputRecording}
          <span class="text-[11px]">{$i18n.t('settings.general.pressShortcut')}</span>
        {:else if voiceInputShortcutValue}
          {displayShortcut(voiceInputShortcutValue)}
        {:else}
          <span class="opacity-40">{$i18n.t('common.disabled')}</span>
        {/if}
      </button>
      {#if voiceInputShortcutValue && !voiceInputRecording}
        <button
          aria-label={$i18n.t('settings.general.clearShortcut')}
          class="opacity-20 hover:opacity-50 transition bg-transparent border-none text-[#1d1d1f] dark:text-[#fafafa] p-0.5 shrink-0"
          onclick={async () => {
            voiceInputShortcutValue = ''
            await window.electronAPI.setConfig({ voiceInputShortcut: '' })
            config.set(await window.electronAPI.getConfig())
          }}
        >
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      {/if}
    </div>
  </div>
  {/if}

  <div class="py-4 flex items-center justify-between">
    <div>
      <div class="text-[13px] opacity-70">{$i18n.t('settings.general.call')}</div>
      <div class="text-[11px] opacity-25 mt-0.5">{$i18n.t('settings.general.callDesc')}</div>
    </div>
    <Switch
      checked={callEnabled}
      label={$i18n.t('settings.general.toggleCall')}
      onchange={async (value) => {
        callEnabled = value
        await window.electronAPI.setConfig({ callEnabled: value })
        config.set(await window.electronAPI.getConfig())
      }}
    />
  </div>

  {#if callEnabled}
  <div class="py-4 flex items-center justify-between">
    <div>
      <div class="text-[13px] opacity-70">{$i18n.t('settings.general.callShortcut')}</div>
      <div class="text-[11px] opacity-25 mt-0.5">
        {#if callRecording}
          {$i18n.t('settings.general.pressShortcut')}
        {:else}
          {$i18n.t('settings.general.callShortcutDesc')}
        {/if}
      </div>
    </div>
    <div class="flex items-center gap-1.5">
      <button
        bind:this={callShortcutInputEl}
        class="text-[12px] px-3 py-1.5 border-none outline-none rounded-xl transition min-w-[80px] text-center
          {callRecording
            ? 'bg-black/[0.08] dark:bg-white/[0.10] text-[#1d1d1f] dark:text-[#fafafa] opacity-80 animate-pulse'
            : 'bg-black/[0.04] dark:bg-white/[0.06] text-[#1d1d1f] dark:text-[#fafafa] opacity-60 hover:opacity-80'}"
        onclick={() => {
          callRecording = true
          callShortcutInputEl?.focus()
        }}
        onkeydown={(e) => {
          if (callRecording) handleCallShortcutKeydown(e)
        }}
        onblur={() => {
          callRecording = false
        }}
      >
        {#if callRecording}
          <span class="text-[11px]">{$i18n.t('settings.general.pressShortcut')}</span>
        {:else if callShortcutValue}
          {displayShortcut(callShortcutValue)}
        {:else}
          <span class="opacity-40">{$i18n.t('common.disabled')}</span>
        {/if}
      </button>
      {#if callShortcutValue && !callRecording}
        <button
          aria-label={$i18n.t('settings.general.clearShortcut')}
          class="opacity-20 hover:opacity-50 transition bg-transparent border-none text-[#1d1d1f] dark:text-[#fafafa] p-0.5 shrink-0"
          onclick={async () => {
            callShortcutValue = ''
            await window.electronAPI.setConfig({ callShortcut: '' })
            config.set(await window.electronAPI.getConfig())
          }}
        >
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      {/if}
    </div>
  </div>
  {/if}

</div>

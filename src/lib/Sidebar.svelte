<script lang="ts">
  import { formatStorageBytes } from './sync-protocol'
  import type { SyncSnapshot } from './sync'

  type Props = {
    menuOpen: boolean
    theme: 'dark' | 'light'
    compressWebp: boolean
    compressionFormat: 'webp' | 'jpeg'
    showHelp: boolean
    accountSession: { user: { email: string; name: string } } | null
    syncState: SyncSnapshot | null
    feedbackUrl: string
    onclose: () => void
    ontoggletheme: () => void
    ontogglewebp: () => void
    ontogglehelp: () => void
    onopenaccount: () => void
    onopentagmanager: () => void
    onbackup: () => void
    onrestore: () => void
  }

  let {
    menuOpen,
    theme,
    compressWebp,
    compressionFormat,
    showHelp,
    accountSession,
    syncState,
    feedbackUrl,
    onclose,
    ontoggletheme,
    ontogglewebp,
    ontogglehelp,
    onopenaccount,
    onopentagmanager,
    onbackup,
    onrestore,
  }: Props = $props()

  function blurIfInsideMenu() {
    const active = document.activeElement
    if (active instanceof HTMLElement && active.closest('#side-menu')) {
      active.blur()
    }
  }

  function closeSafely() {
    blurIfInsideMenu()
    onclose()
  }

  function onMenuKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') closeSafely()
  }
</script>

{#if menuOpen}
  <button class="menu-backdrop" type="button" aria-label="Close menu" onclick={closeSafely} onkeydown={onMenuKeydown}></button>
{/if}
<aside id="side-menu" class:open={menuOpen} class="side-menu" aria-label="Main menu" aria-hidden={!menuOpen} inert={!menuOpen}>
  <div class="side-menu-heading"><strong>MENU</strong><button type="button" onclick={closeSafely} aria-label="Close menu">×</button></div>
  <button
    class="theme-toggle"
    onclick={() => { ontoggletheme(); closeSafely() }}
    aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    aria-pressed={theme === 'light'}
  >{theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
  <button
    type="button"
    aria-pressed={compressWebp}
    onclick={ontogglewebp}
    title={compressionFormat === 'webp'
      ? 'Compress new imports to WebP (max 2400px) on this browser, or JPEG on iPhone/Safari'
      : 'Compress new imports to JPEG (max 2400px) on Safari/iPhone; desktop and Android browsers encode WebP'}
  >Compression: {compressWebp ? 'On' : 'Off'} ({compressionFormat.toUpperCase()})</button>
  <button type="button" aria-pressed={showHelp} onclick={() => { ontogglehelp(); closeSafely() }}>{showHelp ? 'Back to library' : 'How to use'}</button>
  <button type="button" class="side-menu-account" onclick={() => { blurIfInsideMenu(); onopenaccount() }}>
    {#if accountSession}
      <span>Account & storage</span>
      <small>
        {accountSession.user.email}{#if syncState && syncState.phase !== 'unavailable'} · {formatStorageBytes(syncState.usedBytes)} / {formatStorageBytes(syncState.quotaBytes)}{/if}
      </small>
    {:else}
      <span>Sign in & cloud storage</span>
      <small>100 MB free sync</small>
    {/if}
  </button>
  <button type="button" onclick={() => { onopentagmanager(); closeSafely() }}>Tag manager</button>
  <button type="button" onclick={() => { onbackup(); closeSafely() }} title="Download a ZIP copy of your library to this device">Backup</button>
  <button type="button" onclick={() => { onrestore(); closeSafely() }} title="Merge a Crop backup into this library">Restore</button>
  <a class="support-link" href="https://notgalerie.com/" target="_blank" rel="noopener noreferrer">Notgalerie</a>
  <a class="support-link" href={feedbackUrl} target="_blank" rel="noopener noreferrer">Feedback</a>
  <a class="support-link" href="https://ko-fi.com/not1618033" target="_blank" rel="noopener noreferrer">Coffee</a>
</aside>

<script lang="ts">
  import { formatStorageBytes } from './sync-protocol'
  import type { SyncSnapshot } from './sync'

  type Props = {
    menuOpen: boolean
    theme: 'dark' | 'light'
    compressWebp: boolean
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

  function onMenuKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onclose()
  }
</script>

{#if menuOpen}
  <button class="menu-backdrop" type="button" aria-label="Close menu" onclick={onclose} onkeydown={onMenuKeydown}></button>
{/if}
<aside id="side-menu" class:open={menuOpen} class="side-menu" aria-label="Main menu" aria-hidden={!menuOpen} inert={!menuOpen}>
  <div class="side-menu-heading"><strong>MENU</strong><button type="button" onclick={onclose} aria-label="Close menu">×</button></div>
  <button
    class="theme-toggle"
    onclick={() => { ontoggletheme(); onclose() }}
    aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    aria-pressed={theme === 'light'}
  >{theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
  <button
    type="button"
    aria-pressed={compressWebp}
    onclick={ontogglewebp}
    title="Re-encode new imports to high-quality WebP (max 2400px) to fit 4–5x more drawings in 100 MB"
  >WebP compression: {compressWebp ? 'On' : 'Off'}</button>
  <button type="button" aria-pressed={showHelp} onclick={() => { ontogglehelp(); onclose() }}>{showHelp ? 'Back to library' : 'How to use'}</button>
  <button type="button" class="side-menu-account" onclick={onopenaccount}>
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
  <button type="button" onclick={() => { onopentagmanager(); onclose() }}>Tag manager</button>
  <button type="button" onclick={() => { onbackup(); onclose() }} title="Download a ZIP copy of your library to this device">Backup</button>
  <button type="button" onclick={() => { onrestore(); onclose() }} title="Merge a Crop backup into this library">Restore</button>
  <a class="support-link" href={feedbackUrl} target="_blank" rel="noopener noreferrer">Feedback</a>
  <a class="support-link" href="https://ko-fi.com/not1618033" target="_blank" rel="noopener noreferrer">Coffee</a>
</aside>

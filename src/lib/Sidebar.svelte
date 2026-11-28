<script lang="ts">
  import { formatStorageBytes } from './sync-protocol'
  import type { SyncSnapshot } from './sync'
  import { getLocale, LOCALE_LABELS, setLocale, SUPPORTED_LOCALES, t, type Locale } from './i18n.svelte'

  type Props = {
    menuOpen: boolean
    compressWebp: boolean
    compressionFormat: 'webp' | 'jpeg'
    showHelp: boolean
    accountSession: { user: { email: string; name: string } } | null
    syncState: SyncSnapshot | null
    feedbackUrl: string
    onclose: () => void
    ontogglewebp: () => void
    ontogglehelp: () => void
    onopenaccount: () => void
    onopentagmanager: () => void
    onbackup: () => void
    onrestore: () => void
  }

  let {
    menuOpen,
    compressWebp,
    compressionFormat,
    showHelp,
    accountSession,
    syncState,
    feedbackUrl,
    onclose,
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
  <button class="menu-backdrop" type="button" aria-label={t('menu.close')} onclick={closeSafely} onkeydown={onMenuKeydown}></button>
{/if}
<aside id="side-menu" class:open={menuOpen} class="side-menu" aria-label={t('menu.mainAria')} aria-hidden={!menuOpen} inert={!menuOpen}>
  <div class="side-menu-heading"><strong>{t('menu.title')}</strong><button type="button" onclick={closeSafely} aria-label={t('menu.close')}>×</button></div>
  <label class="side-menu-lang">
    <span>{t('menu.language')}</span>
    <select
      aria-label={t('menu.language')}
      value={getLocale()}
      onchange={(event) => setLocale(event.currentTarget.value as Locale)}
    >
      {#each SUPPORTED_LOCALES as loc (loc)}
        <option value={loc}>{LOCALE_LABELS[loc]}</option>
      {/each}
    </select>
  </label>
  <button
    type="button"
    aria-pressed={compressWebp}
    onclick={ontogglewebp}
    title={compressionFormat === 'webp' ? t('menu.compressionTitleWebp') : t('menu.compressionTitleJpeg')}
  >{t('menu.compression', { state: compressWebp ? t('menu.on') : t('menu.off'), format: compressionFormat.toUpperCase() })}</button>
  <button type="button" aria-pressed={showHelp} onclick={() => { ontogglehelp(); closeSafely() }}>{showHelp ? t('menu.backToLibrary') : t('menu.howToUse')}</button>
  <button type="button" class="side-menu-account" onclick={() => { blurIfInsideMenu(); onopenaccount() }}>
    {#if accountSession}
      <span>{t('menu.accountStorage')}</span>
      <small>
        {accountSession.user.email}{#if syncState && syncState.phase !== 'unavailable'} · {formatStorageBytes(syncState.usedBytes)} / {formatStorageBytes(syncState.quotaBytes)}{/if}
      </small>
    {:else}
      <span>{t('menu.signInSync')}</span>
      <small>{t('menu.freeSync')}</small>
    {/if}
  </button>
  <button type="button" onclick={() => { onopentagmanager(); closeSafely() }}>{t('menu.tagManager')}</button>
  <button type="button" onclick={() => { onbackup(); closeSafely() }} title={t('menu.backupTitle')}>{t('menu.backup')}</button>
  <button type="button" onclick={() => { onrestore(); closeSafely() }} title={t('menu.restoreTitle')}>{t('menu.restore')}</button>
  <a class="support-link" href="https://notgalerie.com/" target="_blank" rel="noopener noreferrer">Notgalerie</a>
  <a class="support-link" href={feedbackUrl} target="_blank" rel="noopener noreferrer">{t('menu.feedback')}</a>
  <a class="support-link" href="https://ko-fi.com/not1618033" target="_blank" rel="noopener noreferrer">{t('menu.coffee')}</a>
</aside>

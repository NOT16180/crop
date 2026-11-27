<script lang="ts">
  import { tick } from 'svelte'
  import { authClient } from './auth-client'
  import { formatStorageBytes } from './sync-protocol'
  import type { SyncSnapshot } from './sync'

  type Props = {
    open: boolean
    session: { user: { id: string; email: string; name: string } } | null
    syncState: SyncSnapshot | null
    compressWebp: boolean
    drawingCount: number
    initialMessage?: string
    onclose: () => void
    onsignout: () => Promise<boolean>
    ondeleteaccount: () => Promise<boolean>
    onsyncnow: (mode?: 'merge' | 'replace') => Promise<void>
    ontogglewebp: () => void
    oncompressexisting: (onProgress: (done: number, total: number) => void) => Promise<{ total: number; compressedCount: number; savedBytes: number }>
  }

  let {
    open,
    session,
    syncState,
    compressWebp,
    drawingCount,
    initialMessage = '',
    onclose,
    onsignout,
    ondeleteaccount,
    onsyncnow,
    ontogglewebp,
    oncompressexisting,
  }: Props = $props()

  let email = $state('')
  let message = $state('')
  let busy = $state(false)
  let confirmDelete = $state(false)
  let compressProgress = $state('')
  let emailInput = $state<HTMLInputElement | null>(null)
  let signOutButton = $state<HTMLButtonElement | null>(null)
  let closeButton = $state<HTMLButtonElement | null>(null)

  let quotaPercent = $derived.by(() => {
    if (!syncState || syncState.quotaBytes <= 0) return 0
    return Math.min(100, Math.round((syncState.usedBytes / syncState.quotaBytes) * 100))
  })

  let syncStatusLabel = $derived.by(() => {
    if (!syncState) return ''
    switch (syncState.phase) {
      case 'syncing':
        return 'Syncing…'
      case 'synced':
        return syncState.lastSyncAt
          ? `Synced · ${new Date(syncState.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : 'Synced'
      case 'offline':
        return syncState.pendingCount > 0
          ? `Offline · ${syncState.pendingCount} change${syncState.pendingCount === 1 ? '' : 's'} waiting`
          : 'Offline'
      case 'quota_full':
        return 'Cloud storage full'
      case 'unavailable':
        return 'Cloud sync pending server storage setup'
      case 'account_mismatch':
        return 'Different account previously synced on this device'
      case 'error':
        return syncState.errorMessage || 'Sync failed'
      default:
        return syncState.pendingCount > 0
          ? `${syncState.pendingCount} change${syncState.pendingCount === 1 ? '' : 's'} pending`
          : 'Ready to sync'
    }
  })

  $effect(() => {
    if (open) {
      message = initialMessage
      busy = false
      confirmDelete = false
      void tick().then(() => {
        if (session) signOutButton?.focus()
        else (emailInput ?? closeButton)?.focus()
      })
    } else {
      message = ''
      busy = false
      confirmDelete = false
    }
  })

  async function handleSendSignInLink(event: SubmitEvent) {
    event.preventDefault()
    if (!email.trim() || busy) return
    busy = true
    message = ''
    try {
      const { error: signInError } = await authClient.signIn.magicLink({
        email: email.trim(),
        callbackURL: window.location.origin,
      })
      message = signInError
        ? 'Could not send the link. Please try again later.'
        : 'If this address can receive a sign-in link, it will arrive shortly.'
    } catch {
      message = 'Account sign-in is not available right now.'
    } finally {
      busy = false
    }
  }

  async function handleSignOut() {
    if (busy) return
    busy = true
    message = ''
    confirmDelete = false
    try {
      const ok = await onsignout()
      message = ok
        ? 'You are signed out. Your library stays on this device.'
        : 'Could not sign out right now. Please try again.'
    } catch {
      message = 'Could not sign out right now. Please try again.'
    } finally {
      busy = false
    }
  }

  async function handleDeleteAccount() {
    if (busy) return
    busy = true
    message = ''
    try {
      const ok = await ondeleteaccount()
      if (ok) {
        confirmDelete = false
        message = 'Account and cloud data permanently deleted. Your local library stays on this device.'
      } else {
        message = 'Could not delete your account right now. Please try again.'
      }
    } catch {
      message = 'Could not delete your account right now. Please try again.'
    } finally {
      busy = false
    }
  }

  async function handleSync(mode?: 'merge' | 'replace') {
    if (busy || syncState?.phase === 'syncing') return
    message = ''
    await onsyncnow(mode)
  }

  async function handleCompressExisting() {
    if (busy || syncState?.phase === 'syncing' || drawingCount === 0) return
    busy = true
    message = ''
    compressProgress = `0 / ${drawingCount}`
    try {
      const result = await oncompressexisting((done, total) => {
        compressProgress = `${done} / ${total}`
      })
      if (result.compressedCount > 0) {
        message = `Compressed ${result.compressedCount} of ${result.total} drawings to WebP (saved ${formatStorageBytes(result.savedBytes)}).`
      } else {
        message = 'All existing drawings are already compact.'
      }
    } catch {
      message = 'Could not compress existing drawings.'
    } finally {
      compressProgress = ''
      busy = false
    }
  }
</script>

{#if open}
  <div class="account-layer">
    <button class="account-scrim" type="button" aria-label="Close account" onclick={onclose}></button>
    <dialog open class="account-dialog" aria-modal="true" aria-labelledby="account-title">
      <div class="account-heading">
        <h2 id="account-title">CROP ACCOUNT</h2>
        <button bind:this={closeButton} type="button" aria-label="Close account" onclick={onclose}>×</button>
      </div>
      {#if session}
        <p>Signed in as <strong>{session.user.email}</strong></p>

        {#if syncState}
          <div class="account-sync">
            <div class="account-sync-row">
              <span class="account-sync-label">CLOUD SYNC</span>
              <span class="account-sync-status">{syncStatusLabel}</span>
            </div>

            {#if syncState.phase !== 'unavailable'}
              <div class="account-quota" aria-label="Cloud storage usage">
                <div class="account-quota-bar">
                  <div class="account-quota-fill" style:width={`${quotaPercent}%`}></div>
                </div>
                <small>{formatStorageBytes(syncState.usedBytes)} / {formatStorageBytes(syncState.quotaBytes)}</small>
              </div>
            {/if}

            <label class="account-option">
              <input type="checkbox" checked={compressWebp} onchange={ontogglewebp} />
              <span>Compress new imports to WebP (max 2400px) to fit 4–5× more drawings in 100 MB</span>
            </label>
            {#if drawingCount > 0}
              <button
                type="button"
                class="account-secondary-btn"
                disabled={busy || syncState?.phase === 'syncing'}
                onclick={handleCompressExisting}
              >
                {compressProgress ? `Compressing (${compressProgress})…` : `Compress existing library (${drawingCount})`}
              </button>
            {/if}

            {#if syncState.quotaBlockedCount > 0}
              <p class="account-sync-warning" role="status">
                {syncState.quotaBlockedCount} drawing{syncState.quotaBlockedCount === 1 ? '' : 's'} kept local only — cloud storage is full. Delete drawings to free cloud space; local work and Backup/Restore remain unlimited.
              </p>
            {/if}

            {#if syncState.tooLargeCount > 0}
              <p class="account-sync-warning" role="status">
                {syncState.tooLargeCount} drawing{syncState.tooLargeCount === 1 ? '' : 's'} exceed{syncState.tooLargeCount === 1 ? 's' : ''} the 20 MB per-image cloud limit and stay local only.
              </p>
            {/if}

            {#if syncState.phase === 'account_mismatch'}
              <p class="account-sync-warning" role="status">
                This device was previously synced with <strong>{syncState.previousAccountEmail}</strong>. Merge the local library into this account, or replace it with this account’s cloud library?
              </p>
              <div class="account-actions">
                <button type="button" onclick={() => handleSync('merge')}>Merge local</button>
                <button type="button" onclick={() => handleSync('replace')}>Replace with cloud</button>
              </div>
            {/if}
          </div>
        {/if}

        <div class="account-actions">
          {#if syncState?.phase !== 'account_mismatch'}
            <button type="button" disabled={busy || syncState?.phase === 'syncing'} onclick={() => handleSync()}>
              {syncState?.phase === 'syncing' ? 'Syncing…' : 'Sync now'}
            </button>
          {/if}
          <button bind:this={signOutButton} type="button" disabled={busy} onclick={handleSignOut}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>

        <div class="account-danger">
          {#if confirmDelete}
            <p class="account-sync-warning">
              <strong>Delete your account permanently?</strong> All cloud copies (folders, drawings, images, and sessions) will be erased from Cloudflare. Your local library on this device stays untouched.
            </p>
            <div class="account-actions">
              <button type="button" class="danger-btn" disabled={busy} onclick={handleDeleteAccount}>
                {busy ? 'Deleting…' : 'Confirm permanent deletion'}
              </button>
              <button type="button" disabled={busy} onclick={() => (confirmDelete = false)}>Cancel</button>
            </div>
          {:else}
            <button type="button" class="danger-link" disabled={busy} onclick={() => (confirmDelete = true)}>
              Delete account & cloud data
            </button>
          {/if}
        </div>
      {:else}
        <p>Sign in with an email link. No password needed. Your library works offline and syncs across devices when signed in.</p>
        <form class="account-form" onsubmit={handleSendSignInLink}>
          <label for="account-email">Email address</label>
          <input bind:this={emailInput} id="account-email" type="email" autocomplete="email" bind:value={email} required />
          <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send sign-in link'}</button>
        </form>
      {/if}
      <p class="account-privacy">No ads, no tracking, no AI training. Cloud storage is used solely to sync your library and can be deleted anytime.</p>
      {#if message}<p class="account-message" role="status">{message}</p>{/if}
    </dialog>
  </div>
{/if}

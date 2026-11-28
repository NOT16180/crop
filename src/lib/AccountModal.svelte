<script lang="ts">
  import { tick } from 'svelte'
  import { authClient } from './auth-client'
  import { formatStorageBytes } from './sync-protocol'
  import type { SyncSnapshot } from './sync'
  import {
    openBillingPortal,
    startBillingCheckout,
    updateSubscriptionCancellation,
    type BillingInterval,
    type BillingStatus,
  } from './billing-client'
  import { t } from './i18n.svelte'

  type Props = {
    open: boolean
    session: { user: { id: string; email: string; name: string } } | null
    syncState: SyncSnapshot | null
    billingStatus: BillingStatus | null
    compressWebp: boolean
    compressionFormat: 'webp' | 'jpeg'
    drawingCount: number
    initialMessage?: string
    onclose: () => void
    onsignout: () => Promise<boolean>
    ondeleteaccount: () => Promise<boolean>
    onsyncnow: (mode?: 'merge' | 'replace') => Promise<void>
    onbillingchange: (status: BillingStatus) => void
    ontogglewebp: () => void
    oncompressexisting: (onProgress: (done: number, total: number) => void) => Promise<{ total: number; compressedCount: number; savedBytes: number; skippedCount: number; format: 'webp' | 'jpeg' }>
  }

  let {
    open,
    session,
    syncState,
    billingStatus,
    compressWebp,
    compressionFormat,
    drawingCount,
    initialMessage = '',
    onclose,
    onsignout,
    ondeleteaccount,
    onsyncnow,
    onbillingchange,
    ontogglewebp,
    oncompressexisting,
  }: Props = $props()

  let email = $state('')
  let message = $state('')
  let busy = $state(false)
  let billingBusy = $state<BillingInterval | 'portal' | 'cancel' | 'resume' | null>(null)
  let confirmCancelSub = $state(false)
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
        return t('account.statusSyncing')
      case 'synced':
        return syncState.lastSyncAt
          ? t('account.statusSyncedAt', { time: new Date(syncState.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
          : t('account.statusSynced')
      case 'offline':
        return syncState.pendingCount > 0
          ? t('account.statusOfflinePending', { count: syncState.pendingCount })
          : t('account.statusOffline')
      case 'quota_full':
        return t('account.statusQuotaFull')
      case 'unavailable':
        return t('account.statusUnavailable')
      case 'account_mismatch':
        return t('account.statusMismatch')
      case 'error':
        return syncState.errorMessage || t('account.statusFailed')
      default:
        return syncState.pendingCount > 0
          ? t('account.statusPending', { count: syncState.pendingCount })
          : t('account.statusReady')
    }
  })

  $effect(() => {
    if (open) {
      message = initialMessage
      busy = false
      confirmDelete = false
      confirmCancelSub = false
      void tick().then(() => {
        if (session) signOutButton?.focus()
        else (emailInput ?? closeButton)?.focus()
      })
    } else {
      message = ''
      busy = false
      confirmDelete = false
      confirmCancelSub = false
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
        ? t('account.msgSendError')
        : t('account.msgLinkSent')
    } catch {
      message = t('account.msgUnavailable')
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
        ? t('account.msgSignedOut')
        : t('account.msgSignOutError')
    } catch {
      message = t('account.msgSignOutError')
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
        message = t('account.msgDeleted')
      } else {
        message = t('account.msgDeleteError')
      }
    } catch {
      message = t('account.msgDeleteError')
    } finally {
      busy = false
    }
  }

  async function handleSync(mode?: 'merge' | 'replace') {
    if (busy || syncState?.phase === 'syncing') return
    message = ''
    await onsyncnow(mode)
  }

  async function handleUpgrade(plan: BillingInterval) {
    if (busy || billingBusy) return
    billingBusy = plan
    message = ''
    try {
      const checkoutUrl = await startBillingCheckout(plan)
      window.location.assign(checkoutUrl)
    } catch {
      message = t('billing.checkoutError')
      billingBusy = null
    }
  }

  async function handleManageSubscription() {
    if (busy || billingBusy) return
    billingBusy = 'portal'
    message = ''
    try {
      const portalUrl = await openBillingPortal()
      window.location.assign(portalUrl)
    } catch {
      message = t('billing.portalError')
      billingBusy = null
    }
  }

  async function handleSubscriptionCancelToggle(action: 'cancel' | 'resume') {
    if (busy || billingBusy) return
    billingBusy = action
    message = ''
    try {
      const result = await updateSubscriptionCancellation(action)
      if (result.fallbackPortalUrl) {
        window.location.assign(result.fallbackPortalUrl)
        return
      }
      if (result.status) {
        onbillingchange(result.status)
        confirmCancelSub = false
        message = action === 'cancel' ? t('billing.canceledMsg') : t('billing.resumedMsg')
      }
    } catch {
      message = t('billing.cancelError')
    } finally {
      billingBusy = null
    }
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
      const fmtLabel = result.format.toUpperCase()
      const skipped = result.skippedCount > 0
        ? t('account.msgSkipped', { count: result.skippedCount })
        : ''
      if (result.compressedCount > 0) {
        message = t('account.msgOptimized', {
          compressed: result.compressedCount,
          total: result.total,
          format: fmtLabel,
          saved: formatStorageBytes(result.savedBytes),
          skipped,
        })
      } else {
        message = t('account.msgAlreadyCompact', { format: fmtLabel, skipped })
      }
    } catch (cause) {
      console.error('Could not compress existing drawings', cause)
      const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : ''
      message = t('account.msgCompressError', { detail })
    } finally {
      compressProgress = ''
      busy = false
    }
  }
</script>

{#if open}
  <div class="account-layer">
    <button class="account-scrim" type="button" aria-label={t('account.close')} onclick={onclose}></button>
    <dialog open class="account-dialog" aria-modal="true" aria-labelledby="account-title">
      <div class="account-heading">
        <h2 id="account-title">{t('account.title')}</h2>
        <button bind:this={closeButton} type="button" aria-label={t('account.close')} onclick={onclose}>×</button>
      </div>
      {#if session}
        <p>{t('account.signedInAs', { email: session.user.email })}</p>

        {#if syncState}
          <div class="account-sync">
            <div class="account-sync-row">
              <span class="account-sync-label">{t('account.cloudSync')}</span>
              <span class="account-sync-status">{syncStatusLabel}</span>
            </div>

            {#if syncState.phase !== 'unavailable'}
              <div class="account-quota" aria-label={t('account.quotaAria')}>
                <div class="account-quota-bar">
                  <div class="account-quota-fill" style:width={`${quotaPercent}%`}></div>
                </div>
                <small>{formatStorageBytes(syncState.usedBytes)} / {formatStorageBytes(syncState.quotaBytes)}</small>
              </div>
            {/if}

            <label class="account-option">
              <input type="checkbox" checked={compressWebp} onchange={ontogglewebp} />
              <span>{compressionFormat === 'webp' ? t('account.compressWebpLabel') : t('account.compressJpegLabel')}</span>
            </label>
            <small class="account-hint">
              {compressionFormat === 'webp' ? t('account.compressWebpHint') : t('account.compressJpegHint')}
            </small>
            {#if drawingCount > 0}
              <button
                type="button"
                class="account-secondary-btn"
                disabled={busy || syncState?.phase === 'syncing'}
                onclick={handleCompressExisting}
              >
                {compressProgress ? t('account.compressing', { progress: compressProgress }) : t('account.compressExisting', { count: drawingCount })}
              </button>
            {/if}

            {#if syncState.quotaBlockedCount > 0}
              <p class="account-sync-warning" role="status">
                {t('account.quotaBlocked', { count: syncState.quotaBlockedCount })}
              </p>
            {/if}

            {#if syncState.tooLargeCount > 0}
              <p class="account-sync-warning" role="status">
                {t('account.tooLarge', { count: syncState.tooLargeCount })}
              </p>
            {/if}

            {#if syncState.phase === 'account_mismatch'}
              <p class="account-sync-warning" role="status">
                {t('account.mismatchPrompt', { email: syncState.previousAccountEmail ?? '' })}
              </p>
              <div class="account-actions">
                <button type="button" onclick={() => handleSync('merge')}>{t('account.mergeLocal')}</button>
                <button type="button" onclick={() => handleSync('replace')}>{t('account.replaceCloud')}</button>
              </div>
            {/if}
          </div>
        {/if}

        {#if billingStatus && billingStatus.enabled}
          <div class="account-billing">
            <div class="account-sync-row">
              <span class="account-sync-label">{t('billing.sectionLabel')}</span>
              <strong class="account-plan-badge" class:pro={billingStatus.plan === 'pro'}>
                {billingStatus.plan === 'pro' ? t('billing.planPro') : t('billing.planFree')}
              </strong>
            </div>

            {#if billingStatus.plan === 'pro'}
              {#if billingStatus.currentPeriodEnd}
                {@const formattedDate = new Date(billingStatus.currentPeriodEnd).toLocaleDateString()}
                <small class="account-hint">
                  {billingStatus.cancelAtPeriodEnd
                    ? t('billing.endsOn', { date: formattedDate })
                    : t('billing.renewsOn', { date: formattedDate })}
                </small>
              {/if}
              {#if confirmCancelSub}
                <p class="account-sync-warning">{t('billing.cancelConfirm')}</p>
                <div class="account-actions">
                  <button
                    type="button"
                    class="danger-btn"
                    disabled={busy || billingBusy !== null}
                    onclick={() => handleSubscriptionCancelToggle('cancel')}
                  >
                    {billingBusy === 'cancel' ? t('billing.canceling') : t('billing.confirmCancel')}
                  </button>
                  <button
                    type="button"
                    disabled={busy || billingBusy !== null}
                    onclick={() => (confirmCancelSub = false)}
                  >{t('billing.keepPro')}</button>
                </div>
              {:else}
                <div class="account-actions">
                  {#if billingStatus.cancelAtPeriodEnd}
                    <button
                      type="button"
                      class="add-image-button"
                      disabled={busy || billingBusy !== null}
                      onclick={() => handleSubscriptionCancelToggle('resume')}
                    >
                      {billingBusy === 'resume' ? t('billing.resuming') : t('billing.resumeSub')}
                    </button>
                  {:else}
                    <button
                      type="button"
                      disabled={busy || billingBusy !== null}
                      onclick={() => (confirmCancelSub = true)}
                    >{t('billing.cancelSub')}</button>
                  {/if}
                  {#if billingStatus.hasCustomerPortal}
                    <button
                      type="button"
                      disabled={busy || billingBusy !== null}
                      onclick={handleManageSubscription}
                    >
                      {billingBusy === 'portal' ? t('billing.openingPortal') : t('billing.manageSub')}
                    </button>
                  {/if}
                </div>
              {/if}
            {:else}
              <p class="account-billing-intro">{t('billing.upgradeTitle')}</p>
              <div class="account-billing-plans">
                {#if billingStatus.products.annual}
                  <button
                    type="button"
                    class="add-image-button"
                    disabled={busy || billingBusy !== null}
                    onclick={() => handleUpgrade('annual')}
                  >
                    {billingBusy === 'annual' ? t('billing.redirecting') : t('billing.proAnnual')}
                  </button>
                {/if}
                {#if billingStatus.products.monthly}
                  <button
                    type="button"
                    disabled={busy || billingBusy !== null}
                    onclick={() => handleUpgrade('monthly')}
                  >
                    {billingBusy === 'monthly' ? t('billing.redirecting') : t('billing.proMonthly')}
                  </button>
                {/if}
              </div>
              <small class="account-hint">{t('billing.secureNote')}</small>
            {/if}
          </div>
        {/if}

        <div class="account-actions">
          {#if syncState?.phase !== 'account_mismatch'}
            <button type="button" disabled={busy || syncState?.phase === 'syncing'} onclick={() => handleSync()}>
              {syncState?.phase === 'syncing' ? t('account.statusSyncing') : t('account.syncNow')}
            </button>
          {/if}
          <button bind:this={signOutButton} type="button" disabled={busy} onclick={handleSignOut}>
            {busy ? t('account.signingOut') : t('account.signOut')}
          </button>
        </div>
        <small class="account-hint">{t('account.signOutHint')}</small>

        <div class="account-danger">
          {#if confirmDelete}
            <p class="account-sync-warning">
              <strong>{t('account.deleteConfirmTitle')}</strong> {t('account.deleteConfirmBody')}
            </p>
            <div class="account-actions">
              <button type="button" class="danger-btn" disabled={busy} onclick={handleDeleteAccount}>
                {busy ? t('account.deleting') : t('account.confirmDelete')}
              </button>
              <button type="button" disabled={busy} onclick={() => (confirmDelete = false)}>{t('gallery.cancel')}</button>
            </div>
          {:else}
            <button type="button" class="danger-link" disabled={busy} onclick={() => (confirmDelete = true)}>
              {t('account.deleteAccount')}
            </button>
          {/if}
        </div>
      {:else}
        <p>{t('account.signInIntro')}</p>
        <form class="account-form" onsubmit={handleSendSignInLink}>
          <label for="account-email">{t('account.emailLabel')}</label>
          <input bind:this={emailInput} id="account-email" type="email" autocomplete="email" bind:value={email} required />
          <button type="submit" disabled={busy}>{busy ? t('account.sending') : t('account.sendLink')}</button>
        </form>
      {/if}
      <p class="account-privacy">{t('account.privacy')}</p>
      {#if message}<p class="account-message" role="status">{message}</p>{/if}
    </dialog>
  </div>
{/if}

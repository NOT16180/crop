<script lang="ts">
  import { authClient } from './auth-client'

  type Props = {
    open: boolean
    session: { user: { email: string; name: string } } | null
    onclose: () => void
    onsignout: () => Promise<void> | void
  }

  let { open, session, onclose, onsignout }: Props = $props()

  let email = $state('')
  let message = $state('')
  let busy = $state(false)

  async function handleSendSignInLink(event: SubmitEvent) {
    event.preventDefault()
    if (!email.trim()) return
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
    await onsignout()
    message = 'You are signed out.'
  }
</script>

{#if open}
  <div class="account-layer">
    <button class="account-scrim" type="button" aria-label="Close account" onclick={onclose}></button>
    <dialog open class="account-dialog" aria-modal="true" aria-labelledby="account-title">
      <div class="account-heading">
        <h2 id="account-title">CROP ACCOUNT</h2>
        <button type="button" aria-label="Close account" onclick={onclose}>×</button>
      </div>
      {#if session}
        <p>Signed in as <strong>{session.user.email}</strong></p>
        <button type="button" onclick={handleSignOut}>Sign out</button>
      {:else}
        <p>Sign in with an email link. No password needed. Your library remains on this device.</p>
        <form class="account-form" onsubmit={handleSendSignInLink}>
          <label for="account-email">Email address</label>
          <input id="account-email" type="email" autocomplete="email" bind:value={email} required />
          <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send sign-in link'}</button>
        </form>
      {/if}
      {#if message}<p class="account-message" role="status">{message}</p>{/if}
    </dialog>
  </div>
{/if}

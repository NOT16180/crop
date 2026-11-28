export type BillingPlan = 'free' | 'pro'
export type BillingInterval = 'monthly' | 'annual'

export interface BillingStatus {
  enabled: boolean
  plan: BillingPlan
  status: string
  quotaBytes: number
  currentPeriodEnd: number | null
  cancelAtPeriodEnd: boolean
  hasCustomerPortal: boolean
  products: {
    monthly: boolean
    annual: boolean
  }
}

export async function fetchBillingStatus(refresh = false): Promise<BillingStatus | null> {
  try {
    const response = await fetch(refresh ? '/api/billing/status?refresh=1' : '/api/billing/status', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return null
    return (await response.json()) as BillingStatus
  } catch {
    return null
  }
}

function isTrustedPolarUrl(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== 'string') return false
  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === 'https:' && (parsed.hostname === 'polar.sh' || parsed.hostname.endsWith('.polar.sh'))
  } catch {
    return false
  }
}

export async function startBillingCheckout(plan: BillingInterval): Promise<string> {
  const response = await fetch('/api/billing/checkout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ plan }),
  })
  const data = (await response.json().catch(() => null)) as { url?: string; error?: string } | null
  if (!response.ok || !isTrustedPolarUrl(data?.url)) {
    throw new Error(data?.error || 'Could not start checkout')
  }
  return data.url
}

export async function openBillingPortal(): Promise<string> {
  const response = await fetch('/api/billing/portal', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  const data = (await response.json().catch(() => null)) as { url?: string; error?: string } | null
  if (!response.ok || !isTrustedPolarUrl(data?.url)) {
    throw new Error(data?.error || 'Could not open customer portal')
  }
  return data.url
}

export async function updateSubscriptionCancellation(
  action: 'cancel' | 'resume',
): Promise<{ status?: BillingStatus; fallbackPortalUrl?: string }> {
  const response = await fetch(action === 'cancel' ? '/api/billing/cancel' : '/api/billing/resume', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  const data = (await response.json().catch(() => null)) as {
    status?: BillingStatus
    fallbackPortalUrl?: string
    error?: string
  } | null
  if (!response.ok) {
    throw new Error(data?.error || 'Could not update subscription')
  }
  if (data?.fallbackPortalUrl) {
    if (!isTrustedPolarUrl(data.fallbackPortalUrl)) {
      throw new Error('Invalid portal URL')
    }
    return { fallbackPortalUrl: data.fallbackPortalUrl }
  }
  if (!data?.status) {
    throw new Error('Could not update subscription')
  }
  return { status: data.status }
}

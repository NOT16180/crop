import { DEFAULT_QUOTA_BYTES, PRO_QUOTA_BYTES } from './sync-protocol.ts'
import type { D1DatabaseLike } from './sync-server.ts'

export type BillingPlan = 'free' | 'pro'
export type BillingInterval = 'monthly' | 'annual'

export interface BillingConfig {
  accessToken?: string
  webhookSecret?: string
  monthlyProductId?: string
  annualProductId?: string
  apiBaseUrl?: string
  canonicalOrigin: string
}

export interface BillingStatusResponse {
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

interface UserSubscriptionRow {
  user_id: string
  polar_customer_id: string | null
  polar_subscription_id: string | null
  product_id: string | null
  plan: string
  status: string
  current_period_end: number | null
  cancel_at_period_end: number
  updated_at: number
}

interface PolarSubscriptionObject {
  id?: string
  status?: string
  product_id?: string | null
  product?: { id?: string | null } | null
  customer_id?: string | null
  customer?: {
    id?: string | null
    external_id?: string | null
    email?: string | null
  } | null
  metadata?: Record<string, unknown> | null
  current_period_end?: string | number | null
  cancel_at_period_end?: boolean | null
}

const DEFAULT_POLAR_API_BASE = 'https://api.polar.sh'
const WEBHOOK_TOLERANCE_SECONDS = 300

function jsonNoStore(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0)
  }
  return btoa(binary)
}

function base64ToBytes(encoded: string): Uint8Array | null {
  try {
    const binary = atob(encoded)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i)
    }
    return out
  } catch {
    return null
  }
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

async function computeHmacSha256Base64(keyBytes: Uint8Array, message: string): Promise<string> {
  const keyBuffer = keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message))
  return bytesToBase64(new Uint8Array(signature))
}

/**
 * Verify a Polar Standard Webhooks signature (webhook-id, webhook-timestamp, webhook-signature).
 * Polar signs using the literal UTF-8 bytes of the full webhook secret string; standard `whsec_`
 * base64-decoded secrets are also accepted if used.
 */
export async function verifyPolarWebhookSignature(params: {
  rawBody: string
  webhookId: string | null
  webhookTimestamp: string | null
  webhookSignature: string | null
  secret: string
  nowSeconds?: number
}): Promise<boolean> {
  const { rawBody, webhookId, webhookTimestamp, webhookSignature, secret } = params
  if (!webhookId || !webhookTimestamp || !webhookSignature || !secret) return false

  const ts = Number(webhookTimestamp)
  if (!Number.isInteger(ts) || ts <= 0) return false

  const nowSec = params.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_SECONDS) return false

  const candidateSignatures: string[] = []
  for (const token of webhookSignature.trim().split(/\s+/)) {
    const parts = token.split(',')
    if (parts.length >= 2 && parts[0] === 'v1' && parts[1]) {
      candidateSignatures.push(parts[1])
    }
  }
  if (candidateSignatures.length === 0) return false

  const signedPayload = `${webhookId}.${webhookTimestamp}.${rawBody}`
  const utf8Key = new TextEncoder().encode(secret)
  const expectedUtf8 = await computeHmacSha256Base64(utf8Key, signedPayload)
  if (candidateSignatures.some((sig) => timingSafeEqualStrings(sig, expectedUtf8))) {
    return true
  }

  if (secret.startsWith('whsec_')) {
    const decoded = base64ToBytes(secret.slice('whsec_'.length))
    if (decoded && decoded.length > 0) {
      const expectedDecoded = await computeHmacSha256Base64(decoded, signedPayload)
      if (candidateSignatures.some((sig) => timingSafeEqualStrings(sig, expectedDecoded))) {
        return true
      }
    }
  }

  return false
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000)
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function isConfiguredProProduct(productId: string | null, config: BillingConfig): boolean {
  const configured = [config.monthlyProductId, config.annualProductId].filter(
    (id): id is string => typeof id === 'string' && id.trim().length > 0,
  )
  if (configured.length === 0) return true
  return productId !== null && configured.includes(productId)
}

function isEntitledProStatus(eventType: string, status: string): boolean {
  if (eventType === 'subscription.revoked') return false
  if (eventType === 'subscription.active') return true
  const normalized = status.trim().toLowerCase()
  return normalized === 'active' || normalized === 'trialing'
}

async function resolveCropUserId(
  db: D1DatabaseLike,
  sub: PolarSubscriptionObject,
): Promise<string | null> {
  const externalId =
    (typeof sub.customer?.external_id === 'string' && sub.customer.external_id.trim()) ||
    (typeof sub.metadata?.user_id === 'string' && sub.metadata.user_id.trim()) ||
    null

  if (externalId) {
    const row = await db
      .prepare('SELECT id FROM user WHERE id = ?')
      .bind(externalId)
      .first<{ id: string }>()
    if (row?.id) return row.id
  }

  if (typeof sub.id === 'string' && sub.id.trim()) {
    const row = await db
      .prepare('SELECT user_id FROM user_subscription WHERE polar_subscription_id = ?')
      .bind(sub.id.trim())
      .first<{ user_id: string }>()
    if (row?.user_id) return row.user_id
  }

  const polarCustomerId =
    (typeof sub.customer_id === 'string' && sub.customer_id.trim()) ||
    (typeof sub.customer?.id === 'string' && sub.customer.id.trim()) ||
    null
  if (polarCustomerId) {
    const row = await db
      .prepare('SELECT user_id FROM user_subscription WHERE polar_customer_id = ?')
      .bind(polarCustomerId)
      .first<{ user_id: string }>()
    if (row?.user_id) return row.user_id
  }

  const email = typeof sub.customer?.email === 'string' ? sub.customer.email.trim() : ''
  if (email) {
    const row = await db
      .prepare('SELECT id FROM user WHERE lower(email) = lower(?)')
      .bind(email)
      .first<{ id: string }>()
    if (row?.id) return row.id
  }

  return null
}

async function applySubscriptionToUser(params: {
  db: D1DatabaseLike
  userId: string
  eventType: string
  sub: PolarSubscriptionObject
  config: BillingConfig
  now: number
}): Promise<{ plan: BillingPlan; quotaBytes: number; status: string }> {
  const { db, userId, eventType, sub, config, now } = params
  const productId =
    (typeof sub.product_id === 'string' && sub.product_id.trim()) ||
    (typeof sub.product?.id === 'string' && sub.product.id.trim()) ||
    null
  const polarCustomerId =
    (typeof sub.customer_id === 'string' && sub.customer_id.trim()) ||
    (typeof sub.customer?.id === 'string' && sub.customer.id.trim()) ||
    null
  const polarSubId = typeof sub.id === 'string' && sub.id.trim() ? sub.id.trim() : null
  const rawStatus =
    typeof sub.status === 'string' && sub.status.trim()
      ? sub.status.trim().toLowerCase()
      : eventType === 'subscription.revoked'
        ? 'revoked'
        : eventType === 'subscription.active'
          ? 'active'
          : 'unknown'

  const isPro = isEntitledProStatus(eventType, rawStatus) && isConfiguredProProduct(productId, config)
  const plan: BillingPlan = isPro ? 'pro' : 'free'
  const quotaBytes = isPro ? PRO_QUOTA_BYTES : DEFAULT_QUOTA_BYTES
  const currentPeriodEnd = parseTimestampMs(sub.current_period_end)
  const cancelAtPeriodEnd = sub.cancel_at_period_end || eventType === 'subscription.canceled' ? 1 : 0

  await db
    .prepare(
      `INSERT INTO user_subscription (
         user_id, polar_customer_id, polar_subscription_id, product_id,
         plan, status, current_period_end, cancel_at_period_end, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         polar_customer_id = COALESCE(excluded.polar_customer_id, user_subscription.polar_customer_id),
         polar_subscription_id = COALESCE(excluded.polar_subscription_id, user_subscription.polar_subscription_id),
         product_id = COALESCE(excluded.product_id, user_subscription.product_id),
         plan = excluded.plan,
         status = excluded.status,
         current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end,
         updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      polarCustomerId,
      polarSubId,
      productId,
      plan,
      rawStatus,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      now,
    )
    .run()

  await db
    .prepare(
      `INSERT INTO user_storage (user_id, used_bytes, quota_bytes, sync_seq, updated_at)
       VALUES (?, 0, ?, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         quota_bytes = excluded.quota_bytes,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, quotaBytes, now)
    .run()

  return { plan, quotaBytes, status: rawStatus }
}

export async function handlePolarWebhook(
  request: Request,
  deps: {
    db: D1DatabaseLike
    config: BillingConfig
    now?: () => number
  },
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonNoStore({ error: 'Method not allowed' }, 405)
  }
  if (!deps.config.webhookSecret) {
    return jsonNoStore({ error: 'Billing webhook is not configured' }, 503)
  }

  const rawBody = await request.text()
  const nowMs = (deps.now ?? Date.now)()
  const valid = await verifyPolarWebhookSignature({
    rawBody,
    webhookId: request.headers.get('webhook-id'),
    webhookTimestamp: request.headers.get('webhook-timestamp'),
    webhookSignature: request.headers.get('webhook-signature'),
    secret: deps.config.webhookSecret,
    nowSeconds: Math.floor(nowMs / 1000),
  })
  if (!valid) {
    return jsonNoStore({ error: 'Invalid webhook signature', code: 'INVALID_SIGNATURE' }, 403)
  }

  let payload: { type?: string; data?: PolarSubscriptionObject }
  try {
    payload = JSON.parse(rawBody) as { type?: string; data?: PolarSubscriptionObject }
  } catch {
    return jsonNoStore({ error: 'Invalid JSON payload' }, 400)
  }

  const eventType = typeof payload.type === 'string' ? payload.type : ''
  const handledTypes = new Set([
    'subscription.active',
    'subscription.updated',
    'subscription.canceled',
    'subscription.revoked',
  ])
  if (!handledTypes.has(eventType) || !payload.data || typeof payload.data !== 'object') {
    return jsonNoStore({ ok: true, ignored: eventType || 'unsupported' }, 200)
  }

  const userId = await resolveCropUserId(deps.db, payload.data)
  if (!userId) {
    return jsonNoStore({ ok: true, ignored: 'unknown_user' }, 200)
  }

  const updated = await applySubscriptionToUser({
    db: deps.db,
    userId,
    eventType,
    sub: payload.data,
    config: deps.config,
    now: nowMs,
  })

  return jsonNoStore({ ok: true, ...updated }, 200)
}

async function refreshSubscriptionFromPolar(params: {
  db: D1DatabaseLike
  userId: string
  config: BillingConfig
  fetchFn: typeof fetch
  now: number
}): Promise<void> {
  const { db, userId, config, fetchFn, now } = params
  if (!config.accessToken) return

  const base = (config.apiBaseUrl ?? DEFAULT_POLAR_API_BASE).replace(/\/$/, '')
  const url = `${base}/v1/subscriptions/?external_customer_id=${encodeURIComponent(userId)}&limit=10`
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      Accept: 'application/json',
    },
  })
  if (!response.ok) return

  const body = (await response.json().catch(() => null)) as { items?: PolarSubscriptionObject[] } | null
  const items = Array.isArray(body?.items) ? body.items : []
  const activeSub = items.find((item) => {
    const status = String(item.status ?? '').toLowerCase()
    const productId = item.product_id ?? item.product?.id ?? null
    return (status === 'active' || status === 'trialing') && isConfiguredProProduct(productId, config)
  })
  const target = activeSub ?? items[0]
  if (!target) return

  await applySubscriptionToUser({
    db,
    userId,
    eventType: activeSub ? 'subscription.active' : 'subscription.updated',
    sub: target,
    config,
    now,
  })
}

export async function handleBillingRequest(
  request: Request,
  deps: {
    db: D1DatabaseLike
    userId: string
    userEmail: string
    config: BillingConfig
    fetchFn?: typeof fetch
    now?: () => number
  },
): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const fetchFn = deps.fetchFn ?? fetch
  const now = (deps.now ?? Date.now)()
  const apiBase = (deps.config.apiBaseUrl ?? DEFAULT_POLAR_API_BASE).replace(/\/$/, '')
  const monthlyConfigured = Boolean(deps.config.monthlyProductId?.trim())
  const annualConfigured = Boolean(deps.config.annualProductId?.trim())
  const enabled = Boolean(deps.config.accessToken?.trim()) && (monthlyConfigured || annualConfigured)

  if (path === '/api/billing/status' && request.method === 'GET') {
    if (enabled && url.searchParams.get('refresh') === '1') {
      try {
        await refreshSubscriptionFromPolar({
          db: deps.db,
          userId: deps.userId,
          config: deps.config,
          fetchFn,
          now,
        })
      } catch {
        // Keep returning cached D1 state if Polar API is momentarily unreachable.
      }
    }

    const subRow = await deps.db
      .prepare(
        `SELECT user_id, polar_customer_id, polar_subscription_id, product_id,
                plan, status, current_period_end, cancel_at_period_end, updated_at
         FROM user_subscription WHERE user_id = ?`,
      )
      .bind(deps.userId)
      .first<UserSubscriptionRow>()

    const storageRow = await deps.db
      .prepare('SELECT quota_bytes FROM user_storage WHERE user_id = ?')
      .bind(deps.userId)
      .first<{ quota_bytes: number }>()

    const quotaBytes = Number(storageRow?.quota_bytes ?? DEFAULT_QUOTA_BYTES)
    const plan: BillingPlan = subRow?.plan === 'pro' || quotaBytes >= PRO_QUOTA_BYTES ? 'pro' : 'free'

    const body: BillingStatusResponse = {
      enabled,
      plan,
      status: subRow?.status ?? (plan === 'pro' ? 'active' : 'none'),
      quotaBytes,
      currentPeriodEnd: subRow?.current_period_end ? Number(subRow.current_period_end) : null,
      cancelAtPeriodEnd: Boolean(subRow?.cancel_at_period_end),
      hasCustomerPortal: Boolean(enabled && (subRow?.polar_customer_id || plan === 'pro')),
      products: {
        monthly: monthlyConfigured,
        annual: annualConfigured,
      },
    }
    return jsonNoStore(body)
  }

  if (path === '/api/billing/checkout' && request.method === 'POST') {
    if (!enabled || !deps.config.accessToken) {
      return jsonNoStore({ error: 'Billing is not configured yet', code: 'BILLING_NOT_CONFIGURED' }, 503)
    }

    let payload: { plan?: string }
    try {
      payload = (await request.json()) as { plan?: string }
    } catch {
      return jsonNoStore({ error: 'Invalid JSON body', code: 'INVALID_PAYLOAD' }, 400)
    }

    const interval = payload.plan === 'monthly' || payload.plan === 'annual' ? payload.plan : null
    if (!interval) {
      return jsonNoStore({ error: 'Invalid plan', code: 'INVALID_PAYLOAD' }, 400)
    }

    const productId = interval === 'annual' ? deps.config.annualProductId : deps.config.monthlyProductId
    if (!productId) {
      return jsonNoStore({ error: 'Selected plan is unavailable', code: 'PLAN_UNAVAILABLE' }, 404)
    }

    const polarRes = await fetchFn(`${apiBase}/v1/checkouts/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.config.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        products: [productId],
        external_customer_id: deps.userId,
        customer_email: deps.userEmail,
        metadata: {
          user_id: deps.userId,
          plan: interval,
        },
        success_url: `${deps.config.canonicalOrigin}/?checkout=success`,
      }),
    })

    if (!polarRes.ok) {
      return jsonNoStore({ error: 'Could not start checkout session', code: 'CHECKOUT_FAILED' }, 502)
    }

    const checkout = (await polarRes.json().catch(() => null)) as { url?: string } | null
    if (!checkout?.url) {
      return jsonNoStore({ error: 'Invalid checkout response', code: 'CHECKOUT_FAILED' }, 502)
    }

    return jsonNoStore({ url: checkout.url })
  }

  if (path === '/api/billing/portal' && request.method === 'POST') {
    if (!enabled || !deps.config.accessToken) {
      return jsonNoStore({ error: 'Billing is not configured yet', code: 'BILLING_NOT_CONFIGURED' }, 503)
    }

    const subRow = await deps.db
      .prepare('SELECT polar_customer_id FROM user_subscription WHERE user_id = ?')
      .bind(deps.userId)
      .first<{ polar_customer_id: string | null }>()

    const portalPayload = subRow?.polar_customer_id
      ? { customer_id: subRow.polar_customer_id }
      : { external_customer_id: deps.userId }

    const polarRes = await fetchFn(`${apiBase}/v1/customer-sessions/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.config.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(portalPayload),
    })

    if (!polarRes.ok) {
      return jsonNoStore({ error: 'Could not open customer portal', code: 'PORTAL_FAILED' }, 502)
    }

    const session = (await polarRes.json().catch(() => null)) as { customer_portal_url?: string } | null
    if (!session?.customer_portal_url) {
      return jsonNoStore({ error: 'Invalid portal response', code: 'PORTAL_FAILED' }, 502)
    }

    return jsonNoStore({ url: session.customer_portal_url })
  }

  return jsonNoStore({ error: 'Not found' }, 404)
}

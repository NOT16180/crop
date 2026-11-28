import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  handleBillingRequest,
  handlePolarWebhook,
  verifyPolarWebhookSignature,
} from '../src/lib/billing-server.ts'
import { DEFAULT_QUOTA_BYTES, formatStorageBytes, PRO_QUOTA_BYTES } from '../src/lib/sync-protocol.ts'

function createD1Adapter(sqlite) {
  return {
    prepare(sql) {
      let params = []
      const stmt = {
        bind(...values) {
          params = values
          return stmt
        },
        async first() {
          const row = sqlite.prepare(sql).get(...params)
          return row ?? null
        },
        async all() {
          const results = sqlite.prepare(sql).all(...params)
          return { results }
        },
        async run() {
          return sqlite.prepare(sql).run(...params)
        },
      }
      return stmt
    },
  }
}

function setupBillingDb() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  sqlite.exec(readFileSync(new URL('../migrations/0001_accounts.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../migrations/0003_library_sync.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../migrations/0004_billing.sql', import.meta.url), 'utf8'))
  sqlite
    .prepare("INSERT INTO user (id, name, email) VALUES ('user-1', 'Artist', 'artist@example.com')")
    .run()
  return { sqlite, db: createD1Adapter(sqlite) }
}

function signPolarWebhook(rawBody, secret, id = 'msg_123', timestamp = '1700000000') {
  const digest = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64')
  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${digest}`,
  }
}

const TEST_CONFIG = {
  accessToken: 'polar_oat_test_token',
  webhookSecret: 'polar_whs_test_secret_123456',
  monthlyProductId: 'prod-monthly',
  annualProductId: 'prod-annual',
  canonicalOrigin: 'https://crop.notgalerie.com',
}

test('formatStorageBytes renders 5 GiB cleanly as 5 GB', () => {
  assert.equal(formatStorageBytes(PRO_QUOTA_BYTES), '5 GB')
  assert.equal(formatStorageBytes(DEFAULT_QUOTA_BYTES), '100.0 MB')
})

test('verifyPolarWebhookSignature accepts valid Polar HMAC-SHA256 signatures and rejects tampered/expired ones', async () => {
  const body = JSON.stringify({ type: 'subscription.active', data: { id: 'sub_1' } })
  const headers = signPolarWebhook(body, TEST_CONFIG.webhookSecret, 'msg_1', '1700000000')

  const ok = await verifyPolarWebhookSignature({
    rawBody: body,
    webhookId: headers['webhook-id'],
    webhookTimestamp: headers['webhook-timestamp'],
    webhookSignature: headers['webhook-signature'],
    secret: TEST_CONFIG.webhookSecret,
    nowSeconds: 1700000010,
  })
  assert.equal(ok, true)

  const tampered = await verifyPolarWebhookSignature({
    rawBody: body + ' ',
    webhookId: headers['webhook-id'],
    webhookTimestamp: headers['webhook-timestamp'],
    webhookSignature: headers['webhook-signature'],
    secret: TEST_CONFIG.webhookSecret,
    nowSeconds: 1700000010,
  })
  assert.equal(tampered, false)

  const expired = await verifyPolarWebhookSignature({
    rawBody: body,
    webhookId: headers['webhook-id'],
    webhookTimestamp: headers['webhook-timestamp'],
    webhookSignature: headers['webhook-signature'],
    secret: TEST_CONFIG.webhookSecret,
    nowSeconds: 1700000600,
  })
  assert.equal(expired, false)
})

test('Polar webhook upgrades quota to 5 GB on active, preserves it on cancel-at-period-end, and downgrades to 100 MB on revoked', async () => {
  const { db } = setupBillingDb()
  const now = () => 1700000010 * 1000

  // 1. Reject unsigned webhook with 403
  const badRes = await handlePolarWebhook(
    new Request('https://crop.notgalerie.com/api/billing/webhook', {
      method: 'POST',
      body: JSON.stringify({ type: 'subscription.active', data: {} }),
    }),
    { db, config: TEST_CONFIG, now },
  )
  assert.equal(badRes.status, 403)

  // 2. Activate Pro Annual subscription
  const activeBody = JSON.stringify({
    type: 'subscription.active',
    data: {
      id: 'sub_abc',
      status: 'active',
      product_id: 'prod-annual',
      customer_id: 'cust_xyz',
      customer: { id: 'cust_xyz', external_id: 'user-1', email: 'artist@example.com' },
      current_period_end: '2027-11-28T00:00:00Z',
      cancel_at_period_end: false,
    },
  })
  const activeRes = await handlePolarWebhook(
    new Request('https://crop.notgalerie.com/api/billing/webhook', {
      method: 'POST',
      headers: signPolarWebhook(activeBody, TEST_CONFIG.webhookSecret, 'msg_2', '1700000000'),
      body: activeBody,
    }),
    { db, config: TEST_CONFIG, now },
  )
  assert.equal(activeRes.status, 200)

  const statusAfterActive = await handleBillingRequest(
    new Request('https://crop.notgalerie.com/api/billing/status'),
    { db, userId: 'user-1', userEmail: 'artist@example.com', config: TEST_CONFIG, now },
  )
  const activeJson = await statusAfterActive.json()
  assert.equal(activeJson.plan, 'pro')
  assert.equal(activeJson.quotaBytes, PRO_QUOTA_BYTES)
  assert.equal(activeJson.cancelAtPeriodEnd, false)

  // 3. Cancel at period end: user keeps 5 GB until period ends
  const cancelBody = JSON.stringify({
    type: 'subscription.canceled',
    data: {
      id: 'sub_abc',
      status: 'active',
      product_id: 'prod-annual',
      customer_id: 'cust_xyz',
      current_period_end: '2027-11-28T00:00:00Z',
      cancel_at_period_end: true,
    },
  })
  const cancelRes = await handlePolarWebhook(
    new Request('https://crop.notgalerie.com/api/billing/webhook', {
      method: 'POST',
      headers: signPolarWebhook(cancelBody, TEST_CONFIG.webhookSecret, 'msg_3', '1700000000'),
      body: cancelBody,
    }),
    { db, config: TEST_CONFIG, now },
  )
  assert.equal(cancelRes.status, 200)

  const statusAfterCancel = await handleBillingRequest(
    new Request('https://crop.notgalerie.com/api/billing/status'),
    { db, userId: 'user-1', userEmail: 'artist@example.com', config: TEST_CONFIG, now },
  )
  const cancelJson = await statusAfterCancel.json()
  assert.equal(cancelJson.plan, 'pro')
  assert.equal(cancelJson.quotaBytes, PRO_QUOTA_BYTES)
  assert.equal(cancelJson.cancelAtPeriodEnd, true)

  // 4. Revoked: downgrade cleanly back to 100 MB
  const revokedBody = JSON.stringify({
    type: 'subscription.revoked',
    data: {
      id: 'sub_abc',
      status: 'revoked',
      product_id: 'prod-annual',
      customer_id: 'cust_xyz',
    },
  })
  const revokedRes = await handlePolarWebhook(
    new Request('https://crop.notgalerie.com/api/billing/webhook', {
      method: 'POST',
      headers: signPolarWebhook(revokedBody, TEST_CONFIG.webhookSecret, 'msg_4', '1700000000'),
      body: revokedBody,
    }),
    { db, config: TEST_CONFIG, now },
  )
  assert.equal(revokedRes.status, 200)

  const statusAfterRevoke = await handleBillingRequest(
    new Request('https://crop.notgalerie.com/api/billing/status'),
    { db, userId: 'user-1', userEmail: 'artist@example.com', config: TEST_CONFIG, now },
  )
  const revokedJson = await statusAfterRevoke.json()
  assert.equal(revokedJson.plan, 'free')
  assert.equal(revokedJson.quotaBytes, DEFAULT_QUOTA_BYTES)
})

test('billing checkout and portal routes call Polar API with external_customer_id and return hosted URLs', async () => {
  const { db } = setupBillingDb()
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (String(url).endsWith('/v1/checkouts/')) {
      return Response.json({ url: 'https://checkout.polar.sh/session_123' })
    }
    if (String(url).endsWith('/v1/customer-sessions/')) {
      return Response.json({ customer_portal_url: 'https://polar.sh/portal/session_456' })
    }
    return new Response('Not found', { status: 404 })
  }

  const checkoutRes = await handleBillingRequest(
    new Request('https://crop.notgalerie.com/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'annual' }),
    }),
    { db, userId: 'user-1', userEmail: 'artist@example.com', config: TEST_CONFIG, fetchFn: fakeFetch },
  )
  assert.equal(checkoutRes.status, 200)
  const checkoutJson = await checkoutRes.json()
  assert.equal(checkoutJson.url, 'https://checkout.polar.sh/session_123')
  assert.deepEqual(calls[0].body.products, ['prod-annual'])
  assert.equal(calls[0].body.external_customer_id, 'user-1')

  const portalRes = await handleBillingRequest(
    new Request('https://crop.notgalerie.com/api/billing/portal', { method: 'POST' }),
    { db, userId: 'user-1', userEmail: 'artist@example.com', config: TEST_CONFIG, fetchFn: fakeFetch },
  )
  assert.equal(portalRes.status, 200)
  const portalJson = await portalRes.json()
  assert.equal(portalJson.url, 'https://polar.sh/portal/session_456')
  assert.equal(calls[1].body.external_customer_id, 'user-1')
})

test('1-click cancel and resume routes PATCH Polar subscription and keep 5 GB until period end', async () => {
  const { db } = setupBillingDb()
  const now = () => 1700000010 * 1000

  // Activate subscription first via webhook
  const activeBody = JSON.stringify({
    type: 'subscription.active',
    data: {
      id: 'sub_direct_1',
      status: 'active',
      product_id: 'prod-annual',
      customer_id: 'cust_direct_1',
      customer: { id: 'cust_direct_1', external_id: 'user-1', email: 'artist@example.com' },
      current_period_end: '2027-11-28T00:00:00Z',
    },
  })
  await handlePolarWebhook(
    new Request('https://crop.notgalerie.com/api/billing/webhook', {
      method: 'POST',
      headers: signPolarWebhook(activeBody, TEST_CONFIG.webhookSecret, 'msg_c1', '1700000000'),
      body: activeBody,
    }),
    { db, config: TEST_CONFIG, now },
  )

  const patchCalls = []
  const fakeFetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    patchCalls.push({ url: String(url), method: init?.method, body })
    return Response.json({
      id: 'sub_direct_1',
      status: 'active',
      cancel_at_period_end: body.cancel_at_period_end,
      current_period_end: '2027-11-28T00:00:00Z',
    })
  }

  // Cancel directly
  const cancelRes = await handleBillingRequest(
    new Request('https://crop.notgalerie.com/api/billing/cancel', { method: 'POST' }),
    { db, userId: 'user-1', userEmail: 'artist@example.com', config: TEST_CONFIG, fetchFn: fakeFetch, now },
  )
  assert.equal(cancelRes.status, 200)
  const cancelJson = await cancelRes.json()
  assert.equal(cancelJson.status.plan, 'pro')
  assert.equal(cancelJson.status.quotaBytes, PRO_QUOTA_BYTES)
  assert.equal(cancelJson.status.cancelAtPeriodEnd, true)
  assert.equal(patchCalls[0].method, 'PATCH')
  assert.equal(patchCalls[0].body.cancel_at_period_end, true)

  // Resume directly
  const resumeRes = await handleBillingRequest(
    new Request('https://crop.notgalerie.com/api/billing/resume', { method: 'POST' }),
    { db, userId: 'user-1', userEmail: 'artist@example.com', config: TEST_CONFIG, fetchFn: fakeFetch, now },
  )
  assert.equal(resumeRes.status, 200)
  const resumeJson = await resumeRes.json()
  assert.equal(resumeJson.status.cancelAtPeriodEnd, false)
  assert.equal(patchCalls[1].body.cancel_at_period_end, false)
})

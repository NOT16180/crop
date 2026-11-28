import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  isTrustedSameOriginRequest,
  resolveAuthBaseURL,
  withAuthSecurityHeaders,
} from '../src/lib/auth-config.ts'
import {
  handleBillingRequest,
  handlePolarWebhook,
  isAllowedPolarRedirectUrl,
  verifyPolarWebhookSignature,
} from '../src/lib/billing-server.ts'
import {
  createStreamingZip,
  extractStreamingZip,
  resolveRestoredImageMime,
} from '../src/lib/backup-archive.ts'
import { deleteUserAccountData, handleSyncRequest } from '../src/lib/sync-server.ts'
import {
  DEFAULT_QUOTA_BYTES,
  PRO_QUOTA_BYTES,
  detectImageMime,
  isValidSyncId,
} from '../src/lib/sync-protocol.ts'

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

function createMemoryR2() {
  const store = new Map()
  return {
    store,
    async put(key, value, options) {
      const bytes = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value)
      store.set(key, { bytes, contentType: options?.httpMetadata?.contentType })
    },
    async get(key) {
      const entry = store.get(key)
      if (!entry) return null
      return {
        body: entry.bytes,
        size: entry.bytes.byteLength,
        httpMetadata: { contentType: entry.contentType },
        async arrayBuffer() {
          return entry.bytes.slice().buffer
        },
      }
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        store.delete(key)
      }
    },
  }
}

function setupFullDb() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  sqlite.exec(readFileSync(new URL('../migrations/0001_accounts.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../migrations/0002_auth_rate_limit.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../migrations/0003_library_sync.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../migrations/0004_billing.sql', import.meta.url), 'utf8'))
  sqlite.prepare("INSERT INTO user (id, name, email) VALUES ('user-a', 'Alice', 'alice@example.com')").run()
  sqlite.prepare("INSERT INTO user (id, name, email) VALUES ('user-b', 'Bob', 'bob@example.com')").run()
  sqlite.prepare("INSERT INTO user (id, name, email) VALUES ('user-wild', 'Wild', 'a_b%c@example.com')").run()
  return { sqlite, db: createD1Adapter(sqlite), blobs: createMemoryR2() }
}

function makePng(size = 64) {
  const buf = new Uint8Array(size)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return buf
}

function signPolar(rawBody, secret, id = 'msg_sec', ts = '1700000000') {
  const digest = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${id}.${ts}.${rawBody}`)
    .digest('base64')
  return {
    'webhook-id': id,
    'webhook-timestamp': ts,
    'webhook-signature': `v1,${digest}`,
  }
}

const BILLING_CONFIG = {
  accessToken: 'polar_oat_sec_test',
  webhookSecret: 'polar_whs_sec_test_999',
  monthlyProductId: 'prod-monthly',
  annualProductId: 'prod-annual',
  canonicalOrigin: 'https://crop.notgalerie.com',
}

function walkFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

test('security: static scan confirms zero dangerous XSS/eval sinks in src/', () => {
  const srcDir = new URL('../src', import.meta.url).pathname
  const files = walkFiles(srcDir).filter((f) => /\.(svelte|ts|js)$/.test(f))
  assert.ok(files.length > 10)
  const forbidden = [/\{@html\b/, /\.innerHTML\b/, /\.outerHTML\b/, /document\.write\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/]
  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    for (const pattern of forbidden) {
      assert.equal(pattern.test(content), false, `Forbidden sink ${pattern} found in ${file}`)
    }
  }
})

test('security: public/_headers and API security headers enforce HSTS, strict CSP, and clickjacking defenses', () => {
  const headersFile = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
  assert.match(headersFile, /Strict-Transport-Security:\s*max-age=31536000;\s*includeSubDomains/)
  assert.match(headersFile, /X-Content-Type-Options:\s*nosniff/)
  assert.match(headersFile, /X-Frame-Options:\s*DENY/)
  assert.match(headersFile, /frame-ancestors 'none'/)
  assert.match(headersFile, /object-src 'none'/)
  assert.match(headersFile, /script-src 'self'/)
  assert.doesNotMatch(headersFile, /script-src[^;\n]*'unsafe-inline'/)
  assert.doesNotMatch(headersFile, /'unsafe-eval'/)

  const apiRes = withAuthSecurityHeaders(Response.json({ ok: true }))
  assert.equal(apiRes.headers.get('Strict-Transport-Security'), 'max-age=31536000; includeSubDomains')
  assert.equal(apiRes.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(apiRes.headers.get('X-Frame-Options'), 'DENY')
  assert.equal(apiRes.headers.get('Referrer-Policy'), 'no-referrer')
  assert.equal(apiRes.headers.get('Content-Security-Policy'), "default-src 'none'; frame-ancestors 'none'")
})

test('security: CSRF same-origin guard blocks cross-site, subdomain spoofs, null origin, downgrade, and browser cors without Origin', () => {
  const origin = 'https://crop.notgalerie.com'
  const cases = [
    [new Request(`${origin}/api/sync/push`, { method: 'POST', headers: { Origin: 'https://evil.example' } }), false],
    [new Request(`${origin}/api/sync/push`, { method: 'POST', headers: { Origin: 'https://crop.notgalerie.com.evil.example' } }), false],
    [new Request(`${origin}/api/sync/push`, { method: 'POST', headers: { Origin: 'http://crop.notgalerie.com' } }), false],
    [new Request(`${origin}/api/sync/push`, { method: 'POST', headers: { Origin: 'null' } }), false],
    [new Request(`${origin}/api/sync/push`, { method: 'DELETE', headers: { 'Sec-Fetch-Site': 'cross-site' } }), false],
    [new Request(`${origin}/api/sync/push`, { method: 'PUT', headers: { 'Sec-Fetch-Site': 'same-site', Origin: 'https://notgalerie.com' } }), false],
    [new Request(`${origin}/api/sync/push`, { method: 'POST', headers: { Referer: 'https://evil.example/phish' } }), false],
    [new Request(`${origin}/api/sync/push`, { method: 'POST', headers: { 'Sec-Fetch-Mode': 'cors' } }), false],
    [new Request(`${origin}/api/sync/push`, { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } }), true],
    [new Request(`${origin}/api/sync/status`, { method: 'GET', headers: { Origin: 'https://evil.example' } }), true],
  ]
  for (const [req, expected] of cases) {
    assert.equal(isTrustedSameOriginRequest(req, origin), expected)
  }

  assert.throws(() => resolveAuthBaseURL('http://crop.notgalerie.com'))
  assert.throws(() => resolveAuthBaseURL('https://crop.notgalerie.com/subpath'))
  assert.throws(() => resolveAuthBaseURL('javascript:alert(1)'))
  assert.equal(resolveAuthBaseURL('https://crop.notgalerie.com/'), 'https://crop.notgalerie.com')
})

test('security: sync API rejects path traversal, SQL injection IDs, spoofed XSS/SVG uploads, oversized batches, and enforces private blob headers', async () => {
  const { db, blobs } = setupFullDb()

  // Invalid IDs / path traversal / SQLi
  for (const badId of ['../user-b/drawings/d1', 'a/b', 'a%2fb', "' OR 1=1 --", '', 'x'.repeat(129)]) {
    assert.equal(isValidSyncId(badId), false, `Expected invalid ID: ${badId}`)
  }

  const traversalRes = await handleSyncRequest(
    new Request('https://crop.notgalerie.com/api/sync/blobs/..%2Fuser-b/original', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: makePng(),
    }),
    { db, blobs, userId: 'user-a' },
  )
  assert.equal(traversalRes.status, 400)

  // Spoofed SVG / HTML / script payloads pretending to be PNG/WebP
  const spoofPayloads = [
    new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
    new TextEncoder().encode('<!doctype html><script>alert(1)</script>'),
    new TextEncoder().encode('PK\x03\x04fakezip'),
    new TextEncoder().encode('%PDF-1.7'),
  ]
  for (const payload of spoofPayloads) {
    assert.equal(detectImageMime(payload), null)
    const res = await handleSyncRequest(
      new Request('https://crop.notgalerie.com/api/sync/blobs/spoof-1/original', {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: payload,
      }),
      { db, blobs, userId: 'user-a' },
    )
    assert.equal(res.status, 415)
  }

  // Oversized Content-Length rejected immediately with 413
  const oversizedThumb = await handleSyncRequest(
    new Request('https://crop.notgalerie.com/api/sync/blobs/big-thumb/thumb', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp', 'Content-Length': String(3 * 1024 * 1024) },
      body: makePng(),
    }),
    { db, blobs, userId: 'user-a' },
  )
  assert.equal(oversizedThumb.status, 413)

  // Oversized push batch (>100 items) rejected with 400
  const tooManyFolders = Array.from({ length: 101 }, (_, i) => ({
    id: `f-${i}`,
    name: `Folder ${i}`,
    updatedAt: 1000,
    deletedAt: null,
  }))
  const batchRes = await handleSyncRequest(
    new Request('https://crop.notgalerie.com/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folders: tooManyFolders }),
    }),
    { db, blobs, userId: 'user-a' },
  )
  assert.equal(batchRes.status, 400)

  // Oversized visibleTagIds (>500) rejected as INVALID_PAYLOAD
  const putOk = await handleSyncRequest(
    new Request('https://crop.notgalerie.com/api/sync/blobs/d-valid/original', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: makePng(128),
    }),
    { db, blobs, userId: 'user-a' },
  )
  assert.equal(putOk.status, 200)

  const hugeVisPush = await handleSyncRequest(
    new Request('https://crop.notgalerie.com/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        drawings: [{
          id: 'd-valid',
          name: 'ok.png',
          createdAt: 1000,
          updatedAt: 1000,
          deletedAt: null,
          width: 100,
          height: 100,
          folderId: null,
          position: 0,
          tags: [],
          visibleTagIds: Array.from({ length: 501 }, (_, i) => `t-${i}`),
        }],
      }),
    }),
    { db, blobs, userId: 'user-a' },
  )
  const hugeVisJson = await hugeVisPush.json()
  assert.equal(hugeVisJson.rejected[0]?.code, 'INVALID_PAYLOAD')

  // Blob GET returns private, no-store and user-b gets 404 (strict tenant isolation)
  const getOwn = await handleSyncRequest(
    new Request('https://crop.notgalerie.com/api/sync/blobs/d-valid/original'),
    { db, blobs, userId: 'user-a' },
  )
  assert.equal(getOwn.status, 200)
  assert.equal(getOwn.headers.get('Cache-Control'), 'private, no-store')

  const getCrossUser = await handleSyncRequest(
    new Request('https://crop.notgalerie.com/api/sync/blobs/d-valid/original'),
    { db, blobs, userId: 'user-b' },
  )
  assert.equal(getCrossUser.status, 404)
})

test('security: Polar webhook rejects replays, oversized payloads, wrong methods, unrelated products, and cross-subscription downgrade spoofing', async () => {
  const { db, sqlite } = setupFullDb()
  const now = () => 1700000010 * 1000

  // Non-POST rejected
  const getRes = await handlePolarWebhook(
    new Request('https://crop.notgalerie.com/api/billing/webhook', { method: 'GET' }),
    { db, config: BILLING_CONFIG, now },
  )
  assert.equal(getRes.status, 405)

  // Oversized webhook body (>256 KB) rejected with 413 before signature check
  const hugeBody = 'x'.repeat(300 * 1024)
  const hugeRes = await handlePolarWebhook(
    new Request('https://crop.notgalerie.com/api/billing/webhook', {
      method: 'POST',
      headers: signPolar(hugeBody, BILLING_CONFIG.webhookSecret, 'msg_huge', '1700000000'),
      body: hugeBody,
    }),
    { db, config: BILLING_CONFIG, now },
  )
  assert.equal(hugeRes.status, 413)

  // Future timestamp replay rejected
  const validPayload = JSON.stringify({ type: 'subscription.active', data: { id: 'sub_1' } })
  const futureHeaders = signPolar(validPayload, BILLING_CONFIG.webhookSecret, 'msg_fut', '1700000999')
  const futureOk = await verifyPolarWebhookSignature({
    rawBody: validPayload,
    webhookId: futureHeaders['webhook-id'],
    webhookTimestamp: futureHeaders['webhook-timestamp'],
    webhookSignature: futureHeaders['webhook-signature'],
    secret: BILLING_CONFIG.webhookSecret,
    nowSeconds: 1700000010,
  })
  assert.equal(futureOk, false)

  // Activate Alice's legitimate Pro Annual subscription
  const aliceActive = JSON.stringify({
    type: 'subscription.active',
    data: {
      id: 'sub_alice_real',
      status: 'active',
      product_id: 'prod-annual',
      customer_id: 'cust_alice',
      customer: { id: 'cust_alice', external_id: 'user-a', email: 'alice@example.com' },
    },
  })
  const rActive = await handlePolarWebhook(
    new Request('https://crop.notgalerie.com/api/billing/webhook', {
      method: 'POST',
      headers: signPolar(aliceActive, BILLING_CONFIG.webhookSecret, 'msg_a1', '1700000000'),
      body: aliceActive,
    }),
    { db, config: BILLING_CONFIG, now },
  )
  assert.equal(rActive.status, 200)

  // Attack 1: Revoked webhook for a DIFFERENT subscription ID using Alice's email must NOT downgrade Alice
  const spoofRevoke = JSON.stringify({
    type: 'subscription.revoked',
    data: {
      id: 'sub_attacker_other',
      status: 'revoked',
      product_id: 'prod-monthly',
      customer: { email: 'alice@example.com' },
    },
  })
  const rSpoof = await handlePolarWebhook(
    new Request('https://crop.notgalerie.com/api/billing/webhook', {
      method: 'POST',
      headers: signPolar(spoofRevoke, BILLING_CONFIG.webhookSecret, 'msg_a2', '1700000000'),
      body: spoofRevoke,
    }),
    { db, config: BILLING_CONFIG, now },
  )
  assert.equal(rSpoof.status, 200)

  // Attack 2: Unrelated product ID must NOT downgrade Alice or upgrade Bob
  const unrelatedRes = await handlePolarWebhook(
    new Request('https://crop.notgalerie.com/api/billing/webhook', {
      method: 'POST',
      headers: signPolar(
        JSON.stringify({
          type: 'subscription.active',
          data: {
            id: 'sub_bob_other_prod',
            status: 'active',
            product_id: 'prod-unrelated-cheap',
            customer: { external_id: 'user-b', email: 'bob@example.com' },
          },
        }),
        BILLING_CONFIG.webhookSecret,
        'msg_a3',
        '1700000000',
      ),
      body: JSON.stringify({
        type: 'subscription.active',
        data: {
          id: 'sub_bob_other_prod',
          status: 'active',
          product_id: 'prod-unrelated-cheap',
          customer: { external_id: 'user-b', email: 'bob@example.com' },
        },
      }),
    }),
    { db, config: BILLING_CONFIG, now },
  )
  assert.equal(unrelatedRes.status, 200)

  // Verify Alice STILL has 5 GB Pro and Bob STILL has 100 MB Free
  const aliceStorage = sqlite.prepare("SELECT quota_bytes FROM user_storage WHERE user_id = 'user-a'").get()
  assert.equal(Number(aliceStorage.quota_bytes), PRO_QUOTA_BYTES)

  const bobStatus = await handleBillingRequest(
    new Request('https://crop.notgalerie.com/api/billing/status'),
    { db, userId: 'user-b', userEmail: 'bob@example.com', config: BILLING_CONFIG, now },
  )
  const bobJson = await bobStatus.json()
  assert.equal(bobJson.plan, 'free')
  assert.equal(bobJson.quotaBytes, DEFAULT_QUOTA_BYTES)

  // Account deletion cascades user_subscription without touching other users
  await deleteUserAccountData({ db, userId: 'user-a', userEmail: 'alice@example.com' })
  const aliceSubAfterDelete = sqlite.prepare("SELECT * FROM user_subscription WHERE user_id = 'user-a'").get()
  assert.equal(aliceSubAfterDelete, undefined)
  const bobStillExists = sqlite.prepare("SELECT id FROM user WHERE id = 'user-b'").get()
  assert.equal(bobStillExists?.id, 'user-b')
})

test('security: Polar checkout and portal enforce strict https://*.polar.sh redirect validation and reject bad plans', async () => {
  assert.equal(isAllowedPolarRedirectUrl('https://checkout.polar.sh/c/123'), true)
  assert.equal(isAllowedPolarRedirectUrl('https://polar.sh/portal/abc'), true)
  assert.equal(isAllowedPolarRedirectUrl('http://checkout.polar.sh/c/123'), false)
  assert.equal(isAllowedPolarRedirectUrl('https://polar.sh.evil.com/phish'), false)
  assert.equal(isAllowedPolarRedirectUrl('https://evil.com/?redirect=polar.sh'), false)
  assert.equal(isAllowedPolarRedirectUrl('javascript:alert(1)'), false)
  assert.equal(isAllowedPolarRedirectUrl('data:text/html,<script>alert(1)</script>'), false)

  const { db } = setupFullDb()
  const evilFetch = async () => Response.json({
    url: 'https://evil.example/steal-card',
    customer_portal_url: 'javascript:alert(1)',
  })

  const badCheckout = await handleBillingRequest(
    new Request('https://crop.notgalerie.com/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'annual' }),
    }),
    { db, userId: 'user-a', userEmail: 'alice@example.com', config: BILLING_CONFIG, fetchFn: evilFetch },
  )
  assert.equal(badCheckout.status, 502)

  const badPortal = await handleBillingRequest(
    new Request('https://crop.notgalerie.com/api/billing/portal', { method: 'POST' }),
    { db, userId: 'user-a', userEmail: 'alice@example.com', config: BILLING_CONFIG, fetchFn: evilFetch },
  )
  assert.equal(badPortal.status, 502)

  const badPlan = await handleBillingRequest(
    new Request('https://crop.notgalerie.com/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: "' OR 1=1 --" }),
    }),
    { db, userId: 'user-a', userEmail: 'alice@example.com', config: BILLING_CONFIG, fetchFn: evilFetch },
  )
  assert.equal(badPlan.status, 400)
})

test('security: streaming ZIP backup blocks zip-bombs and spoofed non-image files', async () => {
  // Compress 512 KB of zeros (tiny compressed zip) and enforce 64 KB limit
  const bombBytes = new Uint8Array(512 * 1024)
  const chunks = await createStreamingZip([{ name: 'bomb.bin', data: bombBytes, compress: true }])
  const totalLen = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  const archive = new Uint8Array(totalLen)
  let offset = 0
  for (const c of chunks) {
    archive.set(c, offset)
    offset += c.byteLength
  }
  await assert.rejects(
    () => extractStreamingZip(archive, { maxEntryBytes: 64 * 1024, maxUncompressedBytes: 64 * 1024 }),
    /too large|limit/i,
  )

  // Magic-byte MIME verification rejects HTML disguised as PNG
  const htmlBytes = new TextEncoder().encode('<html><script>alert(1)</script></html>')
  assert.equal(resolveRestoredImageMime(htmlBytes, 'image/png'), null)
  assert.equal(resolveRestoredImageMime(makePng(), 'text/html'), 'image/png')
})

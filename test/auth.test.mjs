import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { betterAuth } from 'better-auth'
import { magicLink } from 'better-auth/plugins'
import {
  AUTH_SCHEMA_CONFIG,
  getAuthCallbackErrorMessage,
  resolveAuthBaseURL,
  withAuthSecurityHeaders,
} from '../src/lib/auth-config.ts'

test('resolveAuthBaseURL accepts HTTPS origins and localhost HTTP, rejects paths and plain HTTP', () => {
  assert.equal(resolveAuthBaseURL('https://crop.darrenchauvet.workers.dev'), 'https://crop.darrenchauvet.workers.dev')
  assert.equal(resolveAuthBaseURL('https://crop.darrenchauvet.workers.dev/'), 'https://crop.darrenchauvet.workers.dev')
  assert.equal(resolveAuthBaseURL('http://localhost:8787'), 'http://localhost:8787')
  assert.throws(() => resolveAuthBaseURL('http://crop.example.com'), /AUTH_URL/)
  assert.throws(() => resolveAuthBaseURL('https://crop.example.com/app'), /AUTH_URL/)
  assert.throws(() => resolveAuthBaseURL('not-a-url'), /AUTH_URL/)
})

test('withAuthSecurityHeaders adds security headers while preserving cookies and redirects', () => {
  const original = new Response(null, {
    status: 302,
    headers: {
      Location: 'https://crop.example.com/',
      'Cache-Control': 'no-store',
    },
  })
  original.headers.append('Set-Cookie', 'a=1; Path=/; HttpOnly; Secure')
  original.headers.append('Set-Cookie', 'b=2; Path=/; HttpOnly; Secure')

  const secured = withAuthSecurityHeaders(original)
  assert.equal(secured.status, 302)
  assert.equal(secured.headers.get('Location'), 'https://crop.example.com/')
  assert.equal(secured.headers.get('Cache-Control'), 'no-store')
  assert.equal(secured.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(secured.headers.get('X-Frame-Options'), 'DENY')
  assert.equal(secured.headers.get('Referrer-Policy'), 'no-referrer')
  assert.deepEqual(secured.headers.getSetCookie(), [
    'a=1; Path=/; HttpOnly; Secure',
    'b=2; Path=/; HttpOnly; Secure',
  ])
})

test('getAuthCallbackErrorMessage maps Better Auth error codes to user-friendly messages', () => {
  assert.equal(getAuthCallbackErrorMessage(null), null)
  assert.match(getAuthCallbackErrorMessage('INVALID_TOKEN') ?? '', /invalid or has already been used/i)
  assert.match(getAuthCallbackErrorMessage('EXPIRED_TOKEN') ?? '', /expired/i)
  assert.match(getAuthCallbackErrorMessage('MAGIC_LINK_EXPIRED') ?? '', /expired/i)
  assert.match(getAuthCallbackErrorMessage('ATTEMPTS_EXCEEDED') ?? '', /too many/i)
  assert.match(getAuthCallbackErrorMessage('UNKNOWN_ERROR') ?? '', /could not complete sign-in/i)
})

test('end-to-end magic link account creation, hashed token storage, session, replay block, sign-out and rate limit', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('../migrations/0001_accounts.sql', import.meta.url), 'utf8'))
  db.exec(readFileSync(new URL('../migrations/0002_auth_rate_limit.sql', import.meta.url), 'utf8'))

  const baseURL = 'https://crop.example.com'
  const sentLinks = []

  const auth = betterAuth({
    database: db,
    secret: 'test-secret-with-at-least-thirty-two-characters-123456',
    baseURL,
    trustedOrigins: [baseURL],
    ...AUTH_SCHEMA_CONFIG,
    advanced: {
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    rateLimit: {
      ...AUTH_SCHEMA_CONFIG.rateLimit,
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/magic-link': { window: 60, max: 3 },
        '/magic-link/verify': { window: 60, max: 10 },
      },
    },
    plugins: [
      magicLink({
        expiresIn: 10 * 60,
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          sentLinks.push({ email, url })
        },
      }),
    ],
  })

  // 1. Request magic link
  const signInRes = await auth.handler(
    new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: baseURL,
        'cf-connecting-ip': '203.0.113.10',
      },
      body: JSON.stringify({ email: 'artist@example.com', callbackURL: baseURL }),
    }),
  )
  assert.equal(signInRes.status, 200)
  assert.equal(sentLinks.length, 1)
  assert.equal(sentLinks[0].email, 'artist@example.com')

  const magicUrl = new URL(sentLinks[0].url)
  const rawToken = magicUrl.searchParams.get('token')
  assert.ok(rawToken && rawToken.length > 10)

  // Token in SQLite must be hashed, never stored in plaintext
  const verifications = db.prepare('SELECT identifier, value FROM verification').all()
  assert.equal(verifications.length, 1)
  assert.notEqual(verifications[0].identifier, rawToken)
  assert.equal(verifications[0].identifier.includes(rawToken), false)

  // 2. Verify magic link -> creates user + session and sets Secure HttpOnly cookie
  const verifyRes = await auth.handler(
    new Request(magicUrl.toString(), {
      method: 'GET',
      headers: { 'cf-connecting-ip': '203.0.113.10' },
    }),
  )
  assert.equal(verifyRes.status, 302)
  assert.equal(verifyRes.headers.get('location'), `${baseURL}/`)
  const setCookies = verifyRes.headers.getSetCookie()
  assert.ok(setCookies.length >= 1)
  assert.ok(setCookies.some((c) => /HttpOnly/i.test(c) && /Secure/i.test(c)))

  const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ')

  // User created and verified in DB
  const users = db.prepare('SELECT email, email_verified FROM user').all()
  assert.equal(users.length, 1)
  assert.equal(users[0].email, 'artist@example.com')
  assert.equal(users[0].email_verified, 1)

  // 3. Session works with cookie
  const sessionRes = await auth.handler(
    new Request(`${baseURL}/api/auth/get-session`, {
      method: 'GET',
      headers: { Cookie: cookieHeader, 'cf-connecting-ip': '203.0.113.10' },
    }),
  )
  assert.equal(sessionRes.status, 200)
  const sessionBody = await sessionRes.json()
  assert.equal(sessionBody.user.email, 'artist@example.com')

  // 4. Replaying the same magic link is rejected with INVALID_TOKEN
  const replayRes = await auth.handler(
    new Request(magicUrl.toString(), {
      method: 'GET',
      headers: { 'cf-connecting-ip': '203.0.113.10' },
    }),
  )
  assert.equal(replayRes.status, 302)
  assert.match(replayRes.headers.get('location') ?? '', /\?error=INVALID_TOKEN/)

  // 5. Sign out deletes session
  const signOutRes = await auth.handler(
    new Request(`${baseURL}/api/auth/sign-out`, {
      method: 'POST',
      headers: {
        Origin: baseURL,
        Cookie: cookieHeader,
        'cf-connecting-ip': '203.0.113.10',
      },
    }),
  )
  assert.equal(signOutRes.status, 200)
  const remainingSessions = db.prepare('SELECT count(*) AS count FROM session').get()
  assert.equal(remainingSessions.count, 0)

  // 6. Rate limiting blocks the 4th magic link request within 60s from the same IP
  for (let i = 0; i < 2; i++) {
    const res = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: baseURL,
          'cf-connecting-ip': '203.0.113.10',
        },
        body: JSON.stringify({ email: 'artist@example.com', callbackURL: baseURL }),
      }),
    )
    assert.equal(res.status, 200)
  }
  const blockedRes = await auth.handler(
    new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: baseURL,
        'cf-connecting-ip': '203.0.113.10',
      },
      body: JSON.stringify({ email: 'artist@example.com', callbackURL: baseURL }),
    }),
  )
  assert.equal(blockedRes.status, 429)

  db.close()
})

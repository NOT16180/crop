import { betterAuth } from 'better-auth'
import { magicLink } from 'better-auth/plugins'

export interface AuthEnv {
  crop_auth: unknown
  BETTER_AUTH_SECRET: string
  AUTH_URL: string
  RESEND_API_KEY?: string
  AUTH_EMAIL_FROM?: string
}

export function createAuth(env: AuthEnv) {
  const parsedBaseURL = new URL(env.AUTH_URL)
  const baseURL = parsedBaseURL.origin
  if (baseURL !== env.AUTH_URL.replace(/\/$/, '') ||
      (parsedBaseURL.protocol !== 'https:' && parsedBaseURL.hostname !== 'localhost')) {
    throw new Error('AUTH_URL must be an HTTPS origin (HTTP is allowed only for localhost)')
  }

  return betterAuth({
    database: env.crop_auth as never,
    secret: env.BETTER_AUTH_SECRET,
    baseURL,
    trustedOrigins: [baseURL],
    user: {
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    session: {
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        userId: 'user_id',
      },
    },
    account: {
      fields: {
        accountId: 'account_id',
        providerId: 'provider_id',
        userId: 'user_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    rateLimit: {
      modelName: 'rate_limit',
      fields: { lastRequest: 'last_request' },
      enabled: true,
      storage: 'database',
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
          if (!env.RESEND_API_KEY || !env.AUTH_EMAIL_FROM) {
            throw new Error('Email delivery is not configured')
          }

          const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: env.AUTH_EMAIL_FROM,
              to: [email],
              subject: 'Your Crop sign-in link',
              text: `Use this link to sign in to Crop. It expires in 10 minutes:\n\n${url}\n\nIf you did not request this email, you can ignore it.`,
            }),
          })

          if (!response.ok) {
            throw new Error(`Email delivery failed (${response.status})`)
          }
        },
      }),
    ],
  })
}

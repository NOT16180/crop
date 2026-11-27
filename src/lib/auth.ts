import { betterAuth } from 'better-auth'
import { magicLink } from 'better-auth/plugins'
import { AUTH_SCHEMA_CONFIG, resolveAuthBaseURL } from './auth-config'

export interface AuthEnv {
  crop_auth: unknown
  BETTER_AUTH_SECRET: string
  AUTH_URL: string
  RESEND_API_KEY?: string
  AUTH_EMAIL_FROM?: string
}

export function createAuth(env: AuthEnv) {
  const baseURL = resolveAuthBaseURL(env.AUTH_URL)

  return betterAuth({
    database: env.crop_auth as never,
    secret: env.BETTER_AUTH_SECRET,
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
          if (!env.RESEND_API_KEY || !env.AUTH_EMAIL_FROM) {
            throw new Error('Email delivery is not configured')
          }

          const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            signal: AbortSignal.timeout(8_000),
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

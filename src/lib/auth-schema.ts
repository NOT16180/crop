import { betterAuth } from 'better-auth'
import { magicLink } from 'better-auth/plugins'

// Schema source for `npx auth generate --adapter kysely --dialect sqlite`.
export const auth = betterAuth({
  rateLimit: { storage: 'database', modelName: 'rate_limit', fields: { lastRequest: 'last_request' } },
  user: { fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' } },
  session: { fields: {
    expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at',
    ipAddress: 'ip_address', userAgent: 'user_agent', userId: 'user_id',
  } },
  account: { fields: {
    accountId: 'account_id', providerId: 'provider_id', userId: 'user_id',
    accessToken: 'access_token', refreshToken: 'refresh_token', idToken: 'id_token',
    accessTokenExpiresAt: 'access_token_expires_at', refreshTokenExpiresAt: 'refresh_token_expires_at',
    createdAt: 'created_at', updatedAt: 'updated_at',
  } },
  verification: { fields: {
    expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at',
  } },
  plugins: [magicLink({ storeToken: 'hashed', sendMagicLink: async () => undefined })],
})

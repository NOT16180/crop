import { betterAuth } from 'better-auth'
import { magicLink } from 'better-auth/plugins'
import { AUTH_SCHEMA_CONFIG } from './auth-config'

// Schema source for `npx auth generate --adapter kysely --dialect sqlite`.
export const auth = betterAuth({
  ...AUTH_SCHEMA_CONFIG,
  plugins: [magicLink({ storeToken: 'hashed', sendMagicLink: async () => undefined })],
})

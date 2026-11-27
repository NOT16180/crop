import { createAuth, type AuthEnv } from './lib/auth'
import { withAuthSecurityHeaders } from './lib/auth-config'

interface Env extends AuthEnv {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/auth')) {
      if (!env.BETTER_AUTH_SECRET || !env.AUTH_URL) {
        return withAuthSecurityHeaders(
          Response.json({ error: 'Authentication is not configured' }, { status: 503 }),
        )
      }
      try {
        const response = await createAuth(env).handler(request)
        return withAuthSecurityHeaders(response)
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('AUTH_URL ')) {
          return withAuthSecurityHeaders(
            Response.json({ error: 'Authentication is misconfigured' }, { status: 503 }),
          )
        }
        throw error
      }
    }
    return env.ASSETS.fetch(request)
  },
}

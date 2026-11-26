import { createAuth, type AuthEnv } from './lib/auth'

interface Env extends AuthEnv {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/auth')) {
      if (!env.BETTER_AUTH_SECRET || !env.AUTH_URL) {
        return Response.json({ error: 'Authentication is not configured' }, { status: 503 })
      }
      return createAuth(env).handler(request)
    }
    return env.ASSETS.fetch(request)
  },
}

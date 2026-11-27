import { createAuth, type AuthEnv } from './lib/auth'
import { withAuthSecurityHeaders } from './lib/auth-config'
import {
  handleSyncRequest,
  type D1DatabaseLike,
  type R2BucketLike,
} from './lib/sync-server'

interface Env extends AuthEnv {
  ASSETS: { fetch(request: Request): Promise<Response> }
  BLOBS?: R2BucketLike
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

    if (url.pathname.startsWith('/api/sync')) {
      if (!env.BETTER_AUTH_SECRET || !env.AUTH_URL) {
        return withAuthSecurityHeaders(
          Response.json({ error: 'Authentication is not configured', code: 'AUTH_NOT_CONFIGURED' }, { status: 503 }),
        )
      }
      if (!env.BLOBS) {
        return withAuthSecurityHeaders(
          Response.json({ error: 'Cloud sync storage is not enabled yet', code: 'SYNC_NOT_CONFIGURED' }, { status: 503 }),
        )
      }
      try {
        const session = await createAuth(env).api.getSession({ headers: request.headers })
        if (!session?.user?.id) {
          return withAuthSecurityHeaders(
            Response.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 }),
          )
        }
        const response = await handleSyncRequest(request, {
          db: env.crop_auth as D1DatabaseLike,
          blobs: env.BLOBS,
          userId: session.user.id,
        })
        return withAuthSecurityHeaders(response)
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('AUTH_URL ')) {
          return withAuthSecurityHeaders(
            Response.json({ error: 'Authentication is misconfigured', code: 'AUTH_MISCONFIGURED' }, { status: 503 }),
          )
        }
        throw error
      }
    }

    return env.ASSETS.fetch(request)
  },
}

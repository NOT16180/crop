import { createAuth, type AuthEnv } from './lib/auth'
import { resolveAuthBaseURL, withAuthSecurityHeaders } from './lib/auth-config'
import {
  deleteUserAccountData,
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

    // Redirect old workers.dev visits to the configured custom domain.
    if (request.method === 'GET' && url.hostname.endsWith('.workers.dev') && env.AUTH_URL) {
      try {
        const canonical = new URL(resolveAuthBaseURL(env.AUTH_URL))
        if (canonical.hostname !== url.hostname) {
          const target = `${canonical.origin}${url.pathname}${url.search}`
          return withAuthSecurityHeaders(Response.redirect(target, 302))
        }
      } catch {
        // Invalid AUTH_URL is handled on /api/* below.
      }
    }

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

      if (url.pathname === '/api/sync/account' && request.method === 'DELETE') {
        try {
          const auth = createAuth(env)
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return withAuthSecurityHeaders(
              Response.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 }),
            )
          }

          // Sign out first so Better Auth emits cookie-clearing Set-Cookie headers.
          const signOutResponse = await auth.handler(
            new Request(new URL('/api/auth/sign-out', request.url), {
              method: 'POST',
              headers: {
                Origin: resolveAuthBaseURL(env.AUTH_URL),
                Cookie: request.headers.get('Cookie') ?? '',
                'cf-connecting-ip': request.headers.get('cf-connecting-ip') ?? '',
              },
            }),
          )

          await deleteUserAccountData({
            db: env.crop_auth as D1DatabaseLike,
            blobs: env.BLOBS,
            userId: session.user.id,
            userEmail: session.user.email,
          })

          const headers = new Headers({
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          })
          for (const cookie of signOutResponse.headers.getSetCookie()) {
            headers.append('Set-Cookie', cookie)
          }
          return withAuthSecurityHeaders(new Response(JSON.stringify({ ok: true }), { status: 200, headers }))
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('AUTH_URL ')) {
            return withAuthSecurityHeaders(
              Response.json({ error: 'Authentication is misconfigured', code: 'AUTH_MISCONFIGURED' }, { status: 503 }),
            )
          }
          throw error
        }
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

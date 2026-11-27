export const AUTH_SCHEMA_CONFIG = {
  rateLimit: {
    storage: 'database' as const,
    modelName: 'rate_limit',
    fields: { lastRequest: 'last_request' },
  },
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
}

export const AUTH_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
}

export function resolveAuthBaseURL(rawAuthUrl: string): string {
  let parsedBaseURL: URL
  try {
    parsedBaseURL = new URL(rawAuthUrl)
  } catch {
    throw new Error('AUTH_URL must be a valid HTTPS origin (HTTP is allowed only for localhost)')
  }
  const baseURL = parsedBaseURL.origin
  if (
    baseURL !== rawAuthUrl.replace(/\/$/, '') ||
    (parsedBaseURL.protocol !== 'https:' && parsedBaseURL.hostname !== 'localhost')
  ) {
    throw new Error('AUTH_URL must be an HTTPS origin (HTTP is allowed only for localhost)')
  }
  return baseURL
}

export function withAuthSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(AUTH_SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Defense-in-depth CSRF check for state-changing /api/sync/* requests
 * (POST, PUT, DELETE). Rejects requests whose Origin or Sec-Fetch-Site
 * indicates a cross-site initiator.
 */
export function isTrustedSameOriginRequest(request: Request, canonicalOrigin: string): boolean {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true

  const secFetchSite = request.headers.get('Sec-Fetch-Site')?.trim().toLowerCase()
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return false
  }

  const origin = request.headers.get('Origin')?.trim()
  if (origin) {
    return origin === canonicalOrigin
  }

  const referer = request.headers.get('Referer')?.trim()
  if (referer) {
    try {
      return new URL(referer).origin === canonicalOrigin
    } catch {
      return false
    }
  }

  // Browser fetch/XHR for mutating requests always includes Origin; block missing Origin when Sec-Fetch-Mode is set.
  if (request.headers.get('Sec-Fetch-Mode')) return false
  return true
}

export function getAuthCallbackErrorMessage(errorCode: string | null): string | null {
  if (!errorCode) return null
  switch (errorCode.trim().toUpperCase()) {
    case 'EXPIRED_TOKEN':
    case 'MAGIC_LINK_EXPIRED':
      return 'This sign-in link has expired. Request a new one below.'
    case 'INVALID_TOKEN':
      return 'This sign-in link is invalid or has already been used. Request a new one below.'
    case 'ATTEMPTS_EXCEEDED':
      return 'Too many sign-in attempts. Please wait a minute and request a new link.'
    default:
      return 'Could not complete sign-in. Please request a new sign-in link.'
  }
}

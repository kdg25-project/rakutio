const localOrigins = [
  'http://localhost',
  'http://localhost:*',
  'http://127.0.0.1',
  'http://127.0.0.1:*',
  'http://[::1]',
  'http://[::1]:*',
] as const

function isLocalDevelopmentHost(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function localDevelopmentBaseUrl(baseUrl: string) {
  try {
    const url = new URL(baseUrl)
    return url.protocol === 'http:' && isLocalDevelopmentHost(url.hostname)
  } catch {
    return false
  }
}

/**
 * Vite selects the next available local port when its default port is busy.
 * Keep that local development convenience scoped to an explicitly loopback
 * BETTER_AUTH_URL; deployed origins continue to trust only their configured
 * public URL.
 */
export function trustedOriginsForAuthBaseUrl(baseUrl: string): string[] {
  return localDevelopmentBaseUrl(baseUrl) ? [...localOrigins] : []
}

/** Keep app write endpoints in lockstep with Better Auth's local-origin rule. */
export function isTrustedLocalDevelopmentOrigin(origin: string, baseUrl: string): boolean {
  if (!localDevelopmentBaseUrl(baseUrl)) return false
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && isLocalDevelopmentHost(url.hostname)
  } catch {
    return false
  }
}

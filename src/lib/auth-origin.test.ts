import { describe, expect, it } from 'vitest'

import { isTrustedLocalDevelopmentOrigin, trustedOriginsForAuthBaseUrl } from './auth-origin'

describe('trustedOriginsForAuthBaseUrl', () => {
  it('allows Vite to choose another loopback port during local development', () => {
    expect(trustedOriginsForAuthBaseUrl('http://localhost:5173')).toEqual([
      'http://localhost',
      'http://localhost:*',
      'http://127.0.0.1',
      'http://127.0.0.1:*',
      'http://[::1]',
      'http://[::1]:*',
    ])
  })

  it('does not add loopback wildcard origins for a deployed URL', () => {
    expect(trustedOriginsForAuthBaseUrl('https://rakutio.example')).toEqual([])
    expect(trustedOriginsForAuthBaseUrl('https://localhost:5173')).toEqual([])
    expect(trustedOriginsForAuthBaseUrl('not-a-url')).toEqual([])
  })

  it('accepts loopback development ports only when the configured URL is loopback HTTP', () => {
    expect(isTrustedLocalDevelopmentOrigin('http://localhost:5175', 'http://localhost:5173')).toBe(true)
    expect(isTrustedLocalDevelopmentOrigin('http://127.0.0.1:5175', 'http://localhost:5173')).toBe(true)
    expect(isTrustedLocalDevelopmentOrigin('https://localhost:5175', 'http://localhost:5173')).toBe(false)
    expect(isTrustedLocalDevelopmentOrigin('http://localhost:5175', 'https://rakutio.example')).toBe(false)
  })
})

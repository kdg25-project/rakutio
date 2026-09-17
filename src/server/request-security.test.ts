import { describe, expect, it } from 'vitest'

import { enforceSameOrigin } from './request-security'

function request(origin: string) {
  return new Request('http://localhost:5175/api/ledger/transactions', {
    method: 'POST',
    headers: { origin },
  })
}

describe('enforceSameOrigin', () => {
  it('accepts the port Vite selected when Better Auth is configured for loopback development', () => {
    expect(enforceSameOrigin(request('http://localhost:5175'), 'http://localhost:5173')).toBeNull()
    expect(enforceSameOrigin(request('http://127.0.0.1:5175'), 'http://localhost:5173')).toBeNull()
  })

  it('continues to reject a different origin for deployed configuration', () => {
    const response = enforceSameOrigin(request('http://localhost:5175'), 'https://rakutio.example')
    expect(response?.status).toBe(403)
  })
})

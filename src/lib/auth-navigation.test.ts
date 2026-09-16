import { describe, expect, it } from 'vitest'

import { Route as AppRoute } from '../routes/app'
import { Route as HomeRoute } from '../routes/index'
import { Route as LoginRoute } from '../routes/login'
import { Route as RegisterRoute } from '../routes/register'
import { Route as SignupRoute } from '../routes/signup'
import { authoritativeSessionQuery, invalidateSessionAndReplace, isAuthenticated, privateSessionHeaders, signOutAndReplace } from './auth-navigation'

function guardRedirect(route: { options: { beforeLoad?: (context: never) => unknown } }, session: unknown) {
  try {
    route.options.beforeLoad?.({ context: { session } } as never)
  } catch (error) {
    return error as Response & { options: { to: string; replace?: boolean } }
  }
  return undefined
}

describe('session route guards', () => {
  it('keeps rendered routes private because their root context contains a session', () => {
    expect(privateSessionHeaders).toEqual({ 'Cache-Control': 'private, no-store' })
    expect(authoritativeSessionQuery).toEqual({ disableCookieCache: true })
  })

  it('sends an anonymous request for the protected app route to login', () => {
    expect(guardRedirect(AppRoute, null)?.options.to).toBe('/login')
  })

  it('sends an authenticated session away from public routes', () => {
    const session = { user: { id: 'user-1' } }

    for (const route of [HomeRoute, LoginRoute, SignupRoute, RegisterRoute]) {
      expect(guardRedirect(route, session)?.options.to).toBe('/app')
    }
  })

  it('allows the matching side of each guard through', () => {
    expect(guardRedirect(AppRoute, { user: { id: 'user-1' } })).toBeUndefined()
    expect(guardRedirect(LoginRoute, null)).toBeUndefined()
    expect(guardRedirect(HomeRoute, null)?.options).toMatchObject({ to: '/login', replace: true })
  })

  it('redirects the legacy register URL to signup with a replacement', () => {
    expect(guardRedirect(RegisterRoute, null)?.options).toMatchObject({ to: '/signup', replace: true })
  })
})

describe('auth mutation navigation', () => {
  it('invalidates the root session before replacing the location after login or signup', async () => {
    const events: string[] = []
    const router = { invalidate: async ({ sync }: { sync: true }) => { events.push(`invalidate:${sync}`) } }
    const navigate = async ({ to, replace }: { to: '/app' | '/login'; replace: true }) => { events.push(`navigate:${to}:${replace}`) }

    await invalidateSessionAndReplace(router, navigate, '/app')

    expect(events).toEqual(['invalidate:true', 'navigate:/app:true'])
  })

  it('signs out before refreshing the session and replacing history', async () => {
    const events: string[] = []
    const signOut = async () => { events.push('sign-out'); return {} }
    const router = { invalidate: async () => { events.push('invalidate') } }
    const navigate = async ({ to, replace }: { to: '/app' | '/login'; replace: true }) => { events.push(`${to}:${replace}`) }

    await signOutAndReplace(signOut, router, navigate)

    expect(events).toEqual(['sign-out', 'invalidate', '/login:true'])
    expect(isAuthenticated(null)).toBe(false)
    expect(guardRedirect(AppRoute, null)?.options.to).toBe('/login')
  })

  it('keeps the current Settings screen when Better Auth returns or throws a sign-out failure', async () => {
    const events: string[] = []
    const router = { invalidate: async () => { events.push('invalidate') } }
    const navigate = async () => { events.push('navigate') }

    await expect(signOutAndReplace(async () => ({ error: { message: 'セッションを終了できませんでした。' } }), router, navigate)).rejects.toThrow('セッションを終了できませんでした。')
    await expect(signOutAndReplace(async () => { throw new Error('ネットワークエラー') }, router, navigate)).rejects.toThrow('ネットワークエラー')

    expect(events).toEqual([])
  })
})

type SessionWithUser = { user?: unknown } | null | undefined

type RouterInvalidator = {
  invalidate: (options: { sync: true }) => Promise<unknown>
}

type ReplaceNavigation = (options: { to: '/app' | '/login'; replace: true }) => Promise<unknown>
type SignOutResult = { error?: { message?: string } | null } | void
type SignOut = () => Promise<SignOutResult>

export const privateSessionHeaders = {
  'Cache-Control': 'private, no-store',
} as const

/**
 * Route decisions must use the database-backed session instead of Better Auth's
 * optional cookie cache. This keeps a just-created or just-revoked session from
 * sending the browser to the wrong side of an auth guard.
 */
export const authoritativeSessionQuery = {
  disableCookieCache: true,
} as const

/** Route guards share the one session resolved by the root route. */
export function isAuthenticated(session: SessionWithUser): boolean {
  return Boolean(session?.user)
}

/** Re-read the root session after Better Auth changes its cookie. */
export async function invalidateSessionAndReplace(
  router: RouterInvalidator,
  navigate: ReplaceNavigation,
  to: '/app' | '/login',
) {
  await router.invalidate({ sync: true })
  await navigate({ to, replace: true })
}

/**
 * Better Auth can report a failed sign-out without throwing. Keep the current
 * screen intact in that case; a stale authenticated route must not be erased.
 */
export async function signOutAndReplace(
  signOut: SignOut,
  router: RouterInvalidator,
  navigate: ReplaceNavigation,
) {
  const result = await signOut()
  if (result?.error) {
    throw new Error(result.error.message || 'ログアウトできませんでした。')
  }
  await invalidateSessionAndReplace(router, navigate, '/login')
}

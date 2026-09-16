import { createFileRoute, redirect, useNavigate, useRouter } from '@tanstack/react-router'

import { LedgerApp } from '../components/ledger-app'
import { authClient } from '../lib/auth-client'
import { isAuthenticated, signOutAndReplace } from '../lib/auth-navigation'

export const Route = createFileRoute('/app')({
  beforeLoad: ({ context }) => {
    if (!isAuthenticated(context.session)) {
      throw redirect({ to: '/login' })
    }
    return { session: context.session }
  },
  component: AppHome,
})

function AppHome() {
  const { session } = Route.useRouteContext()
  const navigate = useNavigate()
  const router = useRouter()

  // The route guard above always supplies a user. Keep this defensive branch
  // for a transient client invalidation while the root session is refreshing.
  if (!session?.user) {
    return null
  }

  async function signOut() {
    await signOutAndReplace(() => authClient.signOut(), router, navigate)
  }

  return <LedgerApp userId={session.user.id} userName={session.user.name} onSignOut={signOut} />
}

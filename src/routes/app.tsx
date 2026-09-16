import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'

import { LedgerApp } from '../components/ledger-app'
import { authClient } from '../lib/auth-client'
import { getCurrentSession } from '../lib/session'

export const Route = createFileRoute('/app')({
  beforeLoad: async () => {
    const session = await getCurrentSession()
    if (!session?.user) {
      throw redirect({ to: '/login' })
    }
    return { session }
  },
  component: AppHome,
})

function AppHome() {
  const { session } = Route.useRouteContext()
  const navigate = useNavigate()

  async function signOut() {
    await authClient.signOut()
    await navigate({ to: '/' })
  }

  return <LedgerApp userName={session.user.name} onSignOut={signOut} />
}

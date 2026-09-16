import { createFileRoute, redirect } from '@tanstack/react-router'

import { isAuthenticated } from '../lib/auth-navigation'

export const Route = createFileRoute('/')({
  beforeLoad: ({ context }) => {
    if (isAuthenticated(context.session)) {
      throw redirect({ to: '/app' })
    }
    throw redirect({ to: '/login', replace: true })
  },
})

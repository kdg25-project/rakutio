import { createFileRoute, redirect } from '@tanstack/react-router'

import { isAuthenticated } from '../lib/auth-navigation'

/** Legacy-friendly registration URL used by the Figma flow. */
export const Route = createFileRoute('/register')({
  beforeLoad: ({ context }) => {
    if (isAuthenticated(context.session)) {
      throw redirect({ to: '/app', replace: true })
    }
    throw redirect({ to: '/signup', replace: true })
  },
})

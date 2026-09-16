import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'

import { auth } from './auth'
import { authoritativeSessionQuery } from './auth-navigation'

export const getCurrentSession = createServerFn({ method: 'GET' })
  .handler(async () => auth.api.getSession({
    headers: getRequestHeaders(),
    query: authoritativeSessionQuery,
  }))

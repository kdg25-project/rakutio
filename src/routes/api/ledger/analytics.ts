import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { auth } from '../../../lib/auth'
import { LedgerAnalyticsService } from '../../../server/ledger/analytics'
import { errorResponse } from '../../../server/ledger/http'

export const Route = createFileRoute('/api/ledger/analytics')({
  server: { handlers: {
    GET: async ({ request }) => {
      const session = await auth.api.getSession({ headers: request.headers })
      if (!session?.user) return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'ログインが必要です。' } }, { status: 401 })
      const query = new URL(request.url).searchParams
      try {
        const analytics = await new LedgerAnalyticsService(env.DB, session.user.id).analytics({ from: query.get('from'), to: query.get('to'), categoryId: query.get('categoryId') })
        return Response.json({ analytics })
      } catch (error) { return errorResponse(error) }
    },
  } },
})

import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, requireLedger } from '../../../server/ledger/http'

export const Route = createFileRoute('/api/ledger/summary')({
  server: { handlers: {
    GET: async ({ request }) => {
      const ledger = await requireLedger(request); if (ledger instanceof Response) return ledger
      try { return Response.json({ summary: await ledger.summary(new URL(request.url).searchParams.get('month')) }) } catch (error) { return errorResponse(error) }
    },
  } },
})

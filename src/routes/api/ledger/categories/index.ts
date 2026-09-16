import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, readJson, requireLedger, requireSameOrigin } from '../../../../server/ledger/http'

export const Route = createFileRoute('/api/ledger/categories/')({
  server: { handlers: {
    GET: async ({ request }) => {
      const ledger = await requireLedger(request); if (ledger instanceof Response) return ledger
      try { return Response.json({ categories: await ledger.listCategories() }) } catch (error) { return errorResponse(error) }
    },
    POST: async ({ request }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const ledger = await requireLedger(request); if (ledger instanceof Response) return ledger
      const body = await readJson(request); if (body instanceof Response) return body
      try { return Response.json({ category: await ledger.createCategory(body as { name: unknown; color?: unknown; icon?: unknown }) }, { status: 201 }) } catch (error) { return errorResponse(error) }
    },
  } },
})

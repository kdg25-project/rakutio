import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, readJson, requireLedger, requireSameOrigin } from '../../../../server/ledger/http'

export const Route = createFileRoute('/api/ledger/categories/$id')({
  server: { handlers: {
    PATCH: async ({ request, params }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const ledger = await requireLedger(request); if (ledger instanceof Response) return ledger
      const body = await readJson(request); if (body instanceof Response) return body
      try { return Response.json({ category: await ledger.updateCategory(params.id, body) }) } catch (error) { return errorResponse(error) }
    },
    DELETE: async ({ request, params }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const ledger = await requireLedger(request); if (ledger instanceof Response) return ledger
      try { return Response.json(await ledger.deleteCategory(params.id)) } catch (error) { return errorResponse(error) }
    },
  } },
})

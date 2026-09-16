import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, readJson, requireLedger, requireSameOrigin } from '../../../../server/ledger/http'
import type { LedgerTransactionInput } from '../../../../server/ledger/types'

export const Route = createFileRoute('/api/ledger/transactions/$id')({
  server: { handlers: {
    GET: async ({ request, params }) => {
      const ledger = await requireLedger(request); if (ledger instanceof Response) return ledger
      try {
        const transaction = await ledger.getTransaction(params.id)
        return transaction ? Response.json({ transaction }) : Response.json({ error: { code: 'NOT_FOUND', message: '明細が見つかりません。' } }, { status: 404 })
      } catch (error) { return errorResponse(error) }
    },
    PATCH: async ({ request, params }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const ledger = await requireLedger(request); if (ledger instanceof Response) return ledger
      const body = await readJson(request); if (body instanceof Response) return body
      try { return Response.json({ transaction: await ledger.updateTransaction(params.id, body.revision, body.transaction as LedgerTransactionInput) }) } catch (error) { return errorResponse(error) }
    },
    DELETE: async ({ request, params }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const ledger = await requireLedger(request); if (ledger instanceof Response) return ledger
      const body = await readJson(request); if (body instanceof Response) return body
      try { await ledger.deleteTransaction(params.id, body.revision); return new Response(null, { status: 204 }) } catch (error) { return errorResponse(error) }
    },
  } },
})

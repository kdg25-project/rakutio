import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, readJson, requireLedger, requireSameOrigin } from '../../../../server/ledger/http'
import type { LedgerTransactionInput } from '../../../../server/ledger/types'

export const Route = createFileRoute('/api/ledger/transactions/duplicates')({
  server: { handlers: {
    POST: async ({ request }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const ledger = await requireLedger(request); if (ledger instanceof Response) return ledger
      const body = await readJson(request); if (body instanceof Response) return body
      try { return Response.json({ duplicates: await ledger.findDuplicates(body.transaction as LedgerTransactionInput) }) } catch (error) { return errorResponse(error) }
    },
  } },
})

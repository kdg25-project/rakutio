import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, readJson, requireLedger, requireSameOrigin } from '../../../../server/ledger/http'
import type { LedgerTransactionFilter, LedgerTransactionInput } from '../../../../server/ledger/types'

function optionalInteger(value: string | null) { return value == null || value === '' ? undefined : Number(value) }

export const Route = createFileRoute('/api/ledger/transactions/')({
  server: { handlers: {
    GET: async ({ request }) => {
      const ledger = await requireLedger(request); if (ledger instanceof Response) return ledger
      const search = new URL(request.url).searchParams
      const filter: LedgerTransactionFilter = {
        month: search.get('month') ?? undefined, from: search.get('from') ?? undefined, to: search.get('to') ?? undefined,
        categoryId: search.get('categoryId') ?? undefined, type: search.get('type') as LedgerTransactionFilter['type'] ?? undefined,
        merchant: search.get('merchant') ?? undefined, minAmount: optionalInteger(search.get('minAmount')), maxAmount: optionalInteger(search.get('maxAmount')),
        cursor: search.get('cursor') ?? undefined, limit: optionalInteger(search.get('limit')),
      }
      try { return Response.json(await ledger.listTransactions(filter)) } catch (error) { return errorResponse(error) }
    },
    POST: async ({ request }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const ledger = await requireLedger(request); if (ledger instanceof Response) return ledger
      const body = await readJson(request); if (body instanceof Response) return body
      try {
        const result = await ledger.createTransaction(body.transaction as LedgerTransactionInput, body.idempotencyKey, body.overrideDuplicate === true)
        return Response.json(result, { status: result.idempotent ? 200 : 201 })
      } catch (error) { return errorResponse(error) }
    },
  } },
})

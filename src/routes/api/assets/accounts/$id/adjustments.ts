import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, readJson, requireAssets, requireSameOrigin } from '../../../../../server/assets/http'

export const Route = createFileRoute('/api/assets/accounts/$id/adjustments')({
  server: { handlers: {
    POST: async ({ request, params }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const assets = await requireAssets(request); if (assets instanceof Response) return assets
      const body = await readJson(request); if (body instanceof Response) return body
      try { const result = await assets.adjustAccount(params.id, { amount: body.amount, occurredAt: body.occurredAt, memo: body.memo, idempotencyKey: body.idempotencyKey }); return Response.json(result, { status: result.idempotent ? 200 : 201 }) } catch (error) { return errorResponse(error) }
    },
  } },
})

import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, readJson, requireAssets, requireSameOrigin } from '../../../../server/assets/http'

export const Route = createFileRoute('/api/assets/accounts/')({
  server: { handlers: {
    GET: async ({ request }) => {
      const assets = await requireAssets(request); if (assets instanceof Response) return assets
      try { return Response.json({ assets: await assets.listAccounts(new URL(request.url).searchParams.get('includeArchived') !== 'false') }) } catch (error) { return errorResponse(error) }
    },
    POST: async ({ request }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const assets = await requireAssets(request); if (assets instanceof Response) return assets
      const body = await readJson(request); if (body instanceof Response) return body
      try { const result = await assets.createAccount({ type: body.type, name: body.name, initialBalanceAmount: body.initialBalanceAmount, idempotencyKey: body.idempotencyKey }); return Response.json(result, { status: result.idempotent ? 200 : 201 }) } catch (error) { return errorResponse(error) }
    },
  } },
})

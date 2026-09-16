import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, readJson, requireAssets, requireSameOrigin } from '../../../../server/assets/http'

export const Route = createFileRoute('/api/assets/accounts/$id')({
  server: { handlers: {
    PATCH: async ({ request, params }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const assets = await requireAssets(request); if (assets instanceof Response) return assets
      const body = await readJson(request); if (body instanceof Response) return body
      try { return Response.json({ account: await assets.updateAccount(params.id, body) }) } catch (error) { return errorResponse(error) }
    },
  } },
})

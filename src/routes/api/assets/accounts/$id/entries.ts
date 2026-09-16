import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, requireAssets } from '../../../../../server/assets/http'

export const Route = createFileRoute('/api/assets/accounts/$id/entries')({
  server: { handlers: {
    GET: async ({ request, params }) => {
      const assets = await requireAssets(request); if (assets instanceof Response) return assets
      const rawLimit = new URL(request.url).searchParams.get('limit')
      try { return Response.json({ entries: await assets.listEntries(params.id, rawLimit == null ? 100 : Number(rawLimit)) }) } catch (error) { return errorResponse(error) }
    },
  } },
})

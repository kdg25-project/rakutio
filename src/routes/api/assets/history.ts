import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, requireAssets } from '../../../server/assets/http'

export const Route = createFileRoute('/api/assets/history')({
  server: { handlers: {
    GET: async ({ request }) => {
      const assets = await requireAssets(request); if (assets instanceof Response) return assets
      const search = new URL(request.url).searchParams
      try { return Response.json({ history: await assets.balanceHistory({ from: search.get('from'), to: search.get('to') }) }) } catch (error) { return errorResponse(error) }
    },
  } },
})

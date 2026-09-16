import { createFileRoute } from '@tanstack/react-router'

import { assetHistoryRange } from '../../../lib/jst-date'
import { errorResponse, requireAssets } from '../../../server/assets/http'

export const Route = createFileRoute('/api/assets/history')({
  server: { handlers: {
    GET: async ({ request }) => {
      const assets = await requireAssets(request); if (assets instanceof Response) return assets
      const search = new URL(request.url).searchParams
      const fallback = !search.has('from') && !search.has('to') ? assetHistoryRange() : undefined
      try { return Response.json(await assets.balanceHistory({ from: search.get('from') ?? fallback?.from, to: search.get('to') ?? fallback?.to, activeOnly: search.get('activeOnly') === 'true' })) } catch (error) { return errorResponse(error) }
    },
  } },
})

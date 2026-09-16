import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, readJson, requirePlanning, requireSameOrigin } from '../../../../server/planning/http'
import { PlanningError } from '../../../../server/planning/service'

export const Route = createFileRoute('/api/planning/monthly-targets/$id')({
  server: { handlers: {
    GET: async ({ request, params }) => {
      const planning = await requirePlanning(request); if (planning instanceof Response) return planning
      try {
        const target = await planning.getMonthlyTarget(params.id)
        if (!target) throw new PlanningError('NOT_FOUND', '予算・目標が見つかりません。', 404)
        return Response.json({ target })
      } catch (error) { return errorResponse(error) }
    },
    PATCH: async ({ request, params }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const planning = await requirePlanning(request); if (planning instanceof Response) return planning
      const body = await readJson(request); if (body instanceof Response) return body
      try { return Response.json({ target: await planning.updateMonthlyTarget(params.id, body) }) } catch (error) { return errorResponse(error) }
    },
    DELETE: async ({ request, params }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const planning = await requirePlanning(request); if (planning instanceof Response) return planning
      try { await planning.deleteMonthlyTarget(params.id); return new Response(null, { status: 204 }) } catch (error) { return errorResponse(error) }
    },
  } },
})

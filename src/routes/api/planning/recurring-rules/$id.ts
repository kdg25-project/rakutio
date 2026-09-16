import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, readJson, requirePlanning, requireSameOrigin } from '../../../../server/planning/http'
import { PlanningError } from '../../../../server/planning/service'

export const Route = createFileRoute('/api/planning/recurring-rules/$id')({
  server: { handlers: {
    GET: async ({ request, params }) => {
      const planning = await requirePlanning(request); if (planning instanceof Response) return planning
      try {
        const rule = await planning.getRecurringRule(params.id)
        if (!rule) throw new PlanningError('NOT_FOUND', '定期支出が見つかりません。', 404)
        return Response.json({ rule })
      } catch (error) { return errorResponse(error) }
    },
    PATCH: async ({ request, params }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const planning = await requirePlanning(request); if (planning instanceof Response) return planning
      const body = await readJson(request); if (body instanceof Response) return body
      try { return Response.json({ rule: await planning.updateRecurringRule(params.id, body) }) } catch (error) { return errorResponse(error) }
    },
    DELETE: async ({ request, params }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const planning = await requirePlanning(request); if (planning instanceof Response) return planning
      try { return Response.json({ rule: await planning.stopRecurringRule(params.id) }) } catch (error) { return errorResponse(error) }
    },
  } },
})

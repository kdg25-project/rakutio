import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, readJson, requirePlanning, requireSameOrigin } from '../../../../server/planning/http'

export const Route = createFileRoute('/api/planning/recurring-rules/')({
  server: { handlers: {
    GET: async ({ request }) => {
      const planning = await requirePlanning(request); if (planning instanceof Response) return planning
      try { return Response.json({ rules: await planning.listRecurringRules() }) } catch (error) { return errorResponse(error) }
    },
    POST: async ({ request }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const planning = await requirePlanning(request); if (planning instanceof Response) return planning
      const body = await readJson(request); if (body instanceof Response) return body
      try { return Response.json({ rule: await planning.createRecurringRule(body) }, { status: 201 }) } catch (error) { return errorResponse(error) }
    },
  } },
})

import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, requirePlanning, requireSameOrigin } from '../../../../server/planning/http'

export const Route = createFileRoute('/api/planning/recurring-rules/run')({
  server: { handlers: {
    POST: async ({ request }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const planning = await requirePlanning(request); if (planning instanceof Response) return planning
      try { return Response.json({ result: await planning.runDueRecurring() }) } catch (error) { return errorResponse(error) }
    },
  } },
})

import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, readJson, requirePlanning, requireSameOrigin } from '../../../../server/planning/http'

export const Route = createFileRoute('/api/planning/monthly-targets/')({
  server: { handlers: {
    GET: async ({ request }) => {
      const planning = await requirePlanning(request); if (planning instanceof Response) return planning
      try { return Response.json({ targets: await planning.listMonthlyTargets(new URL(request.url).searchParams.get('month') ?? undefined) }) } catch (error) { return errorResponse(error) }
    },
    POST: async ({ request }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const planning = await requirePlanning(request); if (planning instanceof Response) return planning
      const body = await readJson(request); if (body instanceof Response) return body
      try { return Response.json({ target: await planning.createMonthlyTarget(body) }, { status: 201 }) } catch (error) { return errorResponse(error) }
    },
  } },
})

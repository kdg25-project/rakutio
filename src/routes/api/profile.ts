import { createFileRoute } from '@tanstack/react-router'

import { errorResponse, readJson, requireProfile, requireSameOrigin } from '../../server/profile/http'

export const Route = createFileRoute('/api/profile')({
  server: { handlers: {
    GET: async ({ request }) => {
      const profile = await requireProfile(request); if (profile instanceof Response) return profile
      try { return Response.json({ profile: await profile.get() }) } catch (error) { return errorResponse(error) }
    },
    PUT: async ({ request }) => {
      const csrf = requireSameOrigin(request); if (csrf) return csrf
      const profile = await requireProfile(request); if (profile instanceof Response) return profile
      const body = await readJson(request); if (body instanceof Response) return body
      try { return Response.json({ profile: await profile.update(body) }) } catch (error) { return errorResponse(error) }
    },
  } },
})

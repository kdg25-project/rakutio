import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        try {
          const row = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()
          return Response.json({ ok: row?.ok === 1 })
        } catch (error) {
          console.error('D1 health check failed', error)
          return Response.json({ ok: false }, { status: 503 })
        }
      },
    },
  },
})

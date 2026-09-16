import { env } from 'cloudflare:workers'

import { auth } from '../../lib/auth'
import { enforceSameOrigin } from '../request-security'
import { ProfileError, ProfileService } from './service'

export async function requireProfile(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'ログインが必要です。' } }, { status: 401 })
  return new ProfileService(env.DB, session.user.id)
}

export function requireSameOrigin(request: Request) { return enforceSameOrigin(request, env.BETTER_AUTH_URL) }

export async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const payload: unknown = await request.json()
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error()
    return payload as Record<string, unknown>
  } catch {
    return Response.json({ error: { code: 'INVALID_JSON', message: 'JSON の形式が不正です。' } }, { status: 400 })
  }
}

export function errorResponse(error: unknown) {
  if (error instanceof ProfileError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
  console.error('Profile API failed')
  return Response.json({ error: { code: 'INTERNAL_ERROR', message: '処理に失敗しました。時間をおいて再試行してください。' } }, { status: 500 })
}

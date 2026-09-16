import { env } from 'cloudflare:workers'

import { auth } from '../../lib/auth'
import { errorResponse, readJson } from '../ledger/http'
import { enforceSameOrigin } from '../request-security'
import { AssetService } from './service'

export { errorResponse, readJson }

export async function requireAssets(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'ログインが必要です。' } }, { status: 401 })
  return new AssetService(env.DB, session.user.id)
}

export function requireSameOrigin(request: Request) { return enforceSameOrigin(request, env.BETTER_AUTH_URL) }

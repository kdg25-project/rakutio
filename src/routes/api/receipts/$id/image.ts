import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { auth } from '../../../../lib/auth'
import { getReceiptImage, ReceiptStorageError } from '../../../../server/receipts/storage'

function errorResponse(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

export const Route = createFileRoute('/api/receipts/$id/image')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await auth.api.getSession({ headers: request.headers })
        if (!session?.user) return errorResponse(401, 'UNAUTHORIZED', 'ログインが必要です。')

        const page = Number(new URL(request.url).searchParams.get('page') ?? '0')
        if (!Number.isInteger(page) || page < 0) return errorResponse(400, 'INVALID_PAGE', 'ページ番号が不正です。')
        try {
          const { object, mimeType } = await getReceiptImage(env.DB, env.RECEIPTS, session.user.id, params.id, page)
          const headers = new Headers({
            'content-type': object.httpMetadata?.contentType || mimeType,
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
          })
          if (typeof object.size === 'number') headers.set('content-length', String(object.size))
          return new Response(object.body, { headers })
        } catch (error) {
          if (error instanceof ReceiptStorageError) {
            const status = error.code === 'RECEIPT_NOT_FOUND' ? 404 : 503
            return errorResponse(status, error.code, error.message)
          }
          return errorResponse(503, 'RECEIPT_STORAGE_UNAVAILABLE', 'レシート画像を取得できませんでした。')
        }
      },
    },
  },
})

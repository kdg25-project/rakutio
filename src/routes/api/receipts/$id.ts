import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { auth } from '../../../lib/auth'
import { deleteReceiptDraft, getReceiptDraft, ReceiptStorageError } from '../../../server/receipts/storage'
import { enforceSameOrigin } from '../../../server/request-security'

function errorResponse(status: number, code: string, message: string, receiptId?: string) {
  return Response.json({ error: { code, message }, ...(receiptId ? { receiptId } : {}) }, { status })
}

function storageErrorResponse(error: ReceiptStorageError) {
  const status = error.code === 'RECEIPT_NOT_FOUND' ? 404 : error.code === 'RECEIPT_ATTACHED' ? 409 : 503
  return errorResponse(status, error.code, error.message, error.receiptId)
}

export const Route = createFileRoute('/api/receipts/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await auth.api.getSession({ headers: request.headers })
        if (!session?.user) return errorResponse(401, 'UNAUTHORIZED', 'ログインが必要です。')

        try {
          return Response.json({ receipt: await getReceiptDraft(env.DB, session.user.id, params.id) })
        } catch (error) {
          if (error instanceof ReceiptStorageError) return storageErrorResponse(error)
          return errorResponse(503, 'RECEIPT_STORAGE_UNAVAILABLE', 'レシートを取得できませんでした。')
        }
      },
      DELETE: async ({ request, params }) => {
        const originError = enforceSameOrigin(request, env.BETTER_AUTH_URL)
        if (originError) return originError
        const session = await auth.api.getSession({ headers: request.headers })
        if (!session?.user) return errorResponse(401, 'UNAUTHORIZED', 'ログインが必要です。')

        try {
          await deleteReceiptDraft(env.DB, env.RECEIPTS, session.user.id, params.id)
          return new Response(null, { status: 204 })
        } catch (error) {
          if (error instanceof ReceiptStorageError) return storageErrorResponse(error)
          return errorResponse(503, 'RECEIPT_STORAGE_UNAVAILABLE', 'レシートを削除できませんでした。')
        }
      },
    },
  },
})

import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { auth } from '../../../../lib/auth'
import { extractReceipt } from '../../../../ocr/document-ai'
import { OcrConfigurationError, OcrInputError } from '../../../../ocr/receipt'
import { retryReceiptAnalysis } from '../../../../server/receipts/retry'
import { ReceiptStorageError } from '../../../../server/receipts/storage'
import { enforceSameOrigin } from '../../../../server/request-security'

function errorResponse(status: number, code: string, message: string, receiptId?: string) {
  return Response.json({ error: { code, message }, ...(receiptId ? { receiptId } : {}) }, { status })
}

function storageErrorResponse(error: ReceiptStorageError) {
  const status = error.code === 'RECEIPT_NOT_FOUND' ? 404
    : error.code === 'RECEIPT_ATTACHED' || error.code === 'RECEIPT_ANALYSIS_IN_PROGRESS' || error.code === 'RECEIPT_NOT_RETRYABLE' ? 409
      : 503
  return errorResponse(status, error.code, error.message, error.receiptId)
}

export const Route = createFileRoute('/api/receipts/$id/retry')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const originError = enforceSameOrigin(request, env.BETTER_AUTH_URL)
        if (originError) return originError
        const session = await auth.api.getSession({ headers: request.headers })
        if (!session?.user) return errorResponse(401, 'UNAUTHORIZED', 'ログインが必要です。')

        try {
          return Response.json(await retryReceiptAnalysis({
            db: env.DB,
            bucket: env.RECEIPTS,
            userId: session.user.id,
            receiptId: params.id,
            extract: extractReceipt,
          }))
        } catch (error) {
          if (error instanceof ReceiptStorageError) return storageErrorResponse(error)
          if (error instanceof OcrConfigurationError) return errorResponse(503, 'OCR_UNAVAILABLE', error.message, params.id)
          if (error instanceof OcrInputError) return errorResponse(400, 'INVALID_IMAGE', error.message, params.id)
          return errorResponse(502, 'OCR_FAILED', 'OCR に失敗しました。内容を確認して手入力してください。', params.id)
        }
      },
    },
  },
})

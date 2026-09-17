import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { applyGeminiCategories, classifyReceiptItemsWithGemini } from '../../../../ai/gemini'
import { auth } from '../../../../lib/auth'
import { extractReceipt } from '../../../../ocr/document-ai'
import { OcrConfigurationError, OcrInputError, type ReceiptExtraction } from '../../../../ocr/receipt'
import { LedgerService } from '../../../../server/ledger/service'
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

async function categorizeReceipt(userId: string, extraction: ReceiptExtraction) {
  try {
    const categories = await new LedgerService(env.DB, userId).listCategories()
    const classifications = await classifyReceiptItemsWithGemini({
      config: { apiKey: env.GOOGLE_AI_API_KEY, model: env.GOOGLE_AI_MODEL },
      merchant: extraction.merchant,
      items: extraction.items,
      categories: categories.map(({ id, name }) => ({ id, name })),
    })
    return applyGeminiCategories(extraction, classifications)
  } catch { return extraction }
}

export const Route = createFileRoute('/api/receipts/$id/retry')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const originError = enforceSameOrigin(request, env.BETTER_AUTH_URL)
        if (originError) return originError
        const session = await auth.api.getSession({ headers: request.headers })
        if (!session?.user) return errorResponse(401, 'UNAUTHORIZED', 'ログインが必要です。')

        let allPages = false
        try {
          const body = await request.clone().json() as { allPages?: unknown }
          allPages = body.allPages === true
        } catch { /* an empty body retries failed pages only */ }

        try {
          const result = await retryReceiptAnalysis({
            db: env.DB,
            bucket: env.RECEIPTS,
            userId: session.user.id,
            receiptId: params.id,
            extract: extractReceipt,
            categorize: (extraction) => categorizeReceipt(session.user.id, extraction),
            allPages,
          })
          return Response.json(result.receipt ? result : { ...result, error: { code: 'OCR_FAILED', message: 'OCR に失敗しました。内容を確認して手入力してください。' } }, { status: result.receipt ? 200 : 502 })
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

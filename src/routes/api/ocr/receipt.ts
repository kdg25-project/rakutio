import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { auth } from '../../../lib/auth'
import { extractReceipt } from '../../../ocr/document-ai'
import { OcrConfigurationError, OcrInputError } from '../../../ocr/receipt'
import { createReceiptDraft, markReceiptAnalysis, ReceiptStorageError } from '../../../server/receipts/storage'
import { readBoundedMultipartFormData } from '../../../server/receipts/multipart'
import { enforceSameOrigin } from '../../../server/request-security'
import { validateReceiptUploads } from '../../../server/receipts/upload'
import { analyzeReceiptPages } from '../../../server/receipts/process'

function errorResponse(status: number, code: string, message: string, receiptId?: string) {
  return Response.json({ error: { code, message }, ...(receiptId ? { receiptId } : {}) }, { status })
}

export const Route = createFileRoute('/api/ocr/receipt')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const originError = enforceSameOrigin(request, env.BETTER_AUTH_URL)
        if (originError) return originError
        const session = await auth.api.getSession({ headers: request.headers })
        if (!session?.user) return errorResponse(401, 'UNAUTHORIZED', 'ログインが必要です。')

        let formData: FormData
        try {
          formData = await readBoundedMultipartFormData(request)
        } catch (error) {
          if (error instanceof OcrInputError) return errorResponse(400, 'INVALID_IMAGE', error.message)
          return errorResponse(400, 'INVALID_MULTIPART', '画像フォームを読み取れませんでした。')
        }

        // `image` remains supported for existing clients; new clients append
        // ordered pages under the repeated `images` field.
        const images = formData.getAll('images').filter((value): value is File => value instanceof File)
        const legacy = formData.get('image')
        if (!images.length && legacy instanceof File) images.push(legacy)
        if (!images.length) {
          return errorResponse(400, 'INVALID_IMAGE', '画像を選択してください。')
        }

        try {
          await validateReceiptUploads(images)
        } catch (error) {
          if (error instanceof OcrInputError) return errorResponse(400, 'INVALID_IMAGE', error.message)
          return errorResponse(400, 'INVALID_IMAGE', '画像を確認できませんでした。')
        }

        const receiptId = crypto.randomUUID()
        try {
          await createReceiptDraft({
            db: env.DB,
            bucket: env.RECEIPTS,
            id: receiptId,
            userId: session.user.id,
            images,
          })
        } catch (error) {
          if (error instanceof ReceiptStorageError) return errorResponse(503, error.code, error.message, error.receiptId)
          return errorResponse(503, 'RECEIPT_STORAGE_UNAVAILABLE', '画像を保存できませんでした。時間をおいて再試行してください。')
        }

        try {
          const processed = await analyzeReceiptPages({ images: images.map((image, pageIndex) => ({ image, pageIndex })), extract: extractReceipt })
          await markReceiptAnalysis(env.DB, session.user.id, receiptId, processed.pages, processed.receipt)
          const payload = { receipt: processed.receipt, receiptId, pageCount: images.length, pages: processed.pages.map(({ pageIndex, status, errorCode, errorMessage }) => ({ pageIndex, status, errorCode, errorMessage })) }
          return Response.json(processed.receipt ? payload : { ...payload, error: { code: 'OCR_FAILED', message: 'OCR に失敗しました。内容を確認して手入力してください。' } }, { status: processed.receipt ? 200 : 502 })
        } catch (error) {
          if (error instanceof OcrConfigurationError) return errorResponse(503, 'OCR_UNAVAILABLE', error.message, receiptId)
          if (error instanceof OcrInputError) return errorResponse(400, 'INVALID_IMAGE', error.message, receiptId)
          if (error instanceof ReceiptStorageError) return errorResponse(503, error.code, error.message, receiptId)
          return errorResponse(502, 'OCR_FAILED', 'OCR に失敗しました。内容を確認して手入力してください。', receiptId)
        }
      },
    },
  },
})

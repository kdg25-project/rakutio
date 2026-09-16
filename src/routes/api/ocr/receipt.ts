import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { auth } from '../../../lib/auth'
import { extractReceipt } from '../../../ocr/document-ai'
import { OcrConfigurationError, OcrInputError } from '../../../ocr/receipt'
import { createReceiptDraft, markReceiptAnalyzed, markReceiptFailed, ReceiptStorageError } from '../../../server/receipts/storage'
import { readBoundedMultipartFormData } from '../../../server/receipts/multipart'
import { enforceSameOrigin } from '../../../server/request-security'
import { validateReceiptUpload } from '../../../server/receipts/upload'

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

        const image = formData.get('image')
        if (!(image instanceof File)) {
          return errorResponse(400, 'INVALID_IMAGE', '画像を選択してください。')
        }

        try {
          await validateReceiptUpload(image)
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
            mimeType: image.type,
            image,
          })
        } catch (error) {
          if (error instanceof ReceiptStorageError) return errorResponse(503, error.code, error.message, error.receiptId)
          return errorResponse(503, 'RECEIPT_STORAGE_UNAVAILABLE', '画像を保存できませんでした。時間をおいて再試行してください。')
        }

        try {
          const result = await extractReceipt(image)
          await markReceiptAnalyzed(env.DB, session.user.id, receiptId, result)
          return Response.json({ receipt: result, receiptId })
        } catch (error) {
          await markReceiptFailed(env.DB, session.user.id, receiptId)
          if (error instanceof OcrConfigurationError) return errorResponse(503, 'OCR_UNAVAILABLE', error.message, receiptId)
          if (error instanceof OcrInputError) return errorResponse(400, 'INVALID_IMAGE', error.message, receiptId)
          if (error instanceof ReceiptStorageError) return errorResponse(503, error.code, error.message, receiptId)
          return errorResponse(502, 'OCR_FAILED', 'OCR に失敗しました。内容を確認して手入力してください。', receiptId)
        }
      },
    },
  },
})

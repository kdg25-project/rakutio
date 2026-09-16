import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { auth } from '../../../lib/auth'
import { extractReceipt } from '../../../ocr/document-ai'
import { OcrConfigurationError, OcrInputError } from '../../../ocr/receipt'
import { createReceiptDraft, markReceiptAnalyzed, markReceiptFailed, ReceiptStorageError } from '../../../server/receipts/storage'
import { enforceSameOrigin } from '../../../server/request-security'
import { validateReceiptUpload } from '../../../server/receipts/upload'

const MAX_MULTIPART_BYTES = 8 * 1024 * 1024 + 64 * 1024

async function readBoundedFormData(request: Request) {
  const contentType = request.headers.get('content-type')
  const contentLength = Number(request.headers.get('content-length'))
  if (!contentType?.startsWith('multipart/form-data') || !request.body) {
    throw new OcrInputError('画像ファイルを含むフォームを送信してください。')
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
    throw new OcrInputError('画像は 8 MB 以下にしてください。')
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_MULTIPART_BYTES) {
      await reader.cancel()
      throw new OcrInputError('画像は 8 MB 以下にしてください。')
    }
    chunks.push(value)
  }

  try {
    const body = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return await new Response(new Blob([body.buffer], { type: contentType })).formData()
  } catch {
    throw new OcrInputError('送信された画像フォームを読み取れませんでした。')
  }
}

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
          formData = await readBoundedFormData(request)
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

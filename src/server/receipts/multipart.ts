import { OcrInputError } from '../../ocr/receipt'

export const MAX_MULTIPART_BYTES = 6 * 8 * 1024 * 1024 + 256 * 1024

/**
 * Reads the upload body with a hard bound before using the platform multipart
 * parser. The original Content-Type header must be retained verbatim: multipart
 * boundaries are case-sensitive, while Blob#type normalizes its value.
 */
export async function readBoundedMultipartFormData(request: Request): Promise<FormData> {
  const contentType = request.headers.get('content-type')
  const contentLength = Number(request.headers.get('content-length'))
  if (!contentType?.startsWith('multipart/form-data') || !request.body) {
    throw new OcrInputError('画像ファイルを含むフォームを送信してください。')
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
    throw new OcrInputError('画像は合計 48 MB 以下にしてください。')
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
      throw new OcrInputError('画像は合計 48 MB 以下にしてください。')
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

    // Do not wrap in Blob. Blob#type lowercases the boundary parameter, which
    // makes browser-generated boundaries such as WebKitFormBoundary unreadable.
    return await new Response(body, { headers: { 'content-type': contentType } }).formData()
  } catch {
    throw new OcrInputError('送信された画像フォームを読み取れませんでした。')
  }
}

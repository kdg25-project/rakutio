import { OcrInputError } from '../../ocr/receipt'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const supportedImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])

function hasValidSignature(type: string, bytes: Uint8Array) {
  if (type === 'image/png') return bytes.length >= 8 && bytes.slice(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
}

/** Validate before the untrusted image is persisted in private R2. */
export async function validateReceiptUpload(file: File) {
  if (!supportedImageTypes.has(file.type)) throw new OcrInputError('PNG、JPEG、WebP の画像を選択してください。')
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) throw new OcrInputError('画像は 1 バイト以上 8 MB 以下にしてください。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!hasValidSignature(file.type, bytes)) throw new OcrInputError('画像形式を確認できませんでした。')
}

import type { ReceiptExtraction } from '../../ocr/receipt'

import { beginReceiptRetry, loadReceiptRetryImage, markReceiptAnalyzed, markReceiptFailed, type ReceiptBucket } from './storage'

export async function retryReceiptAnalysis(input: {
  db: D1Database
  bucket: ReceiptBucket
  userId: string
  receiptId: string
  extract: (image: File) => Promise<ReceiptExtraction>
}) {
  let claimed = false
  try {
    await beginReceiptRetry(input.db, input.userId, input.receiptId)
    claimed = true
    const image = await loadReceiptRetryImage(input.db, input.bucket, input.userId, input.receiptId)
    const receipt = await input.extract(image)
    await markReceiptAnalyzed(input.db, input.userId, input.receiptId, receipt)
    return { receipt, receiptId: input.receiptId }
  } catch (error) {
    // Never alter a pending draft unless this request first claimed it. This
    // prevents a duplicate retry from turning another active OCR request into
    // a failed draft.
    if (claimed) await markReceiptFailed(input.db, input.userId, input.receiptId)
    throw error
  }
}

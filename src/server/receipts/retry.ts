import type { ReceiptExtraction } from '../../ocr/receipt'

import { beginReceiptRetry, loadReceiptRetryImages, markReceiptAnalysis, type ReceiptBucket } from './storage'
import { analyzeReceiptPages } from './process'

export async function retryReceiptAnalysis(input: {
  db: D1Database
  bucket: ReceiptBucket
  userId: string
  receiptId: string
  extract: (image: File) => Promise<ReceiptExtraction>
  allPages?: boolean
}) {
  let claimed = false
  try {
    const claim = await beginReceiptRetry(input.db, input.userId, input.receiptId, input.allPages)
    claimed = true
    const images = await loadReceiptRetryImages(input.db, input.bucket, input.userId, input.receiptId, claim.pages.map((page) => page.pageIndex))
    const processed = await analyzeReceiptPages({ images, extract: input.extract, existingPages: claim.existingPages })
    await markReceiptAnalysis(input.db, input.userId, input.receiptId, processed.pages, processed.receipt)
    return { receipt: processed.receipt, receiptId: input.receiptId, pageCount: processed.pages.length, pages: processed.pages.map(({ pageIndex, status, errorCode, errorMessage }) => ({ pageIndex, status, errorCode, errorMessage })) }
  } catch (error) {
    // Never alter a pending draft unless this request first claimed it. This
    // prevents a duplicate retry from turning another active OCR request into
    // a failed draft.
    // Page-level failures are persisted by markReceiptAnalysis above. A
    // storage/provider failure before that point leaves the draft retryable.
    throw error
  }
}

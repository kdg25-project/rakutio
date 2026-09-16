import type { ReceiptExtraction } from '../../ocr/receipt'

export type ReceiptPageAnalysis = {
  pageIndex: number
  status: 'analyzed' | 'failed'
  receipt: ReceiptExtraction | null
  errorCode: string | null
  errorMessage: string | null
}

function itemKey(item: ReceiptExtraction['items'][number]) {
  // Only eliminate an exact normalized duplicate. Similar names or a missing
  // amount remain separate because they may be distinct purchases.
  return `${item.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ja-JP')}\u0000${item.quantity ?? ''}\u0000${item.amount ?? ''}`
}

/** Merge page OCR without adding receipt totals from each page. */
export function mergeReceiptPages(pages: ReceiptPageAnalysis[]): ReceiptExtraction | null {
  const successful = pages.filter((page): page is ReceiptPageAnalysis & { receipt: ReceiptExtraction } => page.status === 'analyzed' && page.receipt !== null)
  if (!successful.length) return null

  const seen = new Set<string>()
  const items = successful.flatMap((page) => page.receipt.items).filter((item) => {
    const key = itemKey(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  // The final page is normally where a multi-page receipt prints the amount
  // due. We choose it, rather than adding page totals, to avoid double-counts.
  const finalWithTotal = [...successful].reverse().find((page) => page.receipt.total !== null)
  const finalWithTax = [...successful].reverse().find((page) => page.receipt.tax !== null)
  const firstMerchant = successful.find((page) => page.receipt.merchant)?.receipt.merchant ?? null
  const firstDate = successful.find((page) => page.receipt.purchasedAt)?.receipt.purchasedAt ?? null
  const currencySource = finalWithTotal ?? successful.find((page) => page.receipt.currency)

  return {
    merchant: firstMerchant,
    purchasedAt: firstDate,
    total: finalWithTotal?.receipt.total ?? null,
    tax: finalWithTax?.receipt.tax ?? null,
    currency: currencySource?.receipt.currency ?? null,
    items,
  }
}

export function ocrFailure(error: unknown): Pick<ReceiptPageAnalysis, 'errorCode' | 'errorMessage'> {
  if (error instanceof Error) return { errorCode: error.name || 'OCR_FAILED', errorMessage: error.message.slice(0, 500) }
  return { errorCode: 'OCR_FAILED', errorMessage: 'OCR に失敗しました。' }
}

import type { ReceiptExtraction } from '../../ocr/receipt'
import { mergeReceiptPages, ocrFailure, type ReceiptPageAnalysis } from './analysis'
import type { PersistedReceiptPage } from './storage'

export async function analyzeReceiptPages(input: {
  images: Array<{ pageIndex: number; image: File }>
  extract: (image: File) => Promise<ReceiptExtraction>
  existingPages?: PersistedReceiptPage[]
}): Promise<{ pages: ReceiptPageAnalysis[]; receipt: ReceiptExtraction | null }> {
  const submitted = new Set(input.images.map((page) => page.pageIndex))
  const pages: ReceiptPageAnalysis[] = (input.existingPages ?? [])
    .filter((page) => !submitted.has(page.pageIndex))
    .map((page) => ({
      pageIndex: page.pageIndex,
      status: page.analysisStatus === 'analyzed' && page.analysisJson ? 'analyzed' : 'failed',
      receipt: page.analysisStatus === 'analyzed' && page.analysisJson ? JSON.parse(page.analysisJson) as ReceiptExtraction : null,
      errorCode: page.errorCode,
      errorMessage: page.errorMessage,
    }))

  for (const page of input.images) {
    try {
      pages.push({ pageIndex: page.pageIndex, status: 'analyzed', receipt: await input.extract(page.image), errorCode: null, errorMessage: null })
    } catch (error) {
      const failure = ocrFailure(error)
      pages.push({ pageIndex: page.pageIndex, status: 'failed', receipt: null, ...failure })
    }
  }
  pages.sort((left, right) => left.pageIndex - right.pageIndex)
  return { pages, receipt: mergeReceiptPages(pages) }
}

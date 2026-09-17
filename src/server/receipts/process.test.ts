import { describe, expect, it, vi } from 'vitest'

import { DocumentAiRequestError } from '../../ocr/receipt'
import { analyzeReceiptPages } from './process'

function page(index: number) {
  return { pageIndex: index, image: new File([new Uint8Array([index])], `${index}.png`, { type: 'image/png' }) }
}

describe('multi-page receipt processing', () => {
  it('keeps ordered distinct line items, removes exact duplicates, and never adds page totals', async () => {
    const extract = vi.fn(async (image: File) => image.name === '0.png'
      ? { merchant: '店舗', purchasedAt: '2026-09-16', total: 1000, tax: 100, currency: 'JPY', items: [{ name: '牛乳', quantity: 1, amount: 200 }, { name: 'パン', quantity: 1, amount: 300 }] }
      : { merchant: null, purchasedAt: null, total: 1500, tax: 150, currency: 'JPY', items: [{ name: 'パン', quantity: 1, amount: 300 }, { name: '卵', quantity: 1, amount: 500 }] })

    const result = await analyzeReceiptPages({ images: [page(0), page(1)], extract })

    expect(result.receipt).toEqual({ merchant: '店舗', purchasedAt: '2026-09-16', total: 1500, tax: 150, currency: 'JPY', items: [{ name: '牛乳', quantity: 1, amount: 200 }, { name: 'パン', quantity: 1, amount: 300 }, { name: '卵', quantity: 1, amount: 500 }] })
    expect(result.pages.map((item) => item.status)).toEqual(['analyzed', 'analyzed'])
  })

  it('persists a usable partial result and identifies the failed page', async () => {
    const result = await analyzeReceiptPages({
      images: [page(0), page(1)],
      extract: vi.fn(async (image: File) => {
        if (image.name === '1.png') throw new Error('Document AI timeout')
        return { merchant: '店舗', purchasedAt: null, total: 900, tax: null, currency: 'JPY', items: [] }
      }),
    })

    expect(result.receipt).toMatchObject({ merchant: '店舗', total: 900 })
    expect(result.pages).toMatchObject([{ pageIndex: 0, status: 'analyzed' }, { pageIndex: 1, status: 'failed', errorMessage: 'Document AI timeout' }])
  })

  it('preserves classified Document AI failures for storage and the client response', async () => {
    const result = await analyzeReceiptPages({
      images: [page(0)],
      extract: vi.fn(async () => {
        throw new DocumentAiRequestError('読み取りサービスへの権限がありません。', 'DOCUMENT_AI_PERMISSION_DENIED', 403, 'PERMISSION_DENIED', 403)
      }),
    })

    expect(result).toMatchObject({
      receipt: null,
      pages: [{ pageIndex: 0, status: 'failed', errorCode: 'DOCUMENT_AI_PERMISSION_DENIED', errorMessage: '読み取りサービスへの権限がありません。' }],
    })
  })
})

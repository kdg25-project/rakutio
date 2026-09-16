import { describe, expect, it, vi } from 'vitest'

import { retryReceiptAnalysis } from './retry'
import { beginReceiptRetry } from './storage'

type ReceiptState = {
  ownerId: string
  status: 'failed' | 'pending' | 'analyzed' | 'deleting'
  attached: boolean
  analysisJson: string | null
}

function retryDatabase(initial: Partial<ReceiptState> = {}) {
  const state: ReceiptState = { ownerId: 'owner-1', status: 'failed', attached: false, analysisJson: null, ...initial }
  const db = {
    prepare(sql: string) {
      let values: unknown[] = []
      const prepared = {
        bind(...next: unknown[]) { values = next; return prepared },
        async first() {
          if (sql.includes('FROM "receipt"') || sql.includes('FROM receipt')) {
            return values[0] === 'receipt-1' && values[1] === state.ownerId
              ? { id: 'receipt-1', userId: state.ownerId, objectKey: `receipts/${state.ownerId}/receipt-1`, mimeType: 'image/png', byteSize: 8, analysisStatus: state.status, analysisJson: state.analysisJson, createdAt: 1, analyzedAt: null }
              : null
          }
          if (sql.includes('FROM "ledger_transaction"') || sql.includes('FROM ledger_transaction')) return state.attached ? { id: 'transaction-1' } : null
          return null
        },
        async run() {
          const id = values.at(-2) === 'receipt-1' ? values.at(-2) : values[0]
          const ownerId = values.includes(state.ownerId)
          if (sql.includes("SET analysis_status = 'pending'")) {
            if (id === 'receipt-1' && ownerId && state.status === 'failed' && !state.attached) { state.status = 'pending'; state.analysisJson = null; return { meta: { changes: 1 } } }
            return { meta: { changes: 0 } }
          }
          if (sql.includes("SET analysis_status = 'analyzed'")) {
            if (state.status === 'pending' && !state.attached) { state.status = 'analyzed'; state.analysisJson = String(values[0]); return { meta: { changes: 1 } } }
            return { meta: { changes: 0 } }
          }
          if (sql.includes("SET analysis_status = 'failed'")) {
            if (state.status === 'pending' && !state.attached) state.status = 'failed'
            return { meta: { changes: 1 } }
          }
          return { meta: { changes: 0 } }
        },
      }
      return prepared
    },
  } as unknown as D1Database
  return { db, state }
}

function retryBucket() {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  return {
    put: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(async () => ({ body: new Blob([bytes]).stream() as unknown as ReadableStream, httpMetadata: { contentType: 'image/png' }, size: bytes.byteLength })),
  }
}

describe('saved receipt OCR retry', () => {
  it('loads the private original for a failed owned draft and persists the retried analysis', async () => {
    const local = retryDatabase(); const bucket = retryBucket()
    const extract = vi.fn(async (image: File) => {
      expect(image.type).toBe('image/png')
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
      return { merchant: 'テスト店', purchasedAt: null, total: 100, currency: 'JPY', items: [] }
    })

    await expect(retryReceiptAnalysis({ db: local.db, bucket, userId: 'owner-1', receiptId: 'receipt-1', extract })).resolves.toMatchObject({ receiptId: 'receipt-1', receipt: { total: 100 } })
    expect(extract).toHaveBeenCalledOnce()
    expect(bucket.get).toHaveBeenCalledWith('receipts/owner-1/receipt-1')
    expect(bucket.put).not.toHaveBeenCalled()
    expect(local.state).toMatchObject({ status: 'analyzed' })
  })

  it('retains the original draft as failed when the OCR provider rejects', async () => {
    const local = retryDatabase(); const bucket = retryBucket()
    const extract = vi.fn(async () => { throw new Error('provider unavailable') })

    await expect(retryReceiptAnalysis({ db: local.db, bucket, userId: 'owner-1', receiptId: 'receipt-1', extract })).resolves.toMatchObject({ receipt: null, pages: [{ pageIndex: 0, status: 'failed' }] })
    expect(extract).toHaveBeenCalledOnce()
    expect(bucket.get).toHaveBeenCalledOnce()
    expect(local.state.status).toBe('failed')
    expect(bucket.delete).not.toHaveBeenCalled()
  })

  it('does not disclose another owner draft or let a duplicate retry claim a pending analysis', async () => {
    const foreign = retryDatabase()
    await expect(beginReceiptRetry(foreign.db, 'other-user', 'receipt-1')).rejects.toMatchObject({ code: 'RECEIPT_NOT_FOUND' })

    const local = retryDatabase()
    await expect(beginReceiptRetry(local.db, 'owner-1', 'receipt-1')).resolves.toMatchObject({ objectKey: 'receipts/owner-1/receipt-1' })
    await expect(beginReceiptRetry(local.db, 'owner-1', 'receipt-1')).rejects.toMatchObject({ code: 'RECEIPT_ANALYSIS_IN_PROGRESS' })
    expect(local.state.status).toBe('pending')
  })

  it('does not revive a draft once deletion or transaction attachment wins the retry race', async () => {
    const deleted = retryDatabase()
    await expect(retryReceiptAnalysis({
      db: deleted.db,
      bucket: retryBucket(),
      userId: 'owner-1',
      receiptId: 'receipt-1',
      extract: vi.fn(async () => {
        deleted.state.status = 'deleting'
        return { merchant: null, purchasedAt: null, total: null, currency: null, items: [] }
      }),
    })).rejects.toMatchObject({ code: 'RECEIPT_NOT_FOUND' })
    expect(deleted.state.status).toBe('deleting')

    const attached = retryDatabase({ attached: true })
    await expect(retryReceiptAnalysis({ db: attached.db, bucket: retryBucket(), userId: 'owner-1', receiptId: 'receipt-1', extract: vi.fn() })).rejects.toMatchObject({ code: 'RECEIPT_ATTACHED' })
    expect(attached.state.status).toBe('failed')
  })
})

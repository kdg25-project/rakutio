import { describe, expect, it, vi } from 'vitest'

import {
  createReceiptDraft,
  deleteReceiptDraft,
  getReceiptDraft,
  ReceiptStorageError,
} from './storage'

const row = {
  id: 'receipt-1',
  userId: 'owner-1',
  objectKey: 'receipts/owner-1/receipt-1',
  mimeType: 'image/png',
  byteSize: 8,
  analysisStatus: 'failed' as const,
  analysisJson: null,
  createdAt: 100,
  analyzedAt: 120,
}

function database(options: { owned?: boolean; attached?: boolean; insertFails?: boolean } = {}) {
  const run = vi.fn((result: { meta: { changes: number } }) => result)
  const first = vi.fn(async () => undefined)
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: async () => {
        if (sql.includes('FROM "receipt"') || sql.includes('FROM receipt')) {
          return options.owned === false || values[1] !== 'owner-1' ? null : row
        }
        if (sql.includes('ledger_transaction')) return options.attached ? { id: 'transaction-1' } : null
        return first()
      },
      run: async () => {
        if (sql.startsWith('INSERT INTO')) {
          if (options.insertFails) throw new Error('D1 unavailable')
          return run({ meta: { changes: 1 } })
        }
        if (sql.includes("SET analysis_status = 'deleting'")) return run({ meta: { changes: options.attached ? 0 : 1 } })
        return run({ meta: { changes: 1 } })
      },
    }),
  }))
  return { db: { prepare } as unknown as D1Database, prepare, run }
}

function bucket(options: { deleteFailsOnce?: boolean } = {}) {
  const objects = new Map<string, ArrayBuffer>()
  let shouldFailDelete = options.deleteFailsOnce
  return {
    objects,
    put: vi.fn(async (key: string, bytes: ArrayBuffer) => { objects.set(key, bytes) }),
    get: vi.fn(async () => null),
    delete: vi.fn(async (key: string) => {
      if (shouldFailDelete) {
        shouldFailDelete = false
        throw new Error('R2 unavailable')
      }
      objects.delete(key)
    }),
  }
}

describe('receipt storage', () => {
  it('creates the durable draft before putting its original image in private R2', async () => {
    const databaseMock = database()
    const bucketMock = bucket()
    const image = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'not-stored.png', { type: 'image/png' })

    await expect(createReceiptDraft({
      db: databaseMock.db,
      bucket: bucketMock,
      id: 'receipt-1',
      userId: 'owner-1',
      mimeType: 'image/png',
      image,
      now: 100,
    })).resolves.toEqual({ id: 'receipt-1', objectKey: 'receipts/owner-1/receipt-1', createdAt: 100 })

    expect(bucketMock.put).toHaveBeenCalledWith('receipts/owner-1/receipt-1', expect.any(ArrayBuffer), { httpMetadata: { contentType: 'image/png' } })
    expect(databaseMock.prepare.mock.invocationCallOrder[0]).toBeLessThan(bucketMock.put.mock.invocationCallOrder[0]!)
  })

  it('does not disclose a receipt draft across owners', async () => {
    const databaseMock = database({ owned: false })

    await expect(getReceiptDraft(databaseMock.db, 'other-user', 'receipt-1')).rejects.toMatchObject({ code: 'RECEIPT_NOT_FOUND' })
  })

  it('keeps a failed OCR draft retrievable for manual entry', async () => {
    const databaseMock = database()

    await expect(getReceiptDraft(databaseMock.db, 'owner-1', 'receipt-1')).resolves.toEqual({
      id: 'receipt-1',
      mimeType: 'image/png',
      byteSize: 8,
      analysisStatus: 'failed',
      analysis: null,
      createdAt: 100,
      analyzedAt: 120,
    })
  })

  it('refuses deletion when a transaction is attached before its durable deletion transition', async () => {
    const databaseMock = database({ attached: true })
    const bucketMock = bucket()

    await expect(deleteReceiptDraft(databaseMock.db, bucketMock, 'owner-1', 'receipt-1')).rejects.toMatchObject({ code: 'RECEIPT_ATTACHED' })
    expect(bucketMock.delete).not.toHaveBeenCalled()
  })

  it('never writes an R2 object when D1 cannot create its durable record', async () => {
    const databaseMock = database({ insertFails: true })
    const bucketMock = bucket()
    const image = new File([new Uint8Array([1])], 'ignored.png', { type: 'image/png' })

    await expect(createReceiptDraft({ db: databaseMock.db, bucket: bucketMock, id: 'receipt-1', userId: 'owner-1', mimeType: 'image/png', image })).rejects.toMatchObject({ code: 'RECEIPT_STORAGE_UNAVAILABLE' })
    expect(bucketMock.put).not.toHaveBeenCalled()
    expect(bucketMock.delete).not.toHaveBeenCalled()
  })

  it('retains a deleting tombstone after an R2 failure and cleans it on retry', async () => {
    const databaseMock = database()
    const bucketMock = bucket({ deleteFailsOnce: true })

    await expect(deleteReceiptDraft(databaseMock.db, bucketMock, 'owner-1', 'receipt-1')).rejects.toMatchObject({
      code: 'RECEIPT_STORAGE_UNAVAILABLE',
      receiptId: 'receipt-1',
    })
    expect(databaseMock.prepare.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM'))).toBe(false)

    await expect(deleteReceiptDraft(databaseMock.db, bucketMock, 'owner-1', 'receipt-1')).resolves.toBeUndefined()
    expect(bucketMock.delete).toHaveBeenCalledTimes(2)
    expect(databaseMock.prepare.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM'))).toBe(true)
  })
})

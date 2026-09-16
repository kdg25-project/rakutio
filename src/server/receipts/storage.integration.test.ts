import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { retryReceiptAnalysis } from './retry'
import { createReceiptDraft, getReceiptDraft, markReceiptAnalysis, type ReceiptBucket } from './storage'

function localD1() {
  const sqlite = new DatabaseSync(':memory:')
  const db = {
    prepare(sql: string) {
      let values: unknown[] = []
      const statement = {
        bind(...next: unknown[]) { values = next; return statement },
        async first<T>() { return (sqlite.prepare(sql).get(...values) ?? null) as T | null },
        async all<T>() { return { results: sqlite.prepare(sql).all(...values) as T[], success: true, meta: { changes: 0 } } },
        async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } } },
      }
      return statement as unknown as D1PreparedStatement
    },
    async exec(sql: string) { sqlite.exec(sql); return { count: 0, duration: 0 } },
  } as unknown as D1Database
  return { db, close: () => sqlite.close() }
}

async function migrate(db: D1Database) {
  for (const name of ['0000_ancient_spiral.sql', '0001_ledger_core.sql', '0002_assets.sql', '0003_planning.sql', '0004_asset_balance_bounds.sql', '0005_utility_item_kind.sql', '0006_asset_cascade_delete_guard.sql', '0007_bank_account_details.sql', '0008_user_profile_preferences.sql', '0009_receipt_pages.sql']) {
    for (const statement of (await readFile(resolve(process.cwd(), 'drizzle', name), 'utf8')).split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) await db.exec(statement)
  }
  await db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)').bind('owner', 'owner', 'owner@example.test').run()
}

function bucket(): ReceiptBucket & { objects: Map<string, ArrayBuffer> } {
  const objects = new Map<string, ArrayBuffer>()
  return {
    objects,
    put: vi.fn(async (key: string, value: ArrayBuffer) => { objects.set(key, value) }),
    get: vi.fn(async (key: string) => { const bytes = objects.get(key); return bytes ? { body: new Blob([bytes]).stream(), size: bytes.byteLength, httpMetadata: { contentType: 'image/png' } } : null }),
    delete: vi.fn(async (key: string) => { objects.delete(key) }),
  }
}

const png = (name: string) => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' })

describe('receipt pages local D1 integration', () => {
  const closers: Array<() => void> = []
  afterEach(() => closers.splice(0).forEach((close) => close()))

  it('stores two ordered originals and retains page-level partial OCR state', async () => {
    const local = localD1(); closers.push(local.close); await migrate(local.db); const r2 = bucket()
    await createReceiptDraft({ db: local.db, bucket: r2, id: 'r1', userId: 'owner', images: [png('0.png'), png('1.png')], now: 10 })
    await markReceiptAnalysis(local.db, 'owner', 'r1', [
      { pageIndex: 0, status: 'analyzed', receipt: { merchant: '店舗', purchasedAt: null, total: 100, tax: null, currency: 'JPY', items: [{ name: '牛乳', quantity: 1, amount: 100 }] }, errorCode: null, errorMessage: null },
      { pageIndex: 1, status: 'failed', receipt: null, errorCode: 'DocumentAiRequestError', errorMessage: 'timeout' },
    ], { merchant: '店舗', purchasedAt: null, total: 100, tax: null, currency: 'JPY', items: [{ name: '牛乳', quantity: 1, amount: 100 }] }, 20)
    const draft = await getReceiptDraft(local.db, 'owner', 'r1')
    expect(draft).toMatchObject({ pageCount: 2, analysisStatus: 'analyzed', pages: [{ pageIndex: 0, analysisStatus: 'analyzed' }, { pageIndex: 1, analysisStatus: 'failed', errorMessage: 'timeout' }] })
    expect([...r2.objects.keys()]).toEqual(['receipts/owner/r1', 'receipts/owner/r1/pages/1'])
  })

  it('retries only failed pages and merges them without adding totals', async () => {
    const local = localD1(); closers.push(local.close); await migrate(local.db); const r2 = bucket()
    await createReceiptDraft({ db: local.db, bucket: r2, id: 'r2', userId: 'owner', images: [png('0.png'), png('1.png')] })
    await markReceiptAnalysis(local.db, 'owner', 'r2', [
      { pageIndex: 0, status: 'analyzed', receipt: { merchant: '店舗', purchasedAt: '2026-09-16', total: 1000, tax: null, currency: 'JPY', items: [{ name: '牛乳', quantity: 1, amount: 200 }] }, errorCode: null, errorMessage: null },
      { pageIndex: 1, status: 'failed', receipt: null, errorCode: 'timeout', errorMessage: 'timeout' },
    ], { merchant: '店舗', purchasedAt: '2026-09-16', total: 1000, tax: null, currency: 'JPY', items: [{ name: '牛乳', quantity: 1, amount: 200 }] })
    const extract = vi.fn(async (image: File) => { expect(image.name).toBe('receipt-r2-1'); return { merchant: null, purchasedAt: null, total: 1500, tax: 150, currency: 'JPY', items: [{ name: '牛乳', quantity: 1, amount: 200 }, { name: '卵', quantity: 1, amount: 500 }] } })
    const result = await retryReceiptAnalysis({ db: local.db, bucket: r2, userId: 'owner', receiptId: 'r2', extract })
    expect(extract).toHaveBeenCalledOnce()
    expect(result.receipt).toEqual({ merchant: '店舗', purchasedAt: '2026-09-16', total: 1500, tax: 150, currency: 'JPY', items: [{ name: '牛乳', quantity: 1, amount: 200 }, { name: '卵', quantity: 1, amount: 500 }] })
    expect(result.pages).toMatchObject([{ pageIndex: 0, status: 'analyzed' }, { pageIndex: 1, status: 'analyzed' }])
  })

  it('reads a pre-migration single-image receipt as page zero', async () => {
    const local = localD1(); closers.push(local.close); await migrate(local.db)
    await local.db.prepare("INSERT INTO receipt (id, user_id, object_key, mime_type, byte_size, analysis_status, created_at) VALUES ('legacy', 'owner', 'receipts/owner/legacy', 'image/png', 8, 'failed', 1)").run()
    // A real migration backfills this row. Removing the page also verifies the
    // service fallback for an interrupted migration or legacy test fixture.
    await local.db.prepare("DELETE FROM receipt_page WHERE receipt_id = 'legacy'").run()
    await expect(getReceiptDraft(local.db, 'owner', 'legacy')).resolves.toMatchObject({ pageCount: 1, pages: [{ pageIndex: 0, analysisStatus: 'failed' }] })
  })
})

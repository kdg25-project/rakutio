import { getTableName } from 'drizzle-orm'

import { ledgerTransaction, receipt, receiptPage } from '../../db/schema'
import type { ReceiptExtraction } from '../../ocr/receipt'
import type { ReceiptPageAnalysis } from './analysis'

const RECEIPT_TABLE = getTableName(receipt)
const PAGE_TABLE = getTableName(receiptPage)
const TRANSACTION_TABLE = getTableName(ledgerTransaction)

export type ReceiptAnalysisStatus = 'pending' | 'analyzed' | 'failed' | 'deleting'
export type ReceiptPageStatus = 'pending' | 'analyzed' | 'failed'
type ReceiptRow = { id: string; userId: string; objectKey: string; mimeType: string; byteSize: number; analysisStatus: ReceiptAnalysisStatus; analysisJson: string | null; createdAt: number; analyzedAt: number | null }
export type PersistedReceiptPage = { receiptId: string; pageIndex: number; objectKey: string; mimeType: string; byteSize: number; analysisStatus: ReceiptPageStatus; analysisJson: string | null; errorCode: string | null; errorMessage: string | null; analyzedAt: number | null }
type PageRow = PersistedReceiptPage
export type ReceiptPage = { pageIndex: number; mimeType: string; byteSize: number; analysisStatus: ReceiptPageStatus; analysis: ReceiptExtraction | null; errorCode: string | null; errorMessage: string | null; analyzedAt: number | null }
export type ReceiptDraft = { id: string; mimeType: string; byteSize: number; analysisStatus: ReceiptAnalysisStatus; analysis: ReceiptExtraction | null; createdAt: number; analyzedAt: number | null; pageCount: number; pages: ReceiptPage[] }
export type ReceiptObject = { body: ReadableStream; httpMetadata?: { contentType?: string }; size?: number }
export type ReceiptBucket = { put(key: string, value: ArrayBuffer, options: { httpMetadata: { contentType: string } }): Promise<unknown>; get(key: string): Promise<ReceiptObject | null>; delete(key: string): Promise<void> }
export class ReceiptStorageError extends Error { constructor(readonly code: 'RECEIPT_STORAGE_UNAVAILABLE' | 'RECEIPT_NOT_FOUND' | 'RECEIPT_ATTACHED' | 'RECEIPT_ANALYSIS_IN_PROGRESS' | 'RECEIPT_NOT_RETRYABLE', message: string, readonly receiptId?: string) { super(message) } }

function parseAnalysis(value: string | null): ReceiptExtraction | null { try { return value ? JSON.parse(value) as ReceiptExtraction : null } catch { return null } }
async function findOwnedReceipt(db: D1Database, userId: string, id: string, includeDeleting = false) { return db.prepare(`SELECT id, user_id AS userId, object_key AS objectKey, mime_type AS mimeType, byte_size AS byteSize, analysis_status AS analysisStatus, analysis_json AS analysisJson, created_at AS createdAt, analyzed_at AS analyzedAt FROM ${RECEIPT_TABLE} WHERE id = ? AND user_id = ?${includeDeleting ? '' : " AND analysis_status != 'deleting'"}`).bind(id, userId).first<ReceiptRow>() }
async function findPages(db: D1Database, receiptId: string): Promise<PageRow[]> { try { return (await db.prepare(`SELECT receipt_id AS receiptId, page_index AS pageIndex, object_key AS objectKey, mime_type AS mimeType, byte_size AS byteSize, analysis_status AS analysisStatus, analysis_json AS analysisJson, error_code AS errorCode, error_message AS errorMessage, analyzed_at AS analyzedAt FROM ${PAGE_TABLE} WHERE receipt_id = ? ORDER BY page_index`).bind(receiptId).all<PageRow>()).results } catch { return [] } }
function legacyPage(row: ReceiptRow): PageRow { return { receiptId: row.id, pageIndex: 0, objectKey: row.objectKey, mimeType: row.mimeType, byteSize: row.byteSize, analysisStatus: row.analysisStatus === 'analyzed' ? 'analyzed' : row.analysisStatus === 'failed' ? 'failed' : 'pending', analysisJson: row.analysisJson, errorCode: null, errorMessage: null, analyzedAt: row.analyzedAt } }
function pageView(page: PageRow): ReceiptPage { return { pageIndex: page.pageIndex, mimeType: page.mimeType, byteSize: page.byteSize, analysisStatus: page.analysisStatus, analysis: parseAnalysis(page.analysisJson), errorCode: page.errorCode, errorMessage: page.errorMessage, analyzedAt: page.analyzedAt } }
async function ownedPages(db: D1Database, row: ReceiptRow) { const pages = await findPages(db, row.id); return pages.length ? pages : [legacyPage(row)] }

/** Persist the receipt record and every page before writing private R2 objects. */
export async function createReceiptDraft(input: { db: D1Database; bucket: ReceiptBucket; id: string; userId: string; mimeType?: string; image?: File; images?: File[]; now?: number }) {
  const images = input.images ?? (input.image ? [input.image] : [])
  if (!images.length) throw new ReceiptStorageError('RECEIPT_STORAGE_UNAVAILABLE', '画像を保存できませんでした。')
  const createdAt = input.now ?? Date.now()
  const pages = images.map((image, pageIndex) => ({ image, pageIndex, objectKey: pageIndex === 0 ? `receipts/${input.userId}/${input.id}` : `receipts/${input.userId}/${input.id}/pages/${pageIndex}` }))
  try {
    await input.db.prepare(`INSERT INTO ${RECEIPT_TABLE} (id, user_id, object_key, mime_type, byte_size, analysis_status, analysis_json, created_at, analyzed_at) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`).bind(input.id, input.userId, pages[0]!.objectKey, images[0]!.type || input.mimeType || 'application/octet-stream', images[0]!.size, createdAt).run()
    for (const page of pages) await input.db.prepare(`INSERT INTO ${PAGE_TABLE} (receipt_id, page_index, object_key, mime_type, byte_size, analysis_status) VALUES (?, ?, ?, ?, ?, 'pending')`).bind(input.id, page.pageIndex, page.objectKey, page.image.type, page.image.size).run()
  } catch {
    try { await input.db.prepare(`DELETE FROM ${RECEIPT_TABLE} WHERE id = ? AND user_id = ?`).bind(input.id, input.userId).run() } catch { /* no untracked R2 write happened */ }
    throw new ReceiptStorageError('RECEIPT_STORAGE_UNAVAILABLE', '画像情報を保存できませんでした。時間をおいて再試行してください。')
  }
  const stored: string[] = []
  try { for (const page of pages) { await input.bucket.put(page.objectKey, await page.image.arrayBuffer(), { httpMetadata: { contentType: page.image.type } }); stored.push(page.objectKey) } } catch {
    await Promise.allSettled(stored.map((key) => input.bucket.delete(key)))
    try { await input.db.prepare(`DELETE FROM ${RECEIPT_TABLE} WHERE id = ? AND user_id = ?`).bind(input.id, input.userId).run() } catch { /* D1 cleanup is best-effort after R2 cleanup */ }
    throw new ReceiptStorageError('RECEIPT_STORAGE_UNAVAILABLE', '画像を保存できませんでした。時間をおいて再試行してください。', input.id)
  }
  return { id: input.id, objectKey: pages[0]!.objectKey, createdAt, pageCount: pages.length }
}

export async function markReceiptAnalysis(db: D1Database, userId: string, id: string, pages: ReceiptPageAnalysis[], analysis: ReceiptExtraction | null, now = Date.now()) {
  const row = await findOwnedReceipt(db, userId, id, true)
  if (!row || row.analysisStatus === 'deleting') throw new ReceiptStorageError('RECEIPT_NOT_FOUND', 'レシートが見つかりません。', id)
  if (await db.prepare(`SELECT id FROM ${TRANSACTION_TABLE} WHERE user_id = ? AND receipt_id = ?`).bind(userId, id).first()) throw new ReceiptStorageError('RECEIPT_ATTACHED', '取引に紐づいたレシートは再解析できません。', id)
  try {
    for (const page of pages) await db.prepare(`UPDATE ${PAGE_TABLE} SET analysis_status = ?, analysis_json = ?, error_code = ?, error_message = ?, analyzed_at = ? WHERE receipt_id = ? AND page_index = ?`).bind(page.status, page.receipt ? JSON.stringify(page.receipt) : null, page.errorCode, page.errorMessage, now, id, page.pageIndex).run()
    const status: ReceiptAnalysisStatus = analysis ? 'analyzed' : 'failed'
    const result = await db.prepare(`UPDATE ${RECEIPT_TABLE} SET analysis_status = '${status}', analysis_json = ?, analyzed_at = ? WHERE id = ? AND user_id = ? AND analysis_status = 'pending'`).bind(analysis ? JSON.stringify(analysis) : null, now, id, userId).run()
    if (result.meta.changes !== 1) throw new Error('receipt was not pending')
  } catch (error) { if (error instanceof ReceiptStorageError) throw error; throw new ReceiptStorageError('RECEIPT_STORAGE_UNAVAILABLE', 'OCR結果を保存できませんでした。', id) }
}
export async function markReceiptAnalyzed(db: D1Database, userId: string, id: string, analysis: ReceiptExtraction, now = Date.now()) { await markReceiptAnalysis(db, userId, id, [{ pageIndex: 0, status: 'analyzed', receipt: analysis, errorCode: null, errorMessage: null }], analysis, now) }
export async function markReceiptFailed(db: D1Database, userId: string, id: string, now = Date.now()) { try { await db.prepare(`UPDATE ${RECEIPT_TABLE} SET analysis_status = 'failed', analyzed_at = ? WHERE id = ? AND user_id = ? AND analysis_status = 'pending'`).bind(now, id, userId).run() } catch { /* the draft remains available for manual entry */ } }

/** Claim failed pages by default. `allPages` is reserved for an explicit full retry. */
export async function beginReceiptRetry(db: D1Database, userId: string, id: string, allPages = false) {
  const row = await findOwnedReceipt(db, userId, id, true)
  if (!row || row.analysisStatus === 'deleting') throw new ReceiptStorageError('RECEIPT_NOT_FOUND', 'レシートが見つかりません。')
  if (await db.prepare(`SELECT id FROM ${TRANSACTION_TABLE} WHERE user_id = ? AND receipt_id = ?`).bind(userId, id).first()) throw new ReceiptStorageError('RECEIPT_ATTACHED', '取引に紐づいたレシートは再解析できません。', id)
  const pages = await ownedPages(db, row); const retryPages = allPages ? pages : pages.filter((page) => page.analysisStatus === 'failed')
  if (!retryPages.length && row.analysisStatus === 'pending') throw new ReceiptStorageError('RECEIPT_ANALYSIS_IN_PROGRESS', 'このレシートは解析中です。しばらくしてから確認してください。', id)
  if (!retryPages.length && row.analysisStatus !== 'failed') throw new ReceiptStorageError('RECEIPT_NOT_RETRYABLE', '失敗したページがありません。', id)
  try {
    const claimed = await db.prepare(`UPDATE ${RECEIPT_TABLE} SET analysis_status = 'pending', analysis_json = NULL, analyzed_at = NULL WHERE id = ? AND user_id = ? AND analysis_status IN ('failed', 'analyzed')`).bind(id, userId).run()
    if (claimed.meta.changes !== 1) throw new ReceiptStorageError('RECEIPT_ANALYSIS_IN_PROGRESS', 'このレシートは解析中です。しばらくしてから確認してください。', id)
    for (const page of retryPages) await db.prepare(`UPDATE ${PAGE_TABLE} SET analysis_status = 'pending', analysis_json = NULL, error_code = NULL, error_message = NULL, analyzed_at = NULL WHERE receipt_id = ? AND page_index = ?`).bind(id, page.pageIndex).run()
    return { id, objectKey: retryPages[0]!.objectKey, mimeType: retryPages[0]!.mimeType, pages: retryPages.map((page) => ({ pageIndex: page.pageIndex, objectKey: page.objectKey, mimeType: page.mimeType })), existingPages: pages }
  } catch (error) { if (error instanceof ReceiptStorageError) throw error; throw new ReceiptStorageError('RECEIPT_STORAGE_UNAVAILABLE', '再解析の準備に失敗しました。時間をおいて再試行してください。', id) }
}
export async function loadReceiptRetryImages(db: D1Database, bucket: ReceiptBucket, userId: string, id: string, pageIndexes?: number[]) {
  const row = await findOwnedReceipt(db, userId, id); if (!row || row.analysisStatus !== 'pending') throw new ReceiptStorageError('RECEIPT_NOT_FOUND', 'レシートが見つかりません。')
  const selected = (await ownedPages(db, row)).filter((page) => !pageIndexes || pageIndexes.includes(page.pageIndex))
  try { return await Promise.all(selected.map(async (page) => { const object = await bucket.get(page.objectKey); if (!object) throw new ReceiptStorageError('RECEIPT_NOT_FOUND', 'レシート画像が見つかりません。', id); return { pageIndex: page.pageIndex, image: new File([await new Response(object.body).arrayBuffer()], `receipt-${id}-${page.pageIndex}`, { type: page.mimeType }) } })) } catch (error) { if (error instanceof ReceiptStorageError) throw error; throw new ReceiptStorageError('RECEIPT_STORAGE_UNAVAILABLE', 'レシート画像を取得できませんでした。', id) }
}
export async function loadReceiptRetryImage(db: D1Database, bucket: ReceiptBucket, userId: string, id: string) { return (await loadReceiptRetryImages(db, bucket, userId, id))[0]!.image }
export async function getReceiptDraft(db: D1Database, userId: string, id: string): Promise<ReceiptDraft> { const row = await findOwnedReceipt(db, userId, id); if (!row) throw new ReceiptStorageError('RECEIPT_NOT_FOUND', 'レシートが見つかりません。'); const pages = await ownedPages(db, row); return { id: row.id, mimeType: row.mimeType, byteSize: row.byteSize, analysisStatus: row.analysisStatus, analysis: parseAnalysis(row.analysisJson), createdAt: row.createdAt, analyzedAt: row.analyzedAt, pageCount: pages.length, pages: pages.map(pageView) } }
export async function getReceiptImage(db: D1Database, bucket: ReceiptBucket, userId: string, id: string, pageIndex = 0) { const row = await findOwnedReceipt(db, userId, id); if (!row) throw new ReceiptStorageError('RECEIPT_NOT_FOUND', 'レシートが見つかりません。'); const page = (await ownedPages(db, row)).find((candidate) => candidate.pageIndex === pageIndex); if (!page) throw new ReceiptStorageError('RECEIPT_NOT_FOUND', 'レシート画像が見つかりません。'); try { const object = await bucket.get(page.objectKey); if (!object) throw new ReceiptStorageError('RECEIPT_NOT_FOUND', 'レシート画像が見つかりません。'); return { object, mimeType: page.mimeType } } catch (error) { if (error instanceof ReceiptStorageError) throw error; throw new ReceiptStorageError('RECEIPT_STORAGE_UNAVAILABLE', 'レシート画像を取得できませんでした。') } }
export async function deleteReceiptDraft(db: D1Database, bucket: ReceiptBucket, userId: string, id: string) {
  const row = await findOwnedReceipt(db, userId, id, true); if (!row) throw new ReceiptStorageError('RECEIPT_NOT_FOUND', 'レシートが見つかりません。')
  if (await db.prepare(`SELECT id FROM ${TRANSACTION_TABLE} WHERE user_id = ? AND receipt_id = ?`).bind(userId, id).first()) throw new ReceiptStorageError('RECEIPT_ATTACHED', '取引に紐づいたレシートは削除できません。')
  if (row.analysisStatus !== 'deleting') { const result = await db.prepare(`UPDATE ${RECEIPT_TABLE} SET analysis_status = 'deleting' WHERE id = ? AND user_id = ? AND analysis_status != 'deleting'`).bind(id, userId).run(); if (result.meta.changes !== 1) throw new ReceiptStorageError('RECEIPT_ATTACHED', '取引に紐づいたレシートは削除できません。') }
  try { await Promise.all((await ownedPages(db, row)).map((page) => bucket.delete(page.objectKey))) } catch { throw new ReceiptStorageError('RECEIPT_STORAGE_UNAVAILABLE', '画像の削除を再試行してください。', id) }
  try { const result = await db.prepare(`DELETE FROM ${RECEIPT_TABLE} WHERE id = ? AND user_id = ? AND analysis_status = 'deleting'`).bind(id, userId).run(); if (result.meta.changes !== 1) throw new Error('receipt no longer exists') } catch { throw new ReceiptStorageError('RECEIPT_STORAGE_UNAVAILABLE', 'レシートの削除を再試行してください。', id) }
}

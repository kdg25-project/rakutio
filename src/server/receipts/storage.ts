import { getTableName } from 'drizzle-orm'

import { ledgerTransaction, receipt } from '../../db/schema'
import type { ReceiptExtraction } from '../../ocr/receipt'

const RECEIPT_TABLE = getTableName(receipt)
const TRANSACTION_TABLE = getTableName(ledgerTransaction)

export type ReceiptAnalysisStatus = 'pending' | 'analyzed' | 'failed' | 'deleting'

type ReceiptRow = {
  id: string
  userId: string
  objectKey: string
  mimeType: string
  byteSize: number
  analysisStatus: ReceiptAnalysisStatus
  analysisJson: string | null
  createdAt: number
  analyzedAt: number | null
}

export type ReceiptDraft = {
  id: string
  mimeType: string
  byteSize: number
  analysisStatus: ReceiptAnalysisStatus
  analysis: ReceiptExtraction | null
  createdAt: number
  analyzedAt: number | null
}

export type ReceiptObject = {
  body: ReadableStream
  httpMetadata?: { contentType?: string }
  size?: number
}

export type ReceiptBucket = {
  put(key: string, value: ArrayBuffer, options: { httpMetadata: { contentType: string } }): Promise<unknown>
  get(key: string): Promise<ReceiptObject | null>
  delete(key: string): Promise<void>
}

export class ReceiptStorageError extends Error {
  constructor(
    readonly code: 'RECEIPT_STORAGE_UNAVAILABLE' | 'RECEIPT_NOT_FOUND' | 'RECEIPT_ATTACHED',
    message: string,
    readonly receiptId?: string,
  ) {
    super(message)
  }
}

function parseAnalysis(value: string | null): ReceiptExtraction | null {
  if (!value) return null
  try {
    return JSON.parse(value) as ReceiptExtraction
  } catch {
    return null
  }
}

function normalizeReceipt(row: ReceiptRow): ReceiptDraft {
  return {
    id: row.id,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    analysisStatus: row.analysisStatus,
    analysis: parseAnalysis(row.analysisJson),
    createdAt: row.createdAt,
    analyzedAt: row.analyzedAt,
  }
}

async function findOwnedReceipt(db: D1Database, userId: string, id: string, includeDeleting = false) {
  return await db.prepare(
    `SELECT id, user_id AS userId, object_key AS objectKey, mime_type AS mimeType, byte_size AS byteSize, analysis_status AS analysisStatus, analysis_json AS analysisJson, created_at AS createdAt, analyzed_at AS analyzedAt FROM ${RECEIPT_TABLE} WHERE id = ? AND user_id = ?${includeDeleting ? '' : " AND analysis_status != 'deleting'"}`,
  ).bind(id, userId).first<ReceiptRow>()
}

/**
 * Reserve a durable, private record before placing the image in R2. A failed
 * D1 insert therefore never writes an untracked object. If R2 is unavailable,
 * its tracked draft stays available for a later delete/retry.
 */
export async function createReceiptDraft(input: {
  db: D1Database
  bucket: ReceiptBucket
  id: string
  userId: string
  mimeType: string
  image: File
  now?: number
}) {
  const createdAt = input.now ?? Date.now()
  const objectKey = `receipts/${input.userId}/${input.id}`
  try {
    await input.db.prepare(
      `INSERT INTO ${RECEIPT_TABLE} (id, user_id, object_key, mime_type, byte_size, analysis_status, analysis_json, created_at, analyzed_at) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
    ).bind(input.id, input.userId, objectKey, input.mimeType, input.image.size, createdAt).run()
  } catch {
    throw new ReceiptStorageError('RECEIPT_STORAGE_UNAVAILABLE', '画像情報を保存できませんでした。時間をおいて再試行してください。')
  }

  try {
    await input.bucket.put(objectKey, await input.image.arrayBuffer(), { httpMetadata: { contentType: input.mimeType } })
  } catch {
    try {
      await input.db.prepare(
        `UPDATE ${RECEIPT_TABLE} SET analysis_status = 'failed', analyzed_at = ? WHERE id = ? AND user_id = ? AND analysis_status = 'pending'`,
      ).bind(Date.now(), input.id, input.userId).run()
    } catch {
      // The durable pending row remains and can still be removed by DELETE.
    }
    throw new ReceiptStorageError('RECEIPT_STORAGE_UNAVAILABLE', '画像を保存できませんでした。時間をおいて再試行してください。', input.id)
  }

  return { id: input.id, objectKey, createdAt }
}

export async function markReceiptAnalyzed(db: D1Database, userId: string, id: string, analysis: ReceiptExtraction, now = Date.now()) {
  try {
    const result = await db.prepare(
      `UPDATE ${RECEIPT_TABLE} SET analysis_status = 'analyzed', analysis_json = ?, analyzed_at = ? WHERE id = ? AND user_id = ? AND analysis_status != 'deleting'`,
    ).bind(JSON.stringify(analysis), now, id, userId).run()
    if (result.meta.changes !== 1) throw new Error('receipt not found')
  } catch {
    throw new ReceiptStorageError('RECEIPT_STORAGE_UNAVAILABLE', 'OCR結果を保存できませんでした。')
  }
}

export async function markReceiptFailed(db: D1Database, userId: string, id: string, now = Date.now()) {
  try {
    await db.prepare(
      `UPDATE ${RECEIPT_TABLE} SET analysis_status = 'failed', analyzed_at = ? WHERE id = ? AND user_id = ? AND analysis_status != 'deleting'`,
    ).bind(now, id, userId).run()
  } catch {
    // The original draft remains available for manual entry even if its status
    // cannot be updated due to a transient D1 failure.
  }
}

export async function getReceiptDraft(db: D1Database, userId: string, id: string) {
  const row = await findOwnedReceipt(db, userId, id)
  if (!row) throw new ReceiptStorageError('RECEIPT_NOT_FOUND', 'レシートが見つかりません。')
  return normalizeReceipt(row)
}

export async function getReceiptImage(db: D1Database, bucket: ReceiptBucket, userId: string, id: string) {
  const row = await findOwnedReceipt(db, userId, id)
  if (!row) throw new ReceiptStorageError('RECEIPT_NOT_FOUND', 'レシートが見つかりません。')
  try {
    const object = await bucket.get(row.objectKey)
    if (!object) throw new ReceiptStorageError('RECEIPT_NOT_FOUND', 'レシート画像が見つかりません。')
    return { object, mimeType: row.mimeType }
  } catch (error) {
    if (error instanceof ReceiptStorageError) throw error
    throw new ReceiptStorageError('RECEIPT_STORAGE_UNAVAILABLE', 'レシート画像を取得できませんでした。')
  }
}

export async function deleteReceiptDraft(db: D1Database, bucket: ReceiptBucket, userId: string, id: string) {
  const row = await findOwnedReceipt(db, userId, id, true)
  if (!row) throw new ReceiptStorageError('RECEIPT_NOT_FOUND', 'レシートが見つかりません。')

  if (row.analysisStatus !== 'deleting') {
    const result = await db.prepare(
      `UPDATE ${RECEIPT_TABLE} SET analysis_status = 'deleting' WHERE id = ? AND user_id = ? AND analysis_status != 'deleting' AND NOT EXISTS (SELECT 1 FROM ${TRANSACTION_TABLE} WHERE user_id = ? AND receipt_id = ?)`,
    ).bind(id, userId, userId, id).run()
    if (result.meta.changes !== 1) {
      const latest = await findOwnedReceipt(db, userId, id, true)
      if (!latest) throw new ReceiptStorageError('RECEIPT_NOT_FOUND', 'レシートが見つかりません。')
      if (latest.analysisStatus !== 'deleting') throw new ReceiptStorageError('RECEIPT_ATTACHED', '取引に紐づいたレシートは削除できません。')
    }
  }

  try {
    await bucket.delete(row.objectKey)
  } catch {
    throw new ReceiptStorageError('RECEIPT_STORAGE_UNAVAILABLE', '画像の削除を再試行してください。', id)
  }

  try {
    const result = await db.prepare(`DELETE FROM ${RECEIPT_TABLE} WHERE id = ? AND user_id = ? AND analysis_status = 'deleting'`).bind(id, userId).run()
    if (result.meta.changes !== 1) throw new Error('receipt no longer exists')
  } catch {
    throw new ReceiptStorageError('RECEIPT_STORAGE_UNAVAILABLE', 'レシートの削除を再試行してください。', id)
  }
}

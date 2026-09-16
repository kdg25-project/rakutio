import { calculateTransaction, MoneyCalculationError } from '../../domain/money'
import type {
  DuplicateReceiptMatch,
  LedgerCategory,
  LedgerCategorySummary,
  LedgerSummary,
  LedgerTransaction,
  LedgerTransactionFilter,
  LedgerTransactionInput,
  LedgerTransactionItem,
  LedgerTransactionType,
  UtilityKind,
} from './types'

type SqlValue = string | number | null
type Row = Record<string, unknown>

export class LedgerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'LedgerError'
  }
}

const DEFAULT_CATEGORIES = [
  ['食費', '#C98278', 'utensils'], ['日用品', '#8FA8A3', 'shopping-bag'], ['交通費', '#8DA5B8', 'train'],
  ['住居費', '#A89AC5', 'home'], ['光熱費', '#D2A65C', 'zap'], ['通信費', '#8E9BA7', 'smartphone'],
  ['医療費', '#C98A91', 'heart-pulse'], ['教育', '#9DA9C6', 'graduation-cap'], ['娯楽', '#B999B3', 'party-popper'],
  ['衣服', '#C99882', 'shirt'], ['サブスク', '#9AA4AE', 'repeat-2'], ['その他', '#AAB0B7', 'more-horizontal'],
  ['給与', '#91AD98', 'banknote'], ['副収入', '#A9B881', 'circle-plus'],
] as const

const MAX_TEXT = 1_000
const DAY = /^\d{4}-\d{2}-\d{2}$/
const MONTH = /^\d{4}-\d{2}$/

function id() { return crypto.randomUUID() }
function now() { return Date.now() }
function text(value: unknown, field: string, max = MAX_TEXT) {
  if (typeof value !== 'string') throw new LedgerError('INVALID_INPUT', `${field} を文字列で指定してください。`)
  const normalized = value.trim()
  if (normalized.length > max) throw new LedgerError('INVALID_INPUT', `${field} は ${max} 文字以下にしてください。`)
  return normalized
}
function date(value: unknown, field = '日付') {
  const result = text(value, field, 10)
  if (!DAY.test(result)) throw new LedgerError('INVALID_INPUT', `${field} は YYYY-MM-DD 形式で指定してください。`)
  const [year, mon, day] = result.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, mon - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== mon - 1 || parsed.getUTCDate() !== day) throw new LedgerError('INVALID_INPUT', `${field} は実在する日付で指定してください。`)
  return result
}
function month(value: unknown) {
  const result = text(value, '月', 7)
  if (!MONTH.test(result) || Number(result.slice(5)) < 1 || Number(result.slice(5)) > 12) throw new LedgerError('INVALID_INPUT', '月は YYYY-MM 形式で指定してください。')
  if (result === '9999-12') throw new LedgerError('INVALID_INPUT', '指定できる最終月は 9999-11 です。')
  return result
}
function normalizeMerchant(value: string) { return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase() }
function cursorEncode(value: string) { return btoa(value) }
function cursorDecode(value: string) {
  try { return atob(value) } catch { throw new LedgerError('INVALID_INPUT', 'ページカーソルが不正です。') }
}
function previousMonth(value: string) {
  const [year, mon] = value.split('-').map(Number)
  const result = new Date(Date.UTC(year, mon - 2, 1))
  return `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, '0')}`
}
function monthBounds(value: string) { return { from: `${value}-01`, to: `${value === '9999-12' ? '9999-12' : nextMonth(value)}-01` } }
function nextMonth(value: string) {
  const [year, mon] = value.split('-').map(Number)
  const result = new Date(Date.UTC(year, mon, 1))
  return `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, '0')}`
}
function recentMonths(lastMonth: string, count = 6) {
  const values: string[] = []; let current = lastMonth
  for (let index = 0; index < count; index += 1) { values.unshift(current); current = previousMonth(current) }
  return values
}
function statement(db: D1Database, query: string, values: SqlValue[] = []) { return db.prepare(query).bind(...values) }
function rowNumber(row: Row, key: string) { return Number(row[key]) }
function rowString(row: Row, key: string) { const value = row[key]; return value == null ? '' : String(value) }
function aggregateInteger(value: unknown, field: string) {
  let parsed: bigint
  if (typeof value === 'bigint') parsed = value
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value)
  else if (typeof value === 'string' && /^-?\d+$/.test(value)) parsed = BigInt(value)
  else throw new LedgerError('UNSAFE_AGGREGATE', `${field} を安全な整数として集計できません。`)
  if (parsed < BigInt(Number.MIN_SAFE_INTEGER) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new LedgerError('UNSAFE_AGGREGATE', `${field} が集計可能な範囲を超えています。`)
  return Number(parsed)
}
function addAggregate(total: number, value: number, field: string) {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(value) || total + value < Number.MIN_SAFE_INTEGER || total + value > Number.MAX_SAFE_INTEGER) throw new LedgerError('UNSAFE_AGGREGATE', `${field} が集計可能な範囲を超えています。`)
  return total + value
}
function mappedAssetBalanceError(error: unknown) {
  const message = String(error)
  if (message.includes('asset balance out of range') || message.includes('asset aggregate out of range') || message.includes('asset entry amount out of range')) return new LedgerError('ASSET_BALANCE_LIMIT_EXCEEDED', '口座残高または資産合計が管理可能な範囲を超えます。', 422)
  return null
}

function categoryFromRow(row: Row): LedgerCategory {
  return { id: rowString(row, 'id'), name: rowString(row, 'name'), color: rowString(row, 'color'), icon: rowString(row, 'icon'), isDefault: Boolean(rowNumber(row, 'is_default')), createdAt: rowNumber(row, 'created_at'), updatedAt: rowNumber(row, 'updated_at') }
}
function itemFromRow(row: Row): LedgerTransactionItem {
  return {
    id: rowString(row, 'id'), categoryId: rowString(row, 'category_id'), name: rowString(row, 'name'),
    originalAmount: rowNumber(row, 'original_amount'), itemDiscountAmount: rowNumber(row, 'item_discount_amount'),
    allocatedReceiptDiscountAmount: rowNumber(row, 'allocated_receipt_discount_amount'), finalAmount: rowNumber(row, 'final_amount'),
    allocatedPointAmount: rowNumber(row, 'allocated_point_amount'), allocatedGiftCertificateAmount: rowNumber(row, 'allocated_gift_certificate_amount'),
    paidAmount: rowNumber(row, 'paid_amount'), utilityKind: row.utility_kind == null ? null : rowString(row, 'utility_kind') as UtilityKind, sortOrder: rowNumber(row, 'sort_order'),
  }
}
function transactionFromRow(row: Row, items: LedgerTransactionItem[]): LedgerTransaction {
  return {
    id: rowString(row, 'id'), receiptId: row.receipt_id == null ? null : String(row.receipt_id), accountId: row.account_id == null ? null : String(row.account_id), giftAccountId: row.gift_account_id == null ? null : String(row.gift_account_id), type: rowString(row, 'type') as LedgerTransactionType,
    occurredAt: rowString(row, 'occurred_at'), title: rowString(row, 'title'), merchant: rowString(row, 'merchant'), memo: rowString(row, 'memo'), paymentMethod: rowString(row, 'payment_method'),
    grossAmount: rowNumber(row, 'gross_amount'), itemDiscountAmount: rowNumber(row, 'item_discount_amount'), receiptDiscountAmount: rowNumber(row, 'receipt_discount_amount'),
    discountAmount: rowNumber(row, 'discount_amount'), netAmount: rowNumber(row, 'net_amount'), pointUsedAmount: rowNumber(row, 'point_used_amount'),
    giftCertificateUsedAmount: rowNumber(row, 'gift_certificate_used_amount'), nonCashAmount: rowNumber(row, 'non_cash_amount'), cashPaidAmount: rowNumber(row, 'cash_paid_amount'),
    revision: rowNumber(row, 'revision'), createdAt: rowNumber(row, 'created_at'), updatedAt: rowNumber(row, 'updated_at'), items,
  }
}

async function rows(db: D1Database, query: string, values: SqlValue[] = []) { return (await statement(db, query, values).all<Row>()).results }
async function one(db: D1Database, query: string, values: SqlValue[] = []) { return statement(db, query, values).first<Row>() }

export class LedgerService {
  constructor(private readonly db: D1Database, private readonly userId: string) {}

  async ensureDefaultCategories() {
    const existing = await one(this.db, 'SELECT id FROM ledger_category WHERE user_id = ? LIMIT 1', [this.userId])
    if (existing) return
    const createdAt = now()
    const statements = DEFAULT_CATEGORIES.map(([name, color, icon]) => statement(this.db,
      'INSERT OR IGNORE INTO ledger_category (id, user_id, name, color, icon, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      [id(), this.userId, name, color, icon, createdAt, createdAt]))
    await this.db.batch(statements)
  }

  async listCategories() {
    await this.ensureDefaultCategories()
    return (await rows(this.db, 'SELECT id, name, color, icon, is_default, created_at, updated_at FROM ledger_category WHERE user_id = ? ORDER BY created_at, name', [this.userId])).map(categoryFromRow)
  }

  async createCategory(input: { name: unknown; color?: unknown; icon?: unknown }) {
    await this.ensureDefaultCategories()
    const name = text(input.name, 'カテゴリ名', 40)
    if (!name) throw new LedgerError('INVALID_INPUT', 'カテゴリ名を入力してください。')
    const color = input.color == null ? '#64748B' : text(input.color, '色', 20)
    const icon = input.icon == null ? 'tag' : text(input.icon, 'アイコン', 40)
    const createdAt = now(); const categoryId = id()
    try {
      await statement(this.db, 'INSERT INTO ledger_category (id, user_id, name, color, icon, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)', [categoryId, this.userId, name, color, icon, createdAt, createdAt]).run()
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new LedgerError('CATEGORY_EXISTS', '同じ名前のカテゴリがすでにあります。', 409)
      throw error
    }
    return (await this.getCategory(categoryId))!
  }

  async updateCategory(categoryId: string, input: { name?: unknown; color?: unknown; icon?: unknown }) {
    const current = await this.getCategory(categoryId)
    if (!current) throw new LedgerError('NOT_FOUND', 'カテゴリが見つかりません。', 404)
    const name = input.name === undefined ? current.name : text(input.name, 'カテゴリ名', 40)
    if (current.name === 'その他' && name !== 'その他') throw new LedgerError('DEFAULT_CATEGORY_REQUIRED', '「その他」カテゴリの名前は変更できません。', 409)
    const color = input.color === undefined ? current.color : text(input.color, '色', 20)
    const icon = input.icon === undefined ? current.icon : text(input.icon, 'アイコン', 40)
    try { await statement(this.db, 'UPDATE ledger_category SET name = ?, color = ?, icon = ?, updated_at = ? WHERE id = ? AND user_id = ?', [name, color, icon, now(), categoryId, this.userId]).run() }
    catch (error) {
      if (String(error).includes('UNIQUE')) throw new LedgerError('CATEGORY_EXISTS', '同じ名前のカテゴリがすでにあります。', 409)
      throw error
    }
    return (await this.getCategory(categoryId))!
  }

  async deleteCategory(categoryId: string) {
    await this.ensureDefaultCategories()
    const current = await this.getCategory(categoryId)
    if (!current) throw new LedgerError('NOT_FOUND', 'カテゴリが見つかりません。', 404)
    if (current.name === 'その他') throw new LedgerError('DEFAULT_CATEGORY_REQUIRED', '「その他」カテゴリは削除できません。', 409)
    const other = await one(this.db, 'SELECT id FROM ledger_category WHERE user_id = ? AND name = ? LIMIT 1', [this.userId, 'その他'])
    if (!other) throw new LedgerError('CATEGORY_MAPPING_UNAVAILABLE', '「その他」カテゴリを準備できませんでした。', 500)
    const otherId = rowString(other, 'id')
    await this.db.batch([
      statement(this.db, 'UPDATE ledger_transaction_item SET category_id = ? WHERE category_id = ? AND EXISTS (SELECT 1 FROM ledger_transaction AS t WHERE t.id = ledger_transaction_item.transaction_id AND t.user_id = ?)', [otherId, categoryId, this.userId]),
      statement(this.db, 'UPDATE planning_recurring_rule SET category_id = ?, updated_at = ? WHERE category_id = ? AND user_id = ?', [otherId, now(), categoryId, this.userId]),
      statement(this.db, 'DELETE FROM ledger_category WHERE id = ? AND user_id = ?', [categoryId, this.userId]),
    ])
    return { mappedToCategoryId: otherId }
  }

  async getTransaction(transactionId: string) {
    const row = await one(this.db, 'SELECT * FROM ledger_transaction WHERE id = ? AND user_id = ?', [transactionId, this.userId])
    if (!row) return null
    const itemRows = await rows(this.db, 'SELECT * FROM ledger_transaction_item WHERE transaction_id = ? ORDER BY sort_order', [transactionId])
    return transactionFromRow(row, itemRows.map(itemFromRow))
  }

  async listTransactions(filter: LedgerTransactionFilter) {
    await this.ensureDefaultCategories()
    const where = ['t.user_id = ?']; const values: SqlValue[] = [this.userId]
    if (filter.month) { const value = month(filter.month); const bounds = monthBounds(value); where.push('t.occurred_at >= ? AND t.occurred_at < ?'); values.push(bounds.from, bounds.to) }
    if (filter.from) { where.push('t.occurred_at >= ?'); values.push(date(filter.from, '開始日')) }
    if (filter.to) { where.push('t.occurred_at <= ?'); values.push(date(filter.to, '終了日')) }
    if (filter.type) { if (filter.type !== 'expense' && filter.type !== 'income') throw new LedgerError('INVALID_INPUT', '種別が不正です。'); where.push('t.type = ?'); values.push(filter.type) }
    if (filter.categoryId) { where.push('EXISTS (SELECT 1 FROM ledger_transaction_item AS fi WHERE fi.transaction_id = t.id AND fi.category_id = ?)'); values.push(filter.categoryId) }
    if (filter.merchant) { const value = text(filter.merchant, '店舗名', 200); where.push('t.merchant_normalized LIKE ?'); values.push(`%${normalizeMerchant(value)}%`) }
    if (filter.minAmount != null) { if (!Number.isSafeInteger(filter.minAmount) || filter.minAmount < 0) throw new LedgerError('INVALID_INPUT', '最小金額が不正です。'); where.push('t.cash_paid_amount >= ?'); values.push(filter.minAmount) }
    if (filter.maxAmount != null) { if (!Number.isSafeInteger(filter.maxAmount) || filter.maxAmount < 0) throw new LedgerError('INVALID_INPUT', '最大金額が不正です。'); where.push('t.cash_paid_amount <= ?'); values.push(filter.maxAmount) }
    if (filter.cursor) { const [occurredAt, transactionId] = cursorDecode(filter.cursor).split('|'); if (!occurredAt || !transactionId) throw new LedgerError('INVALID_INPUT', 'ページカーソルが不正です。'); where.push('(t.occurred_at < ? OR (t.occurred_at = ? AND t.id < ?))'); values.push(occurredAt, occurredAt, transactionId) }
    const limit = filter.limit == null ? 50 : filter.limit
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new LedgerError('INVALID_INPUT', '表示件数は 1 から 100 の範囲で指定してください。')
    const transactionRows = await rows(this.db, `SELECT t.* FROM ledger_transaction AS t WHERE ${where.join(' AND ')} ORDER BY t.occurred_at DESC, t.id DESC LIMIT ?`, [...values, limit + 1])
    const page = transactionRows.slice(0, limit)
    const transactions = await Promise.all(page.map(async (transaction) => {
      const itemRows = await rows(this.db, 'SELECT * FROM ledger_transaction_item WHERE transaction_id = ? ORDER BY sort_order', [rowString(transaction, 'id')])
      return transactionFromRow(transaction, itemRows.map(itemFromRow))
    }))
    const last = page.at(-1)
    return { transactions, nextCursor: transactionRows.length > limit && last ? cursorEncode(`${rowString(last, 'occurred_at')}|${rowString(last, 'id')}`) : null }
  }

  async findDuplicates(input: LedgerTransactionInput) {
    const normalized = this.validateInput(input)
    if (!normalized.merchant) return []
    const candidates = await rows(this.db, 'SELECT t.* FROM ledger_transaction AS t WHERE t.user_id = ? AND t.occurred_at = ? AND t.merchant_normalized = ? AND t.net_amount = ? ORDER BY t.created_at DESC LIMIT 10', [this.userId, normalized.occurredAt, normalizeMerchant(normalized.merchant), normalized.calculation.totals.netAmount])
    const wanted = normalized.items.map((item) => item.name.normalize('NFKC').trim().toLowerCase()).sort()
    const matches: DuplicateReceiptMatch[] = []
    for (const candidate of candidates) {
      const itemRows = await rows(this.db, 'SELECT * FROM ledger_transaction_item WHERE transaction_id = ? ORDER BY sort_order', [rowString(candidate, 'id')])
      const items = itemRows.map(itemFromRow)
      const existing = items.map((item) => item.name.normalize('NFKC').trim().toLowerCase()).sort()
      const matchingItemCount = wanted.filter((name, index) => name === existing[index]).length
      matches.push({ transaction: transactionFromRow(candidate, items), matchingItemCount, sameItems: wanted.length === existing.length && matchingItemCount === wanted.length })
    }
    return matches
  }

  async createTransaction(input: LedgerTransactionInput, idempotencyKey: unknown, overrideDuplicate = false) {
    const key = text(idempotencyKey, 'リクエストキー', 200)
    if (!key) throw new LedgerError('INVALID_INPUT', 'リクエストキーを指定してください。')
    const previous = await one(this.db, 'SELECT transaction_id FROM ledger_idempotency WHERE user_id = ? AND key = ?', [this.userId, key])
    if (previous) return { transaction: (await this.getTransaction(rowString(previous, 'transaction_id')))! , idempotent: true }
    const normalized = this.validateInput(input)
    await this.ensureReferences(normalized)
    if (!overrideDuplicate) {
      const duplicates = await this.findDuplicates(input)
      if (duplicates.length) throw new LedgerError('DUPLICATE_RECEIPT', '同じ日付・店舗・金額の明細がすでにあります。', 409, { duplicates })
    }
    const transactionId = id(); const createdAt = now()
    const statements = [...this.insertStatements(transactionId, normalized, createdAt), ...this.assetEntryStatements(transactionId, normalized, createdAt)]
    statements.push(statement(this.db, 'INSERT INTO ledger_idempotency (user_id, key, transaction_id, created_at) VALUES (?, ?, ?, ?)', [this.userId, key, transactionId, createdAt]))
    try { await this.db.batch(statements) }
    catch (error) {
      const raced = await one(this.db, 'SELECT transaction_id FROM ledger_idempotency WHERE user_id = ? AND key = ?', [this.userId, key])
      if (raced) return { transaction: (await this.getTransaction(rowString(raced, 'transaction_id')))! , idempotent: true }
      if (String(error).includes('ledger_transaction.receipt_id') || String(error).includes('ledger_transaction_receipt_unique')) throw new LedgerError('RECEIPT_ALREADY_ATTACHED', 'このレシートはすでに別の明細に添付されています。', 409)
      const assetError = mappedAssetBalanceError(error); if (assetError) throw assetError
      throw error
    }
    return { transaction: (await this.getTransaction(transactionId))!, idempotent: false }
  }

  async updateTransaction(transactionId: string, revision: unknown, input: LedgerTransactionInput) {
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new LedgerError('INVALID_INPUT', '更新番号が不正です。')
    const normalized = this.validateInput(input)
    await this.ensureReferences(normalized, transactionId)
    const current = await this.getTransaction(transactionId)
    if (!current) throw new LedgerError('NOT_FOUND', '明細が見つかりません。', 404)
    if (current.revision !== revision) throw new LedgerError('REVISION_CONFLICT', 'この明細は別の更新で変更されています。再読み込みしてください。', 409, { transaction: current })
    const updatedAt = now(); const nextRevision = (revision as number) + 1
    const statements = [statement(this.db, `UPDATE ledger_transaction SET receipt_id = ?, account_id = ?, gift_account_id = ?, type = ?, occurred_at = ?, title = ?, merchant = ?, merchant_normalized = ?, memo = ?, payment_method = ?, gross_amount = ?, item_discount_amount = ?, receipt_discount_amount = ?, discount_amount = ?, net_amount = ?, point_used_amount = ?, gift_certificate_used_amount = ?, non_cash_amount = ?, cash_paid_amount = ?, revision = ?, updated_at = ? WHERE id = ? AND user_id = ? AND revision = ?`, this.transactionValues(normalized, nextRevision, updatedAt).concat([transactionId, this.userId, revision as number])),
      statement(this.db, 'DELETE FROM asset_entry WHERE transaction_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM ledger_transaction AS t WHERE t.id = ? AND t.user_id = ? AND t.revision = ?)', [transactionId, this.userId, transactionId, this.userId, nextRevision]),
      statement(this.db, 'DELETE FROM ledger_transaction_item WHERE transaction_id = ? AND EXISTS (SELECT 1 FROM ledger_transaction AS t WHERE t.id = ? AND t.user_id = ? AND t.revision = ?)', [transactionId, transactionId, this.userId, nextRevision]),
      ...this.itemInsertStatements(transactionId, normalized, `INSERT INTO ledger_transaction_item (id, transaction_id, category_id, name, original_amount, item_discount_amount, allocated_receipt_discount_amount, final_amount, allocated_point_amount, allocated_gift_certificate_amount, paid_amount, utility_kind, sort_order) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ledger_transaction AS t WHERE t.id = ? AND t.user_id = ? AND t.revision = ?)`, [transactionId, this.userId, nextRevision]),
      ...this.assetEntryStatements(transactionId, normalized, updatedAt, `INSERT INTO asset_entry (id, user_id, account_id, operation_id, transaction_id, kind, amount, occurred_at, memo, created_at) SELECT ?, ?, ?, NULL, ?, 'transaction', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ledger_transaction AS t WHERE t.id = ? AND t.user_id = ? AND t.revision = ?)`, [transactionId, this.userId, nextRevision]),
    ]
    let results
    try { results = await this.db.batch(statements) }
    catch (error) {
      if (String(error).includes('ledger_transaction.receipt_id') || String(error).includes('ledger_transaction_receipt_unique')) throw new LedgerError('RECEIPT_ALREADY_ATTACHED', 'このレシートはすでに別の明細に添付されています。', 409)
      const assetError = mappedAssetBalanceError(error); if (assetError) throw assetError
      throw error
    }
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      const latest = await this.getTransaction(transactionId)
      throw new LedgerError('REVISION_CONFLICT', 'この明細は別の更新で変更されています。再読み込みしてください。', 409, { transaction: latest })
    }
    return (await this.getTransaction(transactionId))!
  }

  async deleteTransaction(transactionId: string, revision: unknown) {
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new LedgerError('INVALID_INPUT', '更新番号が不正です。')
    let result
    try { result = await statement(this.db, 'DELETE FROM ledger_transaction WHERE id = ? AND user_id = ? AND revision = ?', [transactionId, this.userId, revision as number]).run() }
    catch (error) { const assetError = mappedAssetBalanceError(error); if (assetError) throw assetError; throw error }
    if (result.meta.changes === 1) return
    const latest = await this.getTransaction(transactionId)
    if (!latest) throw new LedgerError('NOT_FOUND', '明細が見つかりません。', 404)
    throw new LedgerError('REVISION_CONFLICT', 'この明細は別の更新で変更されています。再読み込みしてください。', 409, { transaction: latest })
  }

  async summary(inputMonth: unknown): Promise<LedgerSummary> {
    const value = month(inputMonth); const bounds = monthBounds(value); const previous = monthBounds(previousMonth(value))
    const trendMonths = recentMonths(value); const trendStart = `${trendMonths[0]}-01`
    const [transactionRows, categoryRows, itemRows, accountRows] = await Promise.all([
      rows(this.db, 'SELECT id, type, occurred_at, cash_paid_amount FROM ledger_transaction WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at, id', [this.userId, trendStart, bounds.to]),
      rows(this.db, 'SELECT id, name, color, icon, is_default, created_at, updated_at FROM ledger_category WHERE user_id = ?', [this.userId]),
      rows(this.db, `SELECT t.id AS transaction_id, t.occurred_at, i.category_id, i.paid_amount, c.name AS category_name FROM ledger_transaction AS t INNER JOIN ledger_transaction_item AS i ON i.transaction_id = t.id INNER JOIN ledger_category AS c ON c.id = i.category_id WHERE t.user_id = ? AND t.type = 'expense' AND t.occurred_at >= ? AND t.occurred_at < ? ORDER BY t.occurred_at, t.id, i.sort_order`, [this.userId, trendStart, bounds.to]),
      rows(this.db, 'SELECT balance_amount, is_archived FROM asset_account WHERE user_id = ?', [this.userId]),
    ])
    type MonthlyTotal = { incomeCashPaidAmount: number; expenseCashPaidAmount: number; fixedExpenseCashPaidAmount: number; utilityCashPaidAmount: number }
    const monthly = new Map<string, MonthlyTotal>(trendMonths.map((trendMonth) => [trendMonth, { incomeCashPaidAmount: 0, expenseCashPaidAmount: 0, fixedExpenseCashPaidAmount: 0, utilityCashPaidAmount: 0 }]))
    const daily = new Map<string, number>(); let expenseCashPaidAmount = 0; let incomeCashPaidAmount = 0; let previousExpenseCashPaidAmount = 0
    for (const transaction of transactionRows) {
      const occurredAt = rowString(transaction, 'occurred_at'); const amount = aggregateInteger(transaction.cash_paid_amount, '明細集計額'); const type = rowString(transaction, 'type'); const monthlyTotal = monthly.get(occurredAt.slice(0, 7))
      if (monthlyTotal) {
        if (type === 'expense') monthlyTotal.expenseCashPaidAmount = addAggregate(monthlyTotal.expenseCashPaidAmount, amount, '月別支出')
        else monthlyTotal.incomeCashPaidAmount = addAggregate(monthlyTotal.incomeCashPaidAmount, amount, '月別収入')
      }
      if (occurredAt >= bounds.from && occurredAt < bounds.to) {
        if (type === 'expense') { expenseCashPaidAmount = addAggregate(expenseCashPaidAmount, amount, '支出合計'); daily.set(occurredAt, addAggregate(daily.get(occurredAt) ?? 0, amount, '日別支出')) }
        else incomeCashPaidAmount = addAggregate(incomeCashPaidAmount, amount, '収入合計')
      }
      if (type === 'expense' && occurredAt >= previous.from && occurredAt < previous.to) previousExpenseCashPaidAmount = addAggregate(previousExpenseCashPaidAmount, amount, '前月支出')
    }
    const categories = new Map(categoryRows.map((row) => [rowString(row, 'id'), { category: categoryFromRow(row), cashPaidAmount: 0, transactionIds: new Set<string>() }]))
    for (const item of itemRows) {
      const occurredAt = rowString(item, 'occurred_at'); const itemAmount = aggregateInteger(item.paid_amount, 'カテゴリ集計額'); const monthlyTotal = monthly.get(occurredAt.slice(0, 7))
      if (monthlyTotal) {
        const name = rowString(item, 'category_name')
        if (['住居費', '通信費', 'サブスク', '保険'].includes(name)) monthlyTotal.fixedExpenseCashPaidAmount = addAggregate(monthlyTotal.fixedExpenseCashPaidAmount, itemAmount, '固定費集計')
        if (name === '光熱費') monthlyTotal.utilityCashPaidAmount = addAggregate(monthlyTotal.utilityCashPaidAmount, itemAmount, '光熱費集計')
      }
      if (occurredAt >= bounds.from && occurredAt < bounds.to) {
        const category = categories.get(rowString(item, 'category_id'))
        if (category) { category.cashPaidAmount = addAggregate(category.cashPaidAmount, itemAmount, 'カテゴリ集計'); category.transactionIds.add(rowString(item, 'transaction_id')) }
      }
    }
    let assetTotalAmount = 0; let assetActiveTotalAmount = 0
    for (const account of accountRows) {
      const balance = aggregateInteger(account.balance_amount, '資産合計')
      assetTotalAmount = addAggregate(assetTotalAmount, balance, '資産合計')
      if (!rowNumber(account, 'is_archived')) assetActiveTotalAmount = addAggregate(assetActiveTotalAmount, balance, '有効資産合計')
    }
    const categorySummary = [...categories.values()].map(({ category, cashPaidAmount, transactionIds }): LedgerCategorySummary => ({ ...category, cashPaidAmount, transactionCount: transactionIds.size })).sort((left, right) => left.cashPaidAmount === right.cashPaidAmount ? left.createdAt - right.createdAt : left.cashPaidAmount > right.cashPaidAmount ? -1 : 1)
    return { month: value, expenseCashPaidAmount, incomeCashPaidAmount, previousExpenseCashPaidAmount, expenseChangeAmount: addAggregate(expenseCashPaidAmount, -previousExpenseCashPaidAmount, '支出増減'), assetTotalAmount, assetActiveTotalAmount,
      categories: categorySummary, trend: [...daily.entries()].map(([date, cashPaidAmount]) => ({ date, cashPaidAmount })),
      monthlyTrend: trendMonths.map((trendMonth) => ({ month: trendMonth, ...(monthly.get(trendMonth)!) })), }
  }

  private async getCategory(categoryId: string) {
    const row = await one(this.db, 'SELECT id, name, color, icon, is_default, created_at, updated_at FROM ledger_category WHERE id = ? AND user_id = ?', [categoryId, this.userId])
    return row ? categoryFromRow(row) : null
  }

  private validateInput(input: LedgerTransactionInput) {
    if (!input || typeof input !== 'object') throw new LedgerError('INVALID_INPUT', '明細の内容が不正です。')
    if (input.type !== 'expense' && input.type !== 'income') throw new LedgerError('INVALID_INPUT', '種別は支出または収入で指定してください。')
    const occurredAt = date(input.occurredAt); const title = text(input.title, '支出名・収入名', 200); if (!title) throw new LedgerError('INVALID_INPUT', '支出名・収入名を入力してください。'); const merchant = input.merchant == null ? '' : text(input.merchant, '店舗名', 200); const memo = input.memo == null ? '' : text(input.memo, 'メモ', MAX_TEXT); const paymentMethod = input.paymentMethod == null ? 'cash' : text(input.paymentMethod, '支払方法', 50)
    const receiptId = input.receiptId == null ? null : text(input.receiptId, 'レシートID', 100)
    const accountId = input.accountId == null ? null : text(input.accountId, '口座ID', 100)
    const giftAccountId = input.giftAccountId == null ? null : text(input.giftAccountId, 'ギフト券口座ID', 100)
    if (!Array.isArray(input.items)) throw new LedgerError('INVALID_INPUT', '明細を 1 件以上指定してください。')
    const items = input.items.map((item) => {
      const utilityKind = item.utilityKind == null ? null : item.utilityKind
      if (utilityKind !== null && utilityKind !== 'electricity' && utilityKind !== 'gas' && utilityKind !== 'water' && utilityKind !== 'other') throw new LedgerError('INVALID_UTILITY_KIND', '光熱費の内訳が不正です。')
      return { id: item.id, name: text(item.name, '品名', 200), categoryId: text(item.categoryId, 'カテゴリID', 100), originalAmount: item.originalAmount, discountAmount: item.discountAmount ?? 0, utilityKind }
    })
    if (input.type === 'income') {
      if (receiptId || giftAccountId || items.some((item) => item.discountAmount > 0) || (input.receiptDiscountAmount ?? 0) > 0 || (input.pointUsedAmount ?? 0) > 0 || (input.giftCertificateUsedAmount ?? 0) > 0) {
        throw new LedgerError('INVALID_INCOME', '収入にはレシート、値引き、ポイント、商品券を指定できません。')
      }
    }
    let calculation
    try { calculation = calculateTransaction({ items, receiptDiscountAmount: input.receiptDiscountAmount ?? 0, pointUsedAmount: input.pointUsedAmount ?? 0, giftCertificateUsedAmount: input.giftCertificateUsedAmount ?? 0 }) }
    catch (error) { if (error instanceof MoneyCalculationError) throw new LedgerError('INVALID_AMOUNT', error.message); throw error }
    if (calculation.totals.giftCertificateUsedAmount > 0 && !giftAccountId) throw new LedgerError('GIFT_ACCOUNT_REQUIRED', '商品券を利用するにはギフト券口座を指定してください。')
    if (calculation.totals.giftCertificateUsedAmount === 0 && giftAccountId) throw new LedgerError('GIFT_ACCOUNT_UNUSED', '商品券を利用しない明細にギフト券口座は指定できません。')
    return { type: input.type, occurredAt, title, merchant, memo, paymentMethod, receiptId, accountId, giftAccountId, items, calculation }
  }

  private async ensureReferences(input: ReturnType<LedgerService['validateInput']>, transactionId?: string) {
    await this.ensureDefaultCategories()
    const ids = [...new Set(input.items.map((item) => item.categoryId))]
    const placeholders = ids.map(() => '?').join(',')
    const categories = await rows(this.db, `SELECT id FROM ledger_category WHERE user_id = ? AND id IN (${placeholders})`, [this.userId, ...ids])
    if (categories.length !== ids.length) throw new LedgerError('INVALID_CATEGORY', '選択したカテゴリが見つからないか、アクセスできません。', 422)
    if (input.receiptId) {
      const receipt = await one(this.db, 'SELECT id, analysis_status FROM receipt WHERE id = ? AND user_id = ?', [input.receiptId, this.userId])
      if (!receipt) throw new LedgerError('INVALID_RECEIPT', '選択したレシートが見つからないか、アクセスできません。', 422)
      if (rowString(receipt, 'analysis_status') === 'deleting') throw new LedgerError('RECEIPT_DELETING', 'このレシートは削除中のため添付できません。', 409)
      const attached = await one(this.db, 'SELECT id FROM ledger_transaction WHERE user_id = ? AND receipt_id = ? AND id <> ?', [this.userId, input.receiptId, transactionId ?? ''])
      if (attached) throw new LedgerError('RECEIPT_ALREADY_ATTACHED', 'このレシートはすでに別の明細に添付されています。', 409)
    }
    if (input.accountId) {
      const account = await one(this.db, "SELECT id FROM asset_account WHERE id = ? AND user_id = ? AND is_archived = 0 AND type IN ('bank', 'cash')", [input.accountId, this.userId])
      if (!account) throw new LedgerError('INVALID_ACCOUNT', '選択した銀行・現金口座が見つからないか、利用できません。', 422)
    }
    if (input.giftAccountId) {
      const account = await one(this.db, "SELECT id FROM asset_account WHERE id = ? AND user_id = ? AND is_archived = 0 AND type = 'gift'", [input.giftAccountId, this.userId])
      if (!account) throw new LedgerError('INVALID_GIFT_ACCOUNT', '選択したギフト券口座が見つからないか、利用できません。', 422)
    }
  }

  private transactionValues(input: ReturnType<LedgerService['validateInput']>, revision: number, timestamp: number): SqlValue[] {
    const totals = input.calculation.totals
    return [input.receiptId, input.accountId, input.giftAccountId, input.type, input.occurredAt, input.title, input.merchant, normalizeMerchant(input.merchant), input.memo, input.paymentMethod, totals.grossAmount, totals.itemDiscountAmount, totals.receiptDiscountAmount, totals.discountAmount, totals.netAmount, totals.pointUsedAmount, totals.giftCertificateUsedAmount, totals.nonCashAmount, totals.cashPaidAmount, revision, timestamp]
  }

  private insertStatements(transactionId: string, input: ReturnType<LedgerService['validateInput']>, timestamp: number) {
    return [statement(this.db, 'INSERT INTO ledger_transaction (id, user_id, receipt_id, account_id, gift_account_id, type, occurred_at, title, merchant, merchant_normalized, memo, payment_method, gross_amount, item_discount_amount, receipt_discount_amount, discount_amount, net_amount, point_used_amount, gift_certificate_used_amount, non_cash_amount, cash_paid_amount, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)', [transactionId, this.userId, ...this.transactionValues(input, 1, timestamp).slice(0, -2), timestamp, timestamp]), ...this.itemInsertStatements(transactionId, input)]
  }

  private assetEntryStatements(transactionId: string, input: ReturnType<LedgerService['validateInput']>, timestamp: number, conditionalSql?: string, conditionalTail: SqlValue[] = []) {
    const entries: Array<{ accountId: string; amount: number }> = []
    if (input.accountId && input.calculation.totals.cashPaidAmount > 0) entries.push({ accountId: input.accountId, amount: input.type === 'expense' ? -input.calculation.totals.cashPaidAmount : input.calculation.totals.cashPaidAmount })
    if (input.giftAccountId && input.calculation.totals.giftCertificateUsedAmount > 0) entries.push({ accountId: input.giftAccountId, amount: -input.calculation.totals.giftCertificateUsedAmount })
    return entries.map((entry) => statement(this.db, conditionalSql ?? 'INSERT INTO asset_entry (id, user_id, account_id, operation_id, transaction_id, kind, amount, occurred_at, memo, created_at) VALUES (?, ?, ?, NULL, ?, \'transaction\', ?, ?, ?, ?)', conditionalSql
      ? [id(), this.userId, entry.accountId, transactionId, entry.amount, input.occurredAt, input.title, timestamp, ...conditionalTail]
      : [id(), this.userId, entry.accountId, transactionId, entry.amount, input.occurredAt, input.title, timestamp]))
  }

  private itemInsertStatements(transactionId: string, input: ReturnType<LedgerService['validateInput']>, conditionalSql?: string, conditionalTail: SqlValue[] = []) {
    return input.calculation.items.map((item, sortOrder) => statement(this.db, conditionalSql ?? 'INSERT INTO ledger_transaction_item (id, transaction_id, category_id, name, original_amount, item_discount_amount, allocated_receipt_discount_amount, final_amount, allocated_point_amount, allocated_gift_certificate_amount, paid_amount, utility_kind, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.id || id(), transactionId, item.categoryId, item.name, item.originalAmount, item.itemDiscount, item.allocatedDiscount, item.finalAmount, item.allocatedPointAmount, item.allocatedGiftCertificateAmount, item.paidAmount, input.items[sortOrder]!.utilityKind, sortOrder, ...conditionalTail]))
  }
}

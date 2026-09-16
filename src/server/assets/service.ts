import { LedgerError } from '../ledger/service'
import type { AssetAccount, AssetAccountType, AssetBalanceHistoryPoint, AssetEntry, AssetEntryKind, AssetSummary } from './types'

type SqlValue = string | number | null
type Row = Record<string, unknown>
const DAY = /^\d{4}-\d{2}-\d{2}$/
const MAX_AMOUNT = 1_000_000_000_000

function id() { return crypto.randomUUID() }
function now() { return Date.now() }
function statement(db: D1Database, query: string, values: SqlValue[] = []) { return db.prepare(query).bind(...values) }
async function rows(db: D1Database, query: string, values: SqlValue[] = []) { return (await statement(db, query, values).all<Row>()).results }
async function one(db: D1Database, query: string, values: SqlValue[] = []) { return statement(db, query, values).first<Row>() }
function str(row: Row, key: string) { const value = row[key]; return value == null ? '' : String(value) }
function num(row: Row, key: string) { return Number(row[key]) }
function text(value: unknown, field: string, max = 200) {
  if (typeof value !== 'string') throw new LedgerError('INVALID_INPUT', `${field} を文字列で指定してください。`)
  const result = value.trim()
  if (!result || result.length > max) throw new LedgerError('INVALID_INPUT', `${field} は 1 文字以上 ${max} 文字以下にしてください。`)
  return result
}
function optionalText(value: unknown, field: string, max = 1_000) {
  if (value == null) return ''
  if (typeof value !== 'string') throw new LedgerError('INVALID_INPUT', `${field} を文字列で指定してください。`)
  const result = value.trim()
  if (result.length > max) throw new LedgerError('INVALID_INPUT', `${field} は ${max} 文字以下にしてください。`)
  return result
}
function date(value: unknown) {
  const result = text(value, '日付', 10)
  if (!DAY.test(result)) throw new LedgerError('INVALID_INPUT', '日付は YYYY-MM-DD 形式で指定してください。')
  const [year, month, day] = result.split('-').map(Number); const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw new LedgerError('INVALID_INPUT', '日付は実在する日付で指定してください。')
  return result
}
function amount(value: unknown, field: string, allowNegative = false) {
  if (!Number.isSafeInteger(value) || (!allowNegative && (value as number) < 0) || Math.abs(value as number) > MAX_AMOUNT) throw new LedgerError('INVALID_AMOUNT', `${field} は安全な整数円で指定してください。`)
  return value as number
}
function accountFrom(row: Row): AssetAccount {
  return { id: str(row, 'id'), type: str(row, 'type') as AssetAccountType, name: str(row, 'name'), balanceAmount: num(row, 'balance_amount'), isArchived: Boolean(num(row, 'is_archived')), createdAt: num(row, 'created_at'), updatedAt: num(row, 'updated_at') }
}
function entryFrom(row: Row): AssetEntry {
  return { id: str(row, 'id'), accountId: str(row, 'account_id'), operationId: row.operation_id == null ? null : String(row.operation_id), transactionId: row.transaction_id == null ? null : String(row.transaction_id), kind: str(row, 'kind') as AssetEntryKind, amount: num(row, 'amount'), occurredAt: str(row, 'occurred_at'), memo: str(row, 'memo'), createdAt: num(row, 'created_at') }
}

export class AssetService {
  constructor(private readonly db: D1Database, private readonly userId: string) {}

  async listAccounts(includeArchived = true): Promise<AssetSummary> {
    const accounts = (await rows(this.db, `SELECT * FROM asset_account WHERE user_id = ?${includeArchived ? '' : ' AND is_archived = 0'} ORDER BY is_archived, created_at`, [this.userId])).map(accountFrom)
    return { totalAmount: accounts.reduce((total, account) => total + account.balanceAmount, 0), activeTotalAmount: accounts.filter((account) => !account.isArchived).reduce((total, account) => total + account.balanceAmount, 0), accounts }
  }

  async createAccount(input: { type: unknown; name: unknown; initialBalanceAmount?: unknown; idempotencyKey: unknown }) {
    const key = text(input.idempotencyKey, 'リクエストキー')
    const existing = await this.operationByKey(key)
    if (existing) return { account: await this.requiredAccount(str(existing, 'account_id')), entries: await this.entriesForOperation(str(existing, 'id')), idempotent: true }
    const type = input.type
    if (type !== 'bank' && type !== 'cash' && type !== 'gift') throw new LedgerError('INVALID_ACCOUNT_TYPE', '口座種別が不正です。')
    const name = text(input.name, '口座名', 80); const initialBalanceAmount = amount(input.initialBalanceAmount ?? 0, '初期残高', true)
    if (type === 'gift' && initialBalanceAmount < 0) throw new LedgerError('INVALID_AMOUNT', 'ギフト券残高は負数にできません。')
    const accountId = id(); const operationId = id(); const timestamp = now()
    const statements = [
      statement(this.db, 'INSERT INTO asset_account (id, user_id, type, name, balance_amount, is_archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?)', [accountId, this.userId, type, name, timestamp, timestamp]),
      statement(this.db, 'INSERT INTO asset_operation (id, user_id, account_id, key, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)', [operationId, this.userId, accountId, key, 'opening', timestamp]),
    ]
    if (initialBalanceAmount !== 0) statements.push(this.entryStatement({ accountId, operationId, kind: 'opening', amount: initialBalanceAmount, occurredAt: new Date(timestamp).toISOString().slice(0, 10), memo: '初期残高', createdAt: timestamp }))
    try { await this.db.batch(statements) } catch (error) {
      const raced = await this.operationByKey(key)
      if (raced) return { account: await this.requiredAccount(str(raced, 'account_id')), entries: await this.entriesForOperation(str(raced, 'id')), idempotent: true }
      this.throwMapped(error)
    }
    return { account: await this.requiredAccount(accountId), entries: await this.entriesForOperation(operationId), idempotent: false }
  }

  async updateAccount(accountId: string, input: { name?: unknown; isArchived?: unknown }) {
    const current = await this.requiredAccount(accountId)
    const name = input.name === undefined ? current.name : text(input.name, '口座名', 80)
    const isArchived = input.isArchived === undefined ? current.isArchived : input.isArchived
    if (typeof isArchived !== 'boolean') throw new LedgerError('INVALID_INPUT', 'アーカイブ状態が不正です。')
    try { await statement(this.db, 'UPDATE asset_account SET name = ?, is_archived = ?, updated_at = ? WHERE id = ? AND user_id = ?', [name, isArchived ? 1 : 0, now(), accountId, this.userId]).run() }
    catch (error) { if (String(error).includes('UNIQUE')) throw new LedgerError('ACCOUNT_EXISTS', '同じ名前の口座がすでにあります。', 409); throw error }
    return this.requiredAccount(accountId)
  }

  async listEntries(accountId: string, limit = 100) {
    await this.requiredAccount(accountId)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new LedgerError('INVALID_INPUT', '表示件数は 1 から 200 の範囲で指定してください。')
    return (await rows(this.db, 'SELECT * FROM asset_entry WHERE account_id = ? AND user_id = ? ORDER BY occurred_at DESC, created_at DESC, id DESC LIMIT ?', [accountId, this.userId, limit])).map(entryFrom)
  }

  /** Complete daily total-balance series for the requested inclusive date range. */
  async balanceHistory(input: { from: unknown; to: unknown }): Promise<AssetBalanceHistoryPoint[]> {
    const from = date(input.from); const to = date(input.to)
    if (from > to) throw new LedgerError('INVALID_INPUT', '開始日は終了日以前にしてください。')
    const opening = await one(this.db, 'SELECT COALESCE(SUM(amount), 0) AS amount FROM asset_entry WHERE user_id = ? AND occurred_at < ?', [this.userId, from]) ?? {}
    const changes = await rows(this.db, 'SELECT occurred_at AS date, COALESCE(SUM(amount), 0) AS amount FROM asset_entry WHERE user_id = ? AND occurred_at >= ? AND occurred_at <= ? GROUP BY occurred_at ORDER BY occurred_at', [this.userId, from, to])
    let balanceAmount = num(opening, 'amount')
    return changes.map((change) => {
      const deltaAmount = num(change, 'amount'); balanceAmount += deltaAmount
      return { date: str(change, 'date'), deltaAmount, balanceAmount }
    })
  }

  async adjustAccount(accountId: string, input: { amount: unknown; occurredAt: unknown; memo?: unknown; idempotencyKey: unknown }) {
    await this.requiredActiveAccount(accountId)
    const key = text(input.idempotencyKey, 'リクエストキー'); const existing = await this.operationByKey(key)
    if (existing) return { entries: await this.entriesForOperation(str(existing, 'id')), idempotent: true }
    const adjustmentAmount = amount(input.amount, '調整額', true); if (adjustmentAmount === 0) throw new LedgerError('INVALID_AMOUNT', '調整額は 0 円以外で指定してください。')
    const operationId = id(); const timestamp = now()
    const entry = this.entryStatement({ accountId, operationId, kind: 'adjustment', amount: adjustmentAmount, occurredAt: date(input.occurredAt), memo: optionalText(input.memo, 'メモ'), createdAt: timestamp })
    try { await this.db.batch([
      statement(this.db, 'INSERT INTO asset_operation (id, user_id, account_id, key, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)', [operationId, this.userId, accountId, key, 'adjustment', timestamp]), entry,
    ]) } catch (error) {
      const raced = await this.operationByKey(key)
      if (raced) return { entries: await this.entriesForOperation(str(raced, 'id')), idempotent: true }
      this.throwMapped(error)
    }
    return { entries: await this.entriesForOperation(operationId), idempotent: false }
  }

  async transfer(input: { fromAccountId: unknown; toAccountId: unknown; amount: unknown; occurredAt: unknown; memo?: unknown; idempotencyKey: unknown }) {
    const key = text(input.idempotencyKey, 'リクエストキー'); const existing = await this.operationByKey(key)
    if (existing) return { entries: await this.entriesForOperation(str(existing, 'id')), idempotent: true }
    const fromAccountId = text(input.fromAccountId, '振替元口座ID', 100); const toAccountId = text(input.toAccountId, '振替先口座ID', 100)
    if (fromAccountId === toAccountId) throw new LedgerError('INVALID_TRANSFER', '同じ口座間では振替できません。')
    const from = await this.requiredActiveAccount(fromAccountId); const to = await this.requiredActiveAccount(toAccountId)
    if (from.type === 'gift' || !['bank', 'cash'].includes(to.type)) {
      if (from.type === 'gift' || to.type !== 'gift') throw new LedgerError('INVALID_TRANSFER', '振替元は銀行または現金、振替先は銀行・現金・ギフト券を指定してください。')
    }
    const transferAmount = amount(input.amount, '振替額'); if (transferAmount === 0) throw new LedgerError('INVALID_AMOUNT', '振替額は 0 円より大きくしてください。')
    const operationId = id(); const timestamp = now(); const occurredAt = date(input.occurredAt); const memo = optionalText(input.memo, 'メモ')
    try { await this.db.batch([
      statement(this.db, 'INSERT INTO asset_operation (id, user_id, account_id, key, kind, created_at) VALUES (?, ?, NULL, ?, ?, ?)', [operationId, this.userId, key, 'transfer', timestamp]),
      this.entryStatement({ accountId: from.id, operationId, kind: 'transfer', amount: -transferAmount, occurredAt, memo, createdAt: timestamp }),
      this.entryStatement({ accountId: to.id, operationId, kind: 'transfer', amount: transferAmount, occurredAt, memo, createdAt: timestamp }),
    ]) } catch (error) {
      const raced = await this.operationByKey(key)
      if (raced) return { entries: await this.entriesForOperation(str(raced, 'id')), idempotent: true }
      this.throwMapped(error)
    }
    return { entries: await this.entriesForOperation(operationId), idempotent: false }
  }

  private entryStatement(input: { accountId: string; operationId?: string; transactionId?: string; kind: AssetEntryKind; amount: number; occurredAt: string; memo: string; createdAt: number }) {
    return statement(this.db, 'INSERT INTO asset_entry (id, user_id, account_id, operation_id, transaction_id, kind, amount, occurred_at, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id(), this.userId, input.accountId, input.operationId ?? null, input.transactionId ?? null, input.kind, input.amount, input.occurredAt, input.memo, input.createdAt])
  }

  private async operationByKey(key: string) { return one(this.db, 'SELECT * FROM asset_operation WHERE user_id = ? AND key = ?', [this.userId, key]) }
  private async entriesForOperation(operationId: string) { return (await rows(this.db, 'SELECT * FROM asset_entry WHERE operation_id = ? AND user_id = ? ORDER BY created_at, id', [operationId, this.userId])).map(entryFrom) }
  private async requiredAccount(accountId: string) {
    const row = await one(this.db, 'SELECT * FROM asset_account WHERE id = ? AND user_id = ?', [accountId, this.userId])
    if (!row) throw new LedgerError('ACCOUNT_NOT_FOUND', '口座が見つかりません。', 404)
    return accountFrom(row)
  }
  private async requiredActiveAccount(accountId: string) {
    const account = await this.requiredAccount(accountId)
    if (account.isArchived) throw new LedgerError('ACCOUNT_ARCHIVED', 'アーカイブ済みの口座は利用できません。', 409)
    return account
  }
  private throwMapped(error: unknown): never {
    if (String(error).includes('gift balance insufficient')) throw new LedgerError('INSUFFICIENT_GIFT_BALANCE', 'ギフト券残高が不足しています。', 409)
    throw error
  }
}

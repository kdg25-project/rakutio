import { LedgerService } from '../ledger/service'
import type { LedgerTransactionInput } from '../ledger/types'

type Row = Record<string, unknown>
type SqlValue = string | number | null

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const MAX_RULES_PER_RUN = 100
const MAX_MONTHS_PER_RULE = 24

export class PlanningError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422, readonly details?: unknown) {
    super(message)
    this.name = 'PlanningError'
  }
}

export type MonthlyTarget = {
  id: string
  month: string
  expenseTargetAmount: number
  incomeTargetAmount: number
  expenseActualAmount: number
  incomeActualAmount: number
  expenseProgress: number | null
  incomeProgress: number | null
  createdAt: number
  updatedAt: number
}

export type RecurringRule = {
  id: string
  title: string
  amount: number
  categoryId: string
  paymentMethod: string
  accountId: string | null
  paymentDay: number
  startDate: string
  endDate: string | null
  active: boolean
  createdAt: number
  updatedAt: number
  generatedMonthCount: number
  lastGeneratedMonth: string | null
}

export type RecurringRunResult = {
  created: number
  skipped: number
  failed: number
  processedRules: number
  hasMore: boolean
}

function statement(db: D1Database, query: string, values: SqlValue[] = []) { return db.prepare(query).bind(...values) }
async function one(db: D1Database, query: string, values: SqlValue[] = []) { return statement(db, query, values).first<Row>() }
async function rows(db: D1Database, query: string, values: SqlValue[] = []) { return (await statement(db, query, values).all<Row>()).results }
function id() { return crypto.randomUUID() }
function timestamp() { return Date.now() }
function rowString(row: Row, key: string) { return row[key] == null ? '' : String(row[key]) }
function rowNumber(row: Row, key: string) { return Number(row[key]) }
function rowNullableString(row: Row, key: string) { return row[key] == null ? null : String(row[key]) }

function requiredText(value: unknown, field: string, max = 200) {
  if (typeof value !== 'string') throw new PlanningError('INVALID_INPUT', `${field} を文字列で指定してください。`)
  const normalized = value.trim()
  if (!normalized || normalized.length > max) throw new PlanningError('INVALID_INPUT', `${field} は 1 から ${max} 文字で指定してください。`)
  return normalized
}

function optionalText(value: unknown, field: string, max = 200) {
  if (value == null || value === '') return null
  return requiredText(value, field, max)
}

function nonnegativeAmount(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new PlanningError('INVALID_INPUT', `${field} は 0 以上の整数で指定してください。`)
  return value as number
}

function positiveAmount(value: unknown, field: string) {
  const amount = nonnegativeAmount(value, field)
  if (amount === 0) throw new PlanningError('INVALID_INPUT', `${field} は 1 円以上で指定してください。`)
  return amount
}

export function validateMonth(value: unknown) {
  if (typeof value !== 'string' || !MONTH.test(value)) throw new PlanningError('INVALID_INPUT', '月は YYYY-MM 形式で指定してください。')
  return value
}

export function validateDate(value: unknown, field: string) {
  if (typeof value !== 'string' || !DATE.test(value)) throw new PlanningError('INVALID_INPUT', `${field} は YYYY-MM-DD 形式で指定してください。`)
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw new PlanningError('INVALID_INPUT', `${field} は実在する日付で指定してください。`)
  return value
}

function validatePaymentDay(value: unknown) {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 31) throw new PlanningError('INVALID_INPUT', '支払日は 1 から 31 の範囲で指定してください。')
  return value as number
}

function validateActive(value: unknown) {
  if (typeof value !== 'boolean') throw new PlanningError('INVALID_INPUT', '有効状態は true または false で指定してください。')
  return value
}

function nextMonth(value: string) {
  const [year, month] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function monthOf(date: string) { return date.slice(0, 7) }
function lastDayOfMonth(month: string) {
  const [year, numericMonth] = month.split('-').map(Number)
  return new Date(Date.UTC(year, numericMonth, 0)).getUTCDate()
}
function occurrenceDate(month: string, paymentDay: number) { return `${month}-${String(Math.min(paymentDay, lastDayOfMonth(month))).padStart(2, '0')}` }

export function jstToday(input: Date | string = new Date()) {
  if (typeof input === 'string') return validateDate(input, '実行日')
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(input)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

function progress(actual: number, target: number) { return target === 0 ? null : Math.min(actual / target, 1) }

function targetFromRow(row: Row, actual: { expense: number; income: number }): MonthlyTarget {
  const expenseTargetAmount = rowNumber(row, 'expense_target_amount')
  const incomeTargetAmount = rowNumber(row, 'income_target_amount')
  return {
    id: rowString(row, 'id'), month: rowString(row, 'month'), expenseTargetAmount, incomeTargetAmount,
    expenseActualAmount: actual.expense, incomeActualAmount: actual.income,
    expenseProgress: progress(actual.expense, expenseTargetAmount), incomeProgress: progress(actual.income, incomeTargetAmount),
    createdAt: rowNumber(row, 'created_at'), updatedAt: rowNumber(row, 'updated_at'),
  }
}

function ruleFromRow(row: Row): RecurringRule {
  return {
    id: rowString(row, 'id'), title: rowString(row, 'title'), amount: rowNumber(row, 'amount'), categoryId: rowString(row, 'category_id'),
    paymentMethod: rowString(row, 'payment_method'), accountId: rowNullableString(row, 'account_id'), paymentDay: rowNumber(row, 'payment_day'),
    startDate: rowString(row, 'start_date'), endDate: rowNullableString(row, 'end_date'), active: Boolean(rowNumber(row, 'active')),
    createdAt: rowNumber(row, 'created_at'), updatedAt: rowNumber(row, 'updated_at'), generatedMonthCount: rowNumber(row, 'generated_month_count'), lastGeneratedMonth: rowNullableString(row, 'last_generated_month'),
  }
}

async function ensureCategory(db: D1Database, userId: string, categoryId: string) {
  const category = await one(db, 'SELECT id FROM ledger_category WHERE id = ? AND user_id = ?', [categoryId, userId])
  if (!category) throw new PlanningError('INVALID_CATEGORY', '選択したカテゴリが見つからないか、アクセスできません。', 422)
}

async function ensureCashAccount(db: D1Database, userId: string, accountId: string) {
  const account = await one(db, "SELECT id FROM asset_account WHERE id = ? AND user_id = ? AND is_archived = 0 AND type IN ('bank', 'cash')", [accountId, userId])
  if (!account) throw new PlanningError('INVALID_ACCOUNT', '選択した有効な銀行・現金口座が見つからないか、アクセスできません。', 422)
}

async function targetActuals(db: D1Database, userId: string, month: string) {
  const row = await one(db,
    "SELECT COALESCE(SUM(CASE WHEN type = 'expense' THEN cash_paid_amount ELSE 0 END), 0) AS expense, COALESCE(SUM(CASE WHEN type = 'income' THEN cash_paid_amount ELSE 0 END), 0) AS income FROM ledger_transaction WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ?",
    [userId, `${month}-01`, `${nextMonth(month)}-01`],
  )
  return { expense: row ? rowNumber(row, 'expense') : 0, income: row ? rowNumber(row, 'income') : 0 }
}

export class PlanningService {
  constructor(private readonly db: D1Database, private readonly userId: string) {}

  async listMonthlyTargets(month?: unknown) {
    const where = ['user_id = ?']; const values: SqlValue[] = [this.userId]
    if (month != null) { where.push('month = ?'); values.push(validateMonth(month)) }
    const targets = await rows(this.db, `SELECT * FROM planning_monthly_target WHERE ${where.join(' AND ')} ORDER BY month DESC`, values)
    return await Promise.all(targets.map(async (target) => targetFromRow(target, await targetActuals(this.db, this.userId, rowString(target, 'month')))))
  }

  async createMonthlyTarget(input: Record<string, unknown>) {
    const month = validateMonth(input.month)
    const expenseTargetAmount = nonnegativeAmount(input.expenseTargetAmount, '支出予算')
    const incomeTargetAmount = nonnegativeAmount(input.incomeTargetAmount, '収入目標')
    const now = timestamp(); const targetId = id()
    try {
      await statement(this.db, 'INSERT INTO planning_monthly_target (id, user_id, month, expense_target_amount, income_target_amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [targetId, this.userId, month, expenseTargetAmount, incomeTargetAmount, now, now]).run()
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new PlanningError('MONTH_TARGET_EXISTS', 'この月の予算・目標はすでに登録されています。', 409)
      throw error
    }
    return (await this.getMonthlyTarget(targetId))!
  }

  async getMonthlyTarget(targetId: string) {
    const target = await one(this.db, 'SELECT * FROM planning_monthly_target WHERE id = ? AND user_id = ?', [targetId, this.userId])
    return target ? targetFromRow(target, await targetActuals(this.db, this.userId, rowString(target, 'month'))) : null
  }

  async updateMonthlyTarget(targetId: string, input: Record<string, unknown>) {
    const current = await this.getMonthlyTarget(targetId)
    if (!current) throw new PlanningError('NOT_FOUND', '予算・目標が見つかりません。', 404)
    const expenseTargetAmount = input.expenseTargetAmount === undefined ? current.expenseTargetAmount : nonnegativeAmount(input.expenseTargetAmount, '支出予算')
    const incomeTargetAmount = input.incomeTargetAmount === undefined ? current.incomeTargetAmount : nonnegativeAmount(input.incomeTargetAmount, '収入目標')
    await statement(this.db, 'UPDATE planning_monthly_target SET expense_target_amount = ?, income_target_amount = ?, updated_at = ? WHERE id = ? AND user_id = ?', [expenseTargetAmount, incomeTargetAmount, timestamp(), targetId, this.userId]).run()
    return (await this.getMonthlyTarget(targetId))!
  }

  async deleteMonthlyTarget(targetId: string) {
    const result = await statement(this.db, 'DELETE FROM planning_monthly_target WHERE id = ? AND user_id = ?', [targetId, this.userId]).run()
    if (result.meta.changes !== 1) throw new PlanningError('NOT_FOUND', '予算・目標が見つかりません。', 404)
  }

  async listRecurringRules() { return (await rows(this.db, `${ruleSelect('r.user_id = ?')} ORDER BY r.active DESC, r.created_at DESC`, [this.userId])).map(ruleFromRow) }

  async getRecurringRule(ruleId: string) {
    const rule = await one(this.db, ruleSelect('r.id = ? AND r.user_id = ?'), [ruleId, this.userId])
    return rule ? ruleFromRow(rule) : null
  }

  async createRecurringRule(input: Record<string, unknown>) {
    const rule = await validateRule(this.db, this.userId, input)
    const now = timestamp(); const ruleId = id()
    await statement(this.db, 'INSERT INTO planning_recurring_rule (id, user_id, title, amount, category_id, payment_method, account_id, payment_day, start_date, end_date, active, next_due_month, last_attempted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)', [ruleId, this.userId, rule.title, rule.amount, rule.categoryId, rule.paymentMethod, rule.accountId, rule.paymentDay, rule.startDate, rule.endDate, rule.active ? 1 : 0, monthOf(rule.startDate), now, now]).run()
    return (await this.getRecurringRule(ruleId))!
  }

  async updateRecurringRule(ruleId: string, input: Record<string, unknown>) {
    const current = await this.getRecurringRule(ruleId)
    if (!current) throw new PlanningError('NOT_FOUND', '定期支出が見つかりません。', 404)
    const rule = await validateRule(this.db, this.userId, { ...current, ...input })
    const stored = await one(this.db, 'SELECT next_due_month FROM planning_recurring_rule WHERE id = ? AND user_id = ?', [ruleId, this.userId])
    const nextDueMonth = !stored || rowString(stored, 'next_due_month') < monthOf(rule.startDate) ? monthOf(rule.startDate) : rowString(stored, 'next_due_month')
    await statement(this.db, 'UPDATE planning_recurring_rule SET title = ?, amount = ?, category_id = ?, payment_method = ?, account_id = ?, payment_day = ?, start_date = ?, end_date = ?, active = ?, next_due_month = ?, updated_at = ? WHERE id = ? AND user_id = ?', [rule.title, rule.amount, rule.categoryId, rule.paymentMethod, rule.accountId, rule.paymentDay, rule.startDate, rule.endDate, rule.active ? 1 : 0, nextDueMonth, timestamp(), ruleId, this.userId]).run()
    return (await this.getRecurringRule(ruleId))!
  }

  /** Stopping a rule preserves its generated transaction and run history. */
  async stopRecurringRule(ruleId: string) {
    const result = await statement(this.db, 'UPDATE planning_recurring_rule SET active = 0, updated_at = ? WHERE id = ? AND user_id = ?', [timestamp(), ruleId, this.userId]).run()
    if (result.meta.changes !== 1) throw new PlanningError('NOT_FOUND', '定期支出が見つかりません。', 404)
    return (await this.getRecurringRule(ruleId))!
  }

  async runDueRecurring(date: Date | string = new Date()) { return await runDueRecurringForUser(this.db, this.userId, date) }
}

function ruleSelect(where: string) {
  return `SELECT r.*, COUNT(rr.rule_id) AS generated_month_count, MAX(rr.month) AS last_generated_month FROM planning_recurring_rule AS r LEFT JOIN planning_recurring_run AS rr ON rr.rule_id = r.id WHERE ${where} GROUP BY r.id`
}

async function validateRule(db: D1Database, userId: string, input: Record<string, unknown>) {
  const title = requiredText(input.title, '定期支出名')
  const amount = positiveAmount(input.amount, '金額')
  const categoryId = requiredText(input.categoryId, 'カテゴリID', 100)
  await new LedgerService(db, userId).ensureDefaultCategories()
  await ensureCategory(db, userId, categoryId)
  const paymentMethod = requiredText(input.paymentMethod, '支払方法', 50)
  const accountId = optionalText(input.accountId, '口座ID', 100)
  if (accountId) await ensureCashAccount(db, userId, accountId)
  const paymentDay = validatePaymentDay(input.paymentDay)
  const startDate = validateDate(input.startDate, '開始日')
  const endDate = input.endDate === undefined ? null : optionalText(input.endDate, '終了日', 10)
  if (endDate && validateDate(endDate, '終了日') < startDate) throw new PlanningError('INVALID_INPUT', '終了日は開始日以降で指定してください。')
  const active = input.active === undefined ? true : validateActive(input.active)
  return { title, amount, categoryId, paymentMethod, accountId, paymentDay, startDate, endDate, active }
}

async function runRuleMonth(db: D1Database, row: Row, month: string): Promise<'created' | 'skipped'> {
  const ruleId = rowString(row, 'id')
  const existing = await one(db, 'SELECT transaction_id FROM planning_recurring_run WHERE rule_id = ? AND month = ?', [ruleId, month])
  if (existing) return 'skipped'
  const occurredAt = occurrenceDate(month, rowNumber(row, 'payment_day'))

  const input: LedgerTransactionInput & { accountId?: string } = {
    type: 'expense', title: rowString(row, 'title'), occurredAt, merchant: '', paymentMethod: rowString(row, 'payment_method'),
    items: [{ categoryId: rowString(row, 'category_id'), name: rowString(row, 'title'), originalAmount: rowNumber(row, 'amount') }],
    ...(row.account_id == null ? {} : { accountId: String(row.account_id) }),
  }
  const ledger = new LedgerService(db, rowString(row, 'user_id'))
  const created = await ledger.createTransaction(input, `recurring:${ruleId}:${month}`, true)
  const run = await statement(db, 'INSERT INTO planning_recurring_run (rule_id, month, transaction_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(rule_id, month) DO NOTHING', [ruleId, month, created.transaction.id, timestamp()]).run()
  return run.meta.changes === 1 ? 'created' : 'skipped'
}

async function updateRuleProgress(db: D1Database, ruleId: string, userId: string, nextDueMonth: string, active: boolean, attemptedAt: number) {
  await statement(db, 'UPDATE planning_recurring_rule SET next_due_month = ?, active = ?, last_attempted_at = ? WHERE id = ? AND user_id = ?', [nextDueMonth, active ? 1 : 0, attemptedAt, ruleId, userId]).run()
}

async function processRule(db: D1Database, row: Row, today: string, attemptedAt: number) {
  const ruleId = rowString(row, 'id'); const userId = rowString(row, 'user_id')
  const currentMonth = monthOf(today)
  let nextDueMonth = rowString(row, 'next_due_month')
  let created = 0; let skipped = 0; let failed = 0; let active = true; let processedMonths = 0

  while (nextDueMonth <= currentMonth && processedMonths < MAX_MONTHS_PER_RULE) {
    const occurredAt = occurrenceDate(nextDueMonth, rowNumber(row, 'payment_day'))
    if (occurredAt < rowString(row, 'start_date')) {
      skipped += 1; processedMonths += 1; nextDueMonth = nextMonth(nextDueMonth); continue
    }
    if (row.end_date != null && occurredAt > rowString(row, 'end_date')) {
      active = false
      break
    }
    // The current month's payment is not due yet. Keep the cursor unchanged
    // so the next daily run will generate it at the intended JST date.
    if (occurredAt > today) break
    try {
      const outcome = await runRuleMonth(db, row, nextDueMonth)
      if (outcome === 'created') created += 1
      else skipped += 1
      processedMonths += 1
      nextDueMonth = nextMonth(nextDueMonth)
    } catch {
      failed += 1
      // Do not advance a failed due month. It remains retriable and cannot
      // silently disappear from the catch-up sequence.
      break
    }
  }

  await updateRuleProgress(db, ruleId, userId, nextDueMonth, active, attemptedAt)
  return { created, skipped, failed, hasMore: active && nextDueMonth <= currentMonth && occurrenceDate(nextDueMonth, rowNumber(row, 'payment_day')) <= today }
}

async function runRules(db: D1Database, rules: Row[], today: string, attemptBase: number): Promise<RecurringRunResult> {
  const result: RecurringRunResult = { created: 0, skipped: 0, failed: 0, processedRules: rules.length, hasMore: false }
  for (const [index, rule] of rules.entries()) {
    const outcome = await processRule(db, rule, today, attemptBase + index)
    result.created += outcome.created
    result.skipped += outcome.skipped
    result.failed += outcome.failed
    result.hasMore ||= outcome.hasMore
  }
  return result
}

async function nextAttemptBase(db: D1Database, where: string, values: SqlValue[]) {
  const latest = await one(db, `SELECT MAX(last_attempted_at) AS value FROM planning_recurring_rule WHERE ${where}`, values)
  const lastAttemptedAt = latest ? Number(latest.value) : 0
  return Math.max(timestamp(), Number.isSafeInteger(lastAttemptedAt) ? lastAttemptedAt + 1 : 0)
}

/** Scheduled-worker entry point: processes due active rules across all users in JST. */
export async function runDueRecurring(db: D1Database, date: Date | string = new Date()) {
  const today = jstToday(date)
  const rules = await rows(db, `${ruleSelect('r.active = 1')} ORDER BY r.last_attempted_at, r.id LIMIT ?`, [MAX_RULES_PER_RUN + 1])
  const selected = rules.slice(0, MAX_RULES_PER_RUN)
  const result = await runRules(db, selected, today, await nextAttemptBase(db, 'active = 1', []))
  return { ...result, hasMore: result.hasMore || rules.length > MAX_RULES_PER_RUN }
}

export async function runDueRecurringForUser(db: D1Database, userId: string, date: Date | string = new Date()) {
  const today = jstToday(date)
  const rules = await rows(db, `${ruleSelect('r.user_id = ? AND r.active = 1')} ORDER BY r.last_attempted_at, r.id LIMIT ?`, [userId, MAX_RULES_PER_RUN + 1])
  const selected = rules.slice(0, MAX_RULES_PER_RUN)
  const result = await runRules(db, selected, today, await nextAttemptBase(db, 'user_id = ? AND active = 1', [userId]))
  return { ...result, hasMore: result.hasMore || rules.length > MAX_RULES_PER_RUN }
}

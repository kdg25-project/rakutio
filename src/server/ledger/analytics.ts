import { LedgerError } from './service'

type Row = Record<string, unknown>
type UtilityKind = 'electricity' | 'gas' | 'water' | 'other'
type Totals = { income: bigint; expense: bigint; fixed: bigint }
type UtilityTotals = Record<UtilityKind, bigint>
type TrendValue = Totals & { utility: UtilityTotals }

const DAY = /^\d{4}-\d{2}-\d{2}$/
const MAX_RANGE_DAYS = 3660
const FIXED_CATEGORY_NAMES = new Set(['住居費', '通信費', 'サブスク', '保険'])
const UTILITY_CATEGORY_NAME = '光熱費'
const utilityKinds: UtilityKind[] = ['electricity', 'gas', 'water', 'other']

export type LedgerAnalyticsPoint = {
  date: string
  incomeAmount: number
  expenseAmount: number
  netAmount: number
  fixedExpenseAmount: number
}

export type LedgerAnalyticsMonthlyPoint = Omit<LedgerAnalyticsPoint, 'date'> & { month: string }

export type UtilityDailyPoint = { date: string } & Record<UtilityKind, number>
export type UtilityMonthlyPoint = { month: string } & Record<UtilityKind, number>

export type LedgerAnalytics = {
  range: { from: string; to: string; previousFrom: string; previousTo: string }
  scope: { categoryId: string | null; incomeScope: 'all' }
  totals: { incomeAmount: number; expenseAmount: number; netAmount: number; fixedExpenseAmount: number }
  previousTotals: { incomeAmount: number; expenseAmount: number; netAmount: number; fixedExpenseAmount: number }
  categories: Array<{ categoryId: string; name: string; color: string; icon: string; paidAmount: number }>
  trend: { daily: LedgerAnalyticsPoint[]; monthly: LedgerAnalyticsMonthlyPoint[] }
  fixed: { paidAmount: number; daily: Array<{ date: string; paidAmount: number }>; monthly: Array<{ month: string; paidAmount: number }> }
  utility: { totals: Record<UtilityKind, number>; daily: UtilityDailyPoint[]; monthly: UtilityMonthlyPoint[] }
}

function statement(db: D1Database, query: string, values: Array<string | number> = []) { return db.prepare(query).bind(...values) }
async function rows(db: D1Database, query: string, values: Array<string | number> = []) { return (await statement(db, query, values).all<Row>()).results }
async function one(db: D1Database, query: string, values: Array<string | number> = []) { return statement(db, query, values).first<Row>() }

function invalidRange(message: string): never { throw new LedgerError('INVALID_INPUT', message, 400) }

function validateDate(value: string | null, field: string) {
  if (!value || !DAY.test(value)) invalidRange(`${field} は YYYY-MM-DD 形式で指定してください。`)
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) invalidRange(`${field} は実在する日付で指定してください。`)
  return value
}

function addDays(value: string, days: number) {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function dayDistance(from: string, to: string) {
  const [fromYear, fromMonth, fromDay] = from.split('-').map(Number)
  const [toYear, toMonth, toDay] = to.split('-').map(Number)
  return Math.floor((Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86_400_000)
}

export function analyticsRange(fromValue: string | null, toValue: string | null) {
  const from = validateDate(fromValue, '開始日')
  const to = validateDate(toValue, '終了日')
  const days = dayDistance(from, to)
  if (days < 0) invalidRange('終了日は開始日以降で指定してください。')
  if (days + 1 > MAX_RANGE_DAYS) invalidRange('集計期間は 10 年以内で指定してください。')
  return { from, to, previousFrom: addDays(from, -(days + 1)), previousTo: addDays(from, -1) }
}

function bigint(value: unknown, field: string) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  throw new LedgerError('AMOUNT_RANGE_EXCEEDED', `${field} を安全な整数として集計できません。`, 422)
}

function safeNumber(value: bigint, field: string) {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new LedgerError('AMOUNT_RANGE_EXCEEDED', `${field} が集計可能な範囲を超えています。`, 422)
  return Number(value)
}

function emptyUtility(): UtilityTotals { return { electricity: 0n, gas: 0n, water: 0n, other: 0n } }
function emptyTrend(): TrendValue { return { income: 0n, expense: 0n, fixed: 0n, utility: emptyUtility() } }
function monthOf(value: string) { return value.slice(0, 7) }

function dateSeries(from: string, to: string) {
  const values: string[] = []
  for (let current = from; current <= to; current = addDays(current, 1)) values.push(current)
  return values
}

function monthSeries(from: string, to: string) {
  const values: string[] = []; let current = `${monthOf(from)}-01`; const end = `${monthOf(to)}-01`
  while (current <= end) {
    values.push(current.slice(0, 7))
    const [year, month] = current.slice(0, 7).split('-').map(Number)
    current = `${new Date(Date.UTC(year, month, 1)).getUTCFullYear()}-${String(new Date(Date.UTC(year, month, 1)).getUTCMonth() + 1).padStart(2, '0')}-01`
  }
  return values
}

function utilityKind(value: unknown): UtilityKind {
  return value === 'electricity' || value === 'gas' || value === 'water' || value === 'other' ? value : 'other'
}

function point(date: string, value: TrendValue): LedgerAnalyticsPoint {
  const incomeAmount = safeNumber(value.income, '収入集計')
  const expenseAmount = safeNumber(value.expense, '支出集計')
  return { date, incomeAmount, expenseAmount, netAmount: safeNumber(value.income - value.expense, '収支集計'), fixedExpenseAmount: safeNumber(value.fixed, '固定費集計') }
}

function utilityPoint<T extends 'date' | 'month'>(key: T, value: string, totals: UtilityTotals): Record<T, string> & Record<UtilityKind, number> {
  return { [key]: value, electricity: safeNumber(totals.electricity, '電気料金集計'), gas: safeNumber(totals.gas, 'ガス料金集計'), water: safeNumber(totals.water, '水道料金集計'), other: safeNumber(totals.other, 'その他光熱費集計') } as Record<T, string> & Record<UtilityKind, number>
}

function utilityNumbers(totals: UtilityTotals): Record<UtilityKind, number> {
  return { electricity: safeNumber(totals.electricity, '電気料金集計'), gas: safeNumber(totals.gas, 'ガス料金集計'), water: safeNumber(totals.water, '水道料金集計'), other: safeNumber(totals.other, 'その他光熱費集計') }
}

export class LedgerAnalyticsService {
  constructor(private readonly db: D1Database, private readonly userId: string) {}

  async analytics(input: { from: string | null; to: string | null; categoryId: string | null }): Promise<LedgerAnalytics> {
    const range = analyticsRange(input.from, input.to)
    const categoryId = input.categoryId || null
    if (categoryId) {
      const category = await one(this.db, 'SELECT id FROM ledger_category WHERE id = ? AND user_id = ?', [categoryId, this.userId])
      if (!category) throw new LedgerError('INVALID_CATEGORY', '選択したカテゴリが見つからないか、アクセスできません。', 422)
    }

    const incomeRows = await rows(this.db, 'SELECT occurred_at, cash_paid_amount FROM ledger_transaction WHERE user_id = ? AND type = \'income\' AND occurred_at >= ? AND occurred_at <= ?', [this.userId, range.previousFrom, range.to])
    const expenseWhere = ['t.user_id = ?', "t.type = 'expense'", 't.occurred_at >= ?', 't.occurred_at <= ?']
    const expenseValues: Array<string | number> = [this.userId, range.previousFrom, range.to]
    if (categoryId) { expenseWhere.push('i.category_id = ?'); expenseValues.push(categoryId) }
    const expenseRows = await rows(this.db, `SELECT t.occurred_at, i.category_id, i.paid_amount, i.utility_kind, c.name AS category_name, c.color AS category_color, c.icon AS category_icon FROM ledger_transaction AS t INNER JOIN ledger_transaction_item AS i ON i.transaction_id = t.id INNER JOIN ledger_category AS c ON c.id = i.category_id WHERE ${expenseWhere.join(' AND ')}`, expenseValues)

    const daily = new Map(dateSeries(range.from, range.to).map((date) => [date, emptyTrend()]))
    const monthly = new Map(monthSeries(range.from, range.to).map((month) => [month, emptyTrend()]))
    const current: Totals = { income: 0n, expense: 0n, fixed: 0n }
    const previous: Totals = { income: 0n, expense: 0n, fixed: 0n }
    const utility = emptyUtility()
    const categories = new Map<string, { categoryId: string; name: string; color: string; icon: string; paidAmount: bigint }>()

    for (const row of incomeRows) {
      const occurredAt = String(row.occurred_at); const amount = bigint(row.cash_paid_amount, '収入集計額')
      if (occurredAt >= range.from) {
        current.income += amount
        const dailyValue = daily.get(occurredAt); if (dailyValue) dailyValue.income += amount
        const monthlyValue = monthly.get(monthOf(occurredAt)); if (monthlyValue) monthlyValue.income += amount
      } else previous.income += amount
    }

    for (const row of expenseRows) {
      const occurredAt = String(row.occurred_at); const amount = bigint(row.paid_amount, '支出明細集計額'); const fixed = FIXED_CATEGORY_NAMES.has(String(row.category_name))
      if (occurredAt < range.from) {
        previous.expense += amount
        if (fixed) previous.fixed += amount
        continue
      }
      current.expense += amount
      if (fixed) current.fixed += amount
      const dailyValue = daily.get(occurredAt); const monthlyValue = monthly.get(monthOf(occurredAt))
      if (dailyValue) { dailyValue.expense += amount; if (fixed) dailyValue.fixed += amount }
      if (monthlyValue) { monthlyValue.expense += amount; if (fixed) monthlyValue.fixed += amount }
      const id = String(row.category_id)
      const category = categories.get(id) ?? { categoryId: id, name: String(row.category_name), color: String(row.category_color), icon: String(row.category_icon), paidAmount: 0n }
      category.paidAmount += amount; categories.set(id, category)
      // New rows carry durable classification metadata.  The category-name
      // fallback keeps older unclassified 光熱費 rows visible as "other".
      // Metadata must win so a later category rename/remap cannot erase a
      // recorded electricity, gas, or water allocation from analytics.
      if (row.utility_kind != null || String(row.category_name) === UTILITY_CATEGORY_NAME) {
        const kind = utilityKind(row.utility_kind)
        utility[kind] += amount
        if (dailyValue) dailyValue.utility[kind] += amount
        if (monthlyValue) monthlyValue.utility[kind] += amount
      }
    }

    const dailyPoints = [...daily.entries()].map(([date, value]) => point(date, value))
    const monthlyPoints = [...monthly.entries()].map(([month, value]) => {
      const { date: _date, ...amounts } = point(month, value)
      return { month, ...amounts }
    })
    const categoryPoints = [...categories.values()].map((category) => ({ ...category, paidAmount: safeNumber(category.paidAmount, 'カテゴリ集計') })).sort((left, right) => right.paidAmount - left.paidAmount || left.name.localeCompare(right.name, 'ja'))
    return {
      range, scope: { categoryId, incomeScope: 'all' },
      totals: { incomeAmount: safeNumber(current.income, '収入集計'), expenseAmount: safeNumber(current.expense, '支出集計'), netAmount: safeNumber(current.income - current.expense, '収支集計'), fixedExpenseAmount: safeNumber(current.fixed, '固定費集計') },
      previousTotals: { incomeAmount: safeNumber(previous.income, '前期間収入集計'), expenseAmount: safeNumber(previous.expense, '前期間支出集計'), netAmount: safeNumber(previous.income - previous.expense, '前期間収支集計'), fixedExpenseAmount: safeNumber(previous.fixed, '前期間固定費集計') },
      categories: categoryPoints,
      trend: { daily: dailyPoints, monthly: monthlyPoints },
      fixed: { paidAmount: safeNumber(current.fixed, '固定費集計'), daily: dailyPoints.map(({ date, fixedExpenseAmount }) => ({ date, paidAmount: fixedExpenseAmount })), monthly: monthlyPoints.map(({ month, fixedExpenseAmount }) => ({ month, paidAmount: fixedExpenseAmount })) },
      utility: { totals: utilityNumbers(utility), daily: [...daily.entries()].map(([date, value]) => utilityPoint('date', date, value.utility) as UtilityDailyPoint), monthly: [...monthly.entries()].map(([month, value]) => utilityPoint('month', month, value.utility) as UtilityMonthlyPoint) },
    }
  }
}

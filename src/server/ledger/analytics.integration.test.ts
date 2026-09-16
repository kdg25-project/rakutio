import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { analyticsRange, LedgerAnalyticsService } from './analytics'
import { LedgerError, LedgerService } from './service'

type BoundStatement = D1PreparedStatement & { execute: () => D1Result<unknown> }

function createLocalD1() {
  const sqlite = new DatabaseSync(':memory:')
  const db = {
    prepare(query: string) {
      let parameters: unknown[] = []
      const execute = () => {
        const statement = sqlite.prepare(query)
        if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return { success: true, results: statement.all(...parameters), meta: { changes: 0 } }
        const result = statement.run(...parameters)
        return { success: true, results: [], meta: { changes: Number(result.changes) } }
      }
      const prepared = {
        bind(...values: unknown[]) { parameters = values; return prepared },
        async first() { return sqlite.prepare(query).get(...parameters) ?? null },
        async all() { return { success: true, results: sqlite.prepare(query).all(...parameters), meta: { changes: 0 } } },
        async run() { return execute() },
        execute,
      }
      return prepared as unknown as BoundStatement
    },
    async batch(statements: D1PreparedStatement[]) {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((statement) => (statement as BoundStatement).execute())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
    async exec(query: string) { sqlite.exec(query); return { count: 0, duration: 0 } },
  } as unknown as D1Database
  return { db, close: () => sqlite.close() }
}

async function applyMigrations(db: D1Database) {
  for (const name of ['0000_ancient_spiral.sql', '0001_ledger_core.sql', '0002_assets.sql', '0003_planning.sql', '0004_asset_balance_bounds.sql', '0005_utility_item_kind.sql']) {
    const migration = await readFile(resolve(process.cwd(), 'drizzle', name), 'utf8')
    for (const statement of migration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) await db.exec(statement)
  }
}

async function seedUser(db: D1Database, id: string) {
  await db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)').bind(id, id, `${id}@example.test`).run()
}

describe('LedgerAnalyticsService local D1 integration', () => {
  const closers: Array<() => void> = []
  afterEach(() => { closers.splice(0).forEach((close) => close()) })

  it('uses paid item amounts for categories, fixed costs, and utility allocations across an inclusive range', async () => {
    const local = createLocalD1(); closers.push(local.close); await applyMigrations(local.db)
    await seedUser(local.db, 'alice'); await seedUser(local.db, 'bob')
    const alice = new LedgerService(local.db, 'alice'); const bob = new LedgerService(local.db, 'bob')
    const aliceCategories = await alice.listCategories(); const bobCategories = await bob.listCategories()
    const category = (name: string) => aliceCategories.find((item) => item.name === name)!
    const income = category('給与'); const food = category('食費'); const utility = category('光熱費'); const rent = category('住居費')

    await alice.createTransaction({ type: 'income', title: '今月の給与', occurredAt: '2026-09-01', items: [{ categoryId: income.id, name: '給与', originalAmount: 2_000 }] }, 'income-current')
    await alice.createTransaction({ type: 'income', title: '前月の給与', occurredAt: '2026-08-30', items: [{ categoryId: income.id, name: '給与', originalAmount: 900 }] }, 'income-previous')
    await alice.createTransaction({ type: 'expense', title: '買い物と電気代', occurredAt: '2026-09-01', items: [
      { categoryId: food.id, name: '食材', originalAmount: 300 },
      { categoryId: utility.id, name: '電気', originalAmount: 700, utilityKind: 'electricity' },
    ] }, 'mixed-expense')
    await alice.createTransaction({ type: 'expense', title: '固定費とガス', occurredAt: '2026-09-02', items: [
      { categoryId: rent.id, name: '家賃', originalAmount: 400 },
      { categoryId: utility.id, name: 'ガス', originalAmount: 200, utilityKind: 'gas' },
    ] }, 'fixed-gas')
    await alice.createTransaction({ type: 'expense', title: '水道等', occurredAt: '2026-09-03', items: [
      { categoryId: utility.id, name: '水道', originalAmount: 150, utilityKind: 'water' },
      { categoryId: utility.id, name: '共益費', originalAmount: 50 },
    ] }, 'water-other')
    await alice.createTransaction({ type: 'expense', title: '前月家賃', occurredAt: '2026-08-29', items: [{ categoryId: rent.id, name: '家賃', originalAmount: 100 }] }, 'previous-rent')
    const bobFood = bobCategories.find((item) => item.name === '食費')!
    await bob.createTransaction({ type: 'expense', title: '別ユーザー', occurredAt: '2026-09-01', items: [{ categoryId: bobFood.id, name: '他人の食費', originalAmount: 9_999 }] }, 'bob-expense')

    const analytics = await new LedgerAnalyticsService(local.db, 'alice').analytics({ from: '2026-09-01', to: '2026-09-03', categoryId: null })
    expect(analytics.range).toEqual({ from: '2026-09-01', to: '2026-09-03', previousFrom: '2026-08-29', previousTo: '2026-08-31' })
    expect(analytics.totals).toEqual({ incomeAmount: 2_000, expenseAmount: 1_800, netAmount: 200, fixedExpenseAmount: 400 })
    expect(analytics.previousTotals).toEqual({ incomeAmount: 900, expenseAmount: 100, netAmount: 800, fixedExpenseAmount: 100 })
    expect(analytics.categories.find((item) => item.name === '食費')?.paidAmount).toBe(300)
    expect(analytics.categories.find((item) => item.name === '光熱費')?.paidAmount).toBe(1_100)
    expect(analytics.utility.totals).toEqual({ electricity: 700, gas: 200, water: 150, other: 50 })
    expect(analytics.trend.daily).toEqual([
      { date: '2026-09-01', incomeAmount: 2_000, expenseAmount: 1_000, netAmount: 1_000, fixedExpenseAmount: 0 },
      { date: '2026-09-02', incomeAmount: 0, expenseAmount: 600, netAmount: -600, fixedExpenseAmount: 400 },
      { date: '2026-09-03', incomeAmount: 0, expenseAmount: 200, netAmount: -200, fixedExpenseAmount: 0 },
    ])
    expect(analytics.trend.monthly).toEqual([{ month: '2026-09', incomeAmount: 2_000, expenseAmount: 1_800, netAmount: 200, fixedExpenseAmount: 400 }])
    expect(analytics.fixed).toEqual({ paidAmount: 400, daily: [
      { date: '2026-09-01', paidAmount: 0 }, { date: '2026-09-02', paidAmount: 400 }, { date: '2026-09-03', paidAmount: 0 },
    ], monthly: [{ month: '2026-09', paidAmount: 400 }] })
    expect(analytics.utility.daily[2]).toEqual({ date: '2026-09-03', electricity: 0, gas: 0, water: 150, other: 50 })
    await alice.updateCategory(utility.id, { name: '水道光熱費' })
    const afterRename = await new LedgerAnalyticsService(local.db, 'alice').analytics({ from: '2026-09-01', to: '2026-09-03', categoryId: null })
    expect(afterRename.utility.totals).toMatchObject({ electricity: 700, gas: 200, water: 150 })
    await expect(new LedgerAnalyticsService(local.db, 'alice').analytics({ from: '2026-09-01', to: '2026-09-03', categoryId: bobFood.id })).rejects.toMatchObject({ code: 'INVALID_CATEGORY' })
  })

  it('limits expense detail to an owned selected category while keeping income scope explicit', async () => {
    const local = createLocalD1(); closers.push(local.close); await applyMigrations(local.db); await seedUser(local.db, 'alice')
    const ledger = new LedgerService(local.db, 'alice'); const categories = await ledger.listCategories()
    const food = categories.find((item) => item.name === '食費')!; const income = categories.find((item) => item.name === '給与')!; const utility = categories.find((item) => item.name === '光熱費')!
    await ledger.createTransaction({ type: 'income', title: '給与', occurredAt: '2026-09-01', items: [{ categoryId: income.id, name: '給与', originalAmount: 1_000 }] }, 'income')
    await ledger.createTransaction({ type: 'expense', title: '食費と電気', occurredAt: '2026-09-01', items: [{ categoryId: food.id, name: '食費', originalAmount: 300 }, { categoryId: utility.id, name: '電気', originalAmount: 700, utilityKind: 'electricity' }] }, 'expense')

    const analytics = await new LedgerAnalyticsService(local.db, 'alice').analytics({ from: '2026-09-01', to: '2026-09-01', categoryId: food.id })
    expect(analytics.scope).toEqual({ categoryId: food.id, incomeScope: 'all' })
    expect(analytics.totals).toEqual({ incomeAmount: 1_000, expenseAmount: 300, netAmount: 700, fixedExpenseAmount: 0 })
    expect(analytics.categories).toHaveLength(1)
    expect(analytics.categories[0]).toMatchObject({ categoryId: food.id, paidAmount: 300 })
    expect(analytics.utility.totals).toEqual({ electricity: 0, gas: 0, water: 0, other: 0 })
  })

  it('validates calendar dates, ordering, and the ten-year range limit without truncating', () => {
    expect(() => analyticsRange('2026-02-29', '2026-03-01')).toThrowError(LedgerError)
    expect(() => analyticsRange('2026-09-02', '2026-09-01')).toThrowError(LedgerError)
    expect(() => analyticsRange('2010-01-01', '2020-01-09')).toThrowError(LedgerError)
    expect(analyticsRange('2024-02-29', '2024-02-29')).toMatchObject({ previousFrom: '2024-02-28', previousTo: '2024-02-28' })
  })

  it('fails explicitly before returning an imprecise amount', async () => {
    const db = {
      prepare(query: string) {
        const prepared = {
          bind() { return prepared },
          async all() {
            if (query.includes('cash_paid_amount')) return { success: true, results: [{ occurred_at: '2026-09-01', cash_paid_amount: 9_007_199_254_740_992 }], meta: { changes: 0 } }
            return { success: true, results: [], meta: { changes: 0 } }
          },
          async first() { return null },
        }
        return prepared
      },
    } as unknown as D1Database
    await expect(new LedgerAnalyticsService(db, 'alice').analytics({ from: '2026-09-01', to: '2026-09-01', categoryId: null })).rejects.toMatchObject({ code: 'AMOUNT_RANGE_EXCEEDED' })
  })
})

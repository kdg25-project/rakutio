import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { LedgerService } from '../ledger/service'
import { PlanningError, PlanningService, runDueRecurringForUser } from './service'

type BoundStatement = D1PreparedStatement & { execute: () => D1Result<unknown> }

function createLocalD1() {
  const sqlite = new DatabaseSync(':memory:')
  const db = {
    prepare(query: string) {
      let parameters: unknown[] = []
      const execute = () => {
        const prepared = sqlite.prepare(query)
        if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return { success: true, results: prepared.all(...parameters), meta: { changes: 0 } }
        const result = prepared.run(...parameters)
        return { success: true, results: [], meta: { changes: Number(result.changes) } }
      }
      const prepared = {
        bind(...values: unknown[]) { parameters = values; return prepared },
        async first() { return sqlite.prepare(query).get(...parameters) ?? null },
        async all() { return { success: true, results: sqlite.prepare(query).all(...parameters), meta: { changes: 0 } } },
        async run() { return execute() }, execute,
      }
      return prepared as unknown as BoundStatement
    },
    async batch(statements: D1PreparedStatement[]) {
      sqlite.exec('BEGIN')
      try { const result = statements.map((entry) => (entry as BoundStatement).execute()); sqlite.exec('COMMIT'); return result } catch (error) { sqlite.exec('ROLLBACK'); throw error }
    },
    async exec(query: string) { sqlite.exec(query); return { count: 0, duration: 0 } },
  } as unknown as D1Database
  return { db, close: () => sqlite.close() }
}

async function applyMigrations(db: D1Database) {
  for (const name of ['0000_ancient_spiral.sql', '0001_ledger_core.sql', '0002_assets.sql', '0003_planning.sql', '0004_asset_balance_bounds.sql', '0005_utility_item_kind.sql', '0006_asset_cascade_delete_guard.sql']) {
    const migration = await readFile(resolve(process.cwd(), 'drizzle', name), 'utf8')
    for (const statement of migration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) await db.exec(statement)
  }
}

async function seedUser(db: D1Database, userId: string) {
  await db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)').bind(userId, userId, `${userId}@example.test`).run()
}

describe('PlanningService local D1 integration', () => {
  const closers: Array<() => void> = []
  afterEach(() => { closers.splice(0).forEach((close) => close()) })

  it('derives monthly expense budget and income-target progress from actual cash amounts', async () => {
    const local = createLocalD1(); closers.push(local.close); await applyMigrations(local.db); await seedUser(local.db, 'alice')
    const ledger = new LedgerService(local.db, 'alice'); const categories = await ledger.listCategories()
    const food = categories.find((category) => category.name === '食費')!; const salary = categories.find((category) => category.name === '給与')!
    await ledger.createTransaction({ type: 'expense', title: '買い物', occurredAt: '2026-02-03', items: [{ categoryId: food.id, name: '食品', originalAmount: 800 }], pointUsedAmount: 100 }, 'budget-expense')
    await ledger.createTransaction({ type: 'income', title: '給与', occurredAt: '2026-02-10', items: [{ categoryId: salary.id, name: '給与', originalAmount: 2_000 }] }, 'budget-income')
    const planning = new PlanningService(local.db, 'alice')
    const target = await planning.createMonthlyTarget({ month: '2026-02', expenseTargetAmount: 1_000, incomeTargetAmount: 3_000 })
    expect(target).toMatchObject({ expenseActualAmount: 700, incomeActualAmount: 2_000, expenseProgress: 0.7, incomeProgress: 2 / 3 })
    await expect(new PlanningService(local.db, 'bob').getMonthlyTarget(target.id)).resolves.toBeNull()
  })

  it('clamps month-end payment days, catches up once per rule/month, and stops future runs', async () => {
    const local = createLocalD1(); closers.push(local.close); await applyMigrations(local.db); await seedUser(local.db, 'alice')
    const ledger = new LedgerService(local.db, 'alice'); const food = (await ledger.listCategories()).find((category) => category.name === '食費')!
    const planning = new PlanningService(local.db, 'alice')
    const rule = await planning.createRecurringRule({ title: 'サブスク', amount: 980, categoryId: food.id, paymentMethod: 'cash', paymentDay: 31, startDate: '2026-01-01' })

    await expect(runDueRecurringForUser(local.db, 'alice', '2026-03-15')).resolves.toMatchObject({ created: 2, failed: 0 })
    const first = await ledger.listTransactions({})
    expect(first.transactions.map((transaction) => transaction.occurredAt).sort()).toEqual(['2026-01-31', '2026-02-28'])
    await expect(runDueRecurringForUser(local.db, 'alice', '2026-03-15')).resolves.toMatchObject({ created: 0, skipped: 0, failed: 0 })

    const january = first.transactions.find((transaction) => transaction.occurredAt === '2026-01-31')!
    await ledger.deleteTransaction(january.id, january.revision)
    expect(await local.db.prepare('SELECT transaction_id FROM planning_recurring_run WHERE rule_id = ? AND month = ?').bind(rule.id, '2026-01').first<{ transaction_id: string | null }>()).toEqual({ transaction_id: null })
    await expect(runDueRecurringForUser(local.db, 'alice', '2026-03-31')).resolves.toMatchObject({ created: 1, failed: 0 })
    expect((await ledger.listTransactions({})).transactions.map((transaction) => transaction.occurredAt).sort()).toEqual(['2026-02-28', '2026-03-31'])

    await planning.stopRecurringRule(rule.id)
    await runDueRecurringForUser(local.db, 'alice', '2026-04-30')
    expect((await ledger.listTransactions({})).transactions).toHaveLength(2)
    expect(await planning.getRecurringRule(rule.id)).toMatchObject({ active: false, generatedMonthCount: 3, lastGeneratedMonth: '2026-03' })
  })

  it('rejects invalid schedule ranges and never exposes another owner’s recurring rule', async () => {
    const local = createLocalD1(); closers.push(local.close); await applyMigrations(local.db); await seedUser(local.db, 'alice'); await seedUser(local.db, 'bob')
    const aliceLedger = new LedgerService(local.db, 'alice'); const food = (await aliceLedger.listCategories()).find((category) => category.name === '食費')!
    const alice = new PlanningService(local.db, 'alice')
    await expect(alice.createRecurringRule({ title: '不正', amount: 1, categoryId: food.id, paymentMethod: 'cash', paymentDay: 1, startDate: '2026-02-01', endDate: '2026-01-31' })).rejects.toBeInstanceOf(PlanningError)
    const rule = await alice.createRecurringRule({ title: '家賃', amount: 50_000, categoryId: food.id, paymentMethod: 'bank', paymentDay: 1, startDate: '2026-01-01' })
    await expect(new PlanningService(local.db, 'bob').updateRecurringRule(rule.id, { active: false })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(alice.createRecurringRule({ title: '口座不正', amount: 1, categoryId: food.id, paymentMethod: 'cash', accountId: 'missing', paymentDay: 1, startDate: '2026-01-01' })).rejects.toMatchObject({ code: 'INVALID_ACCOUNT' })
    await local.db.prepare("INSERT INTO asset_account (id, user_id, type, name, balance_amount, is_archived, created_at, updated_at) VALUES ('cash-a', 'alice', 'cash', '財布', 0, 0, 1, 1)").run()
    await expect(alice.createRecurringRule({ title: '口座あり', amount: 1, categoryId: food.id, paymentMethod: 'cash', accountId: 'cash-a', paymentDay: 1, startDate: '2026-01-01' })).resolves.toMatchObject({ accountId: 'cash-a' })
  })

  it('advances an old rule cursor through bounded catch-up batches without repeating completed months', async () => {
    const local = createLocalD1(); closers.push(local.close); await applyMigrations(local.db); await seedUser(local.db, 'alice')
    const ledger = new LedgerService(local.db, 'alice'); const food = (await ledger.listCategories()).find((category) => category.name === '食費')!
    const planning = new PlanningService(local.db, 'alice')
    const rule = await planning.createRecurringRule({ title: '長期', amount: 10, categoryId: food.id, paymentMethod: 'cash', paymentDay: 1, startDate: '2020-01-01' })

    let latest = { hasMore: true }
    for (let index = 0; index < 80 && latest.hasMore; index += 1) latest = await runDueRecurringForUser(local.db, 'alice', '2026-03-31')
    expect(latest.hasMore).toBe(false)
    expect(await local.db.prepare('SELECT COUNT(*) AS count FROM planning_recurring_run WHERE rule_id = ?').bind(rule.id).first<{ count: number }>()).toEqual({ count: 75 })
    expect(await local.db.prepare('SELECT next_due_month FROM planning_recurring_rule WHERE id = ?').bind(rule.id).first<{ next_due_month: string }>()).toEqual({ next_due_month: '2026-04' })
  })

  it('round-robins more than one global batch of rules and lets a failed rule yield to others', async () => {
    const local = createLocalD1(); closers.push(local.close); await applyMigrations(local.db); await seedUser(local.db, 'alice')
    const ledger = new LedgerService(local.db, 'alice'); const food = (await ledger.listCategories()).find((category) => category.name === '食費')!
    const planning = new PlanningService(local.db, 'alice')
    for (let index = 0; index < 101; index += 1) {
      await planning.createRecurringRule({ title: `一括${index}`, amount: 1, categoryId: food.id, paymentMethod: 'cash', paymentDay: 1, startDate: '2026-01-01' })
    }
    await runDueRecurringForUser(local.db, 'alice', '2026-01-01')
    await runDueRecurringForUser(local.db, 'alice', '2026-01-01')
    expect(await local.db.prepare('SELECT COUNT(*) AS count FROM planning_recurring_run').first<{ count: number }>()).toEqual({ count: 101 })

    await local.db.prepare("INSERT INTO asset_account (id, user_id, type, name, balance_amount, is_archived, created_at, updated_at) VALUES ('failing-cash', 'alice', 'cash', '失効口座', 0, 0, 1, 1)").run()
    const failed = await planning.createRecurringRule({ title: '失敗', amount: 1, categoryId: food.id, paymentMethod: 'cash', accountId: 'failing-cash', paymentDay: 1, startDate: '2026-02-01' })
    const succeeding = await planning.createRecurringRule({ title: '成功', amount: 1, categoryId: food.id, paymentMethod: 'cash', paymentDay: 1, startDate: '2026-02-01' })
    await local.db.prepare('UPDATE asset_account SET is_archived = 1 WHERE id = ?').bind('failing-cash').run()
    await local.db.prepare('UPDATE planning_recurring_rule SET last_attempted_at = 0 WHERE id = ?').bind(failed.id).run()
    await local.db.prepare('UPDATE planning_recurring_rule SET last_attempted_at = 1 WHERE id = ?').bind(succeeding.id).run()
    const result = await runDueRecurringForUser(local.db, 'alice', '2026-02-01')
    expect(result).toMatchObject({ created: expect.any(Number), failed: expect.any(Number) })
    expect(await local.db.prepare('SELECT COUNT(*) AS count FROM planning_recurring_run WHERE rule_id = ?').bind(succeeding.id).first<{ count: number }>()).toEqual({ count: 1 })
  })
})

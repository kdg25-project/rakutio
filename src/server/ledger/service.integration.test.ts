import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { LedgerError, LedgerService } from './service'

type BoundStatement = D1PreparedStatement & { execute: () => D1Result<unknown> }

/** A narrow local D1 adapter backed by Node's SQLite, including atomic batch(). */
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
  for (const name of ['0000_ancient_spiral.sql', '0001_ledger_core.sql', '0002_assets.sql', '0003_planning.sql', '0004_asset_balance_bounds.sql', '0005_utility_item_kind.sql', '0006_asset_cascade_delete_guard.sql', '0007_bank_account_details.sql']) {
    const migration = await readFile(resolve(process.cwd(), 'drizzle', name), 'utf8')
    for (const statement of migration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) await db.exec(statement)
  }
}

async function seedUser(db: D1Database, id: string) {
  await db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)').bind(id, id, `${id}@example.test`).run()
}

const expense = (categoryId: string, title = 'スーパー') => ({
  type: 'expense' as const, title, occurredAt: '2026-09-15', merchant: 'テスト商店', paymentMethod: 'cash',
  receiptDiscountAmount: 10, pointUsedAmount: 20, items: [{ categoryId, name: '牛乳', originalAmount: 100, discountAmount: 5 }, { categoryId, name: 'パン', originalAmount: 100 }],
})

const income = (categoryId: string, overrides: Record<string, unknown> = {}) => ({
  type: 'income' as const, title: '給与', occurredAt: '2026-09-15', paymentMethod: 'bank',
  items: [{ categoryId, name: '給与', originalAmount: 100 }], ...overrides,
})

describe('LedgerService local D1 integration', () => {
  const closers: Array<() => void> = []
  afterEach(() => { closers.splice(0).forEach((close) => close()) })

  it('isolates users, persists calculated totals, idempotently creates, and detects revisions', async () => {
    const local = createLocalD1(); closers.push(local.close); await applyMigrations(local.db)
    await seedUser(local.db, 'user-a'); await seedUser(local.db, 'user-b')
    const alice = new LedgerService(local.db, 'user-a'); const bob = new LedgerService(local.db, 'user-b')
    const aliceCategories = await alice.listCategories(); const bobCategories = await bob.listCategories()
    const aliceFood = aliceCategories.find((category) => category.name === '食費')!; const bobFood = bobCategories.find((category) => category.name === '食費')!
    expect(aliceFood.id).not.toBe(bobFood.id)
    await expect(alice.createTransaction(expense(bobFood.id), 'one')).rejects.toMatchObject({ code: 'INVALID_CATEGORY' })

    const first = await alice.createTransaction(expense(aliceFood.id), 'create-1')
    expect(first.idempotent).toBe(false)
    expect(first.transaction).toMatchObject({ grossAmount: 200, itemDiscountAmount: 5, receiptDiscountAmount: 10, netAmount: 185, pointUsedAmount: 20, cashPaidAmount: 165 })
    const repeated = await alice.createTransaction(expense(aliceFood.id), 'create-1')
    expect(repeated).toMatchObject({ idempotent: true, transaction: { id: first.transaction.id } })
    expect((await alice.listTransactions({ month: '2026-09' })).transactions).toHaveLength(1)

    const updated = await alice.updateTransaction(first.transaction.id, 1, { ...expense(aliceFood.id, 'スーパー更新'), pointUsedAmount: 0 })
    expect(updated).toMatchObject({ revision: 2, title: 'スーパー更新', cashPaidAmount: 185 })
    await expect(alice.updateTransaction(first.transaction.id, 1, expense(aliceFood.id))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(await bob.getTransaction(first.transaction.id)).toBeNull()
  })

  it('maps a deleted category to その他 without deleting historical items', async () => {
    const local = createLocalD1(); closers.push(local.close); await applyMigrations(local.db); await seedUser(local.db, 'user-a')
    const ledger = new LedgerService(local.db, 'user-a'); const categories = await ledger.listCategories(); const food = categories.find((category) => category.name === '食費')!
    const created = await ledger.createTransaction(expense(food.id), 'create-1')
    const result = await ledger.deleteCategory(food.id); const transaction = await ledger.getTransaction(created.transaction.id)
    const other = (await ledger.listCategories()).find((category) => category.name === 'その他')!
    expect(result.mappedToCategoryId).toBe(other.id)
    expect(transaction?.items.every((item) => item.categoryId === other.id)).toBe(true)
  })

  it('persists a utility item breakdown through category rename and remapping', async () => {
    const local = createLocalD1(); closers.push(local.close); await applyMigrations(local.db); await seedUser(local.db, 'user-a')
    const ledger = new LedgerService(local.db, 'user-a'); const categories = await ledger.listCategories()
    const utility = categories.find((category) => category.name === '光熱費')!; const food = categories.find((category) => category.name === '食費')!
    const created = await ledger.createTransaction({ type: 'expense', title: '電気代', occurredAt: '2026-09-15', items: [{ categoryId: utility.id, name: '電気', originalAmount: 1_000, utilityKind: 'electricity' }] }, 'utility-create')
    expect(created.transaction.items[0]).toMatchObject({ utilityKind: 'electricity' })
    const updated = await ledger.updateTransaction(created.transaction.id, created.transaction.revision, { type: 'expense', title: 'ガス代', occurredAt: '2026-09-15', items: [{ categoryId: utility.id, name: 'ガス', originalAmount: 1_000, utilityKind: 'gas' }] })
    expect(updated.items[0]).toMatchObject({ utilityKind: 'gas' })
    await ledger.updateCategory(utility.id, { name: '水道光熱費' })
    const renamed = await ledger.updateTransaction(updated.id, updated.revision, { type: 'expense', title: 'ガス代', occurredAt: '2026-09-15', items: [{ categoryId: utility.id, name: 'ガス', originalAmount: 1_000, utilityKind: 'gas' }] })
    expect(renamed.items[0]).toMatchObject({ utilityKind: 'gas' })
    await ledger.deleteCategory(utility.id)
    const remapped = await ledger.getTransaction(renamed.id)
    expect(remapped?.items[0]).toMatchObject({ utilityKind: 'gas' })
    const other = (await ledger.listCategories()).find((category) => category.name === 'その他')!
    await expect(ledger.updateTransaction(renamed.id, renamed.revision, { type: 'expense', title: 'ガス代', occurredAt: '2026-09-15', items: [{ categoryId: other.id, name: 'ガス', originalAmount: 1_000, utilityKind: 'gas' }] })).resolves.toMatchObject({ items: [{ utilityKind: 'gas' }] })
    await expect(ledger.createTransaction({ type: 'expense', title: '任意分類', occurredAt: '2026-09-15', items: [{ categoryId: food.id, name: '食品', originalAmount: 1, utilityKind: 'water' }] }, 'utility-nonutility')).resolves.toMatchObject({ transaction: { items: [{ utilityKind: 'water' }] } })
    await expect(ledger.createTransaction({ type: 'expense', title: '誤内訳', occurredAt: '2026-09-15', items: [{ categoryId: utility.id, name: '不正', originalAmount: 1, utilityKind: 'steam' as never }] }, 'utility-invalid')).rejects.toMatchObject({ code: 'INVALID_UTILITY_KIND' })
  })

  it('blocks a deleting receipt at both the service and D1 trigger boundaries', async () => {
    const local = createLocalD1(); closers.push(local.close); await applyMigrations(local.db); await seedUser(local.db, 'user-a')
    const ledger = new LedgerService(local.db, 'user-a'); const category = (await ledger.listCategories()).find((item) => item.name === '食費')!
    await local.db.prepare("INSERT INTO receipt (id, user_id, object_key, mime_type, byte_size, analysis_status, created_at) VALUES ('deleting-receipt', 'user-a', 'u/a/deleting', 'image/png', 1, 'deleting', 1)").run()
    await expect(ledger.createTransaction({ ...expense(category.id), receiptId: 'deleting-receipt' }, 'blocked')).rejects.toMatchObject({ code: 'RECEIPT_DELETING' })
    await expect(local.db.prepare("INSERT INTO ledger_transaction (id, user_id, receipt_id, type, occurred_at, title, gross_amount, item_discount_amount, receipt_discount_amount, discount_amount, net_amount, point_used_amount, gift_certificate_used_amount, non_cash_amount, cash_paid_amount, created_at, updated_at) VALUES ('blocked-trigger', 'user-a', 'deleting-receipt', 'expense', '2026-09-15', 'x', 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1)").run()).rejects.toThrow('receipt is deleting')
    const count = await local.db.prepare("SELECT COUNT(*) AS count FROM ledger_transaction WHERE id = 'blocked-trigger'").first<{ count: number }>()
    expect(count?.count).toBe(0)
  })

  it('keeps income as a plain amount and includes it in the monthly summary', async () => {
    const local = createLocalD1(); closers.push(local.close); await applyMigrations(local.db); await seedUser(local.db, 'user-a')
    const ledger = new LedgerService(local.db, 'user-a'); const salary = (await ledger.listCategories()).find((category) => category.name === '給与')!
    const valid = await ledger.createTransaction(income(salary.id), 'income-valid')
    expect(valid.transaction).toMatchObject({ type: 'income', grossAmount: 100, netAmount: 100, cashPaidAmount: 100, discountAmount: 0, pointUsedAmount: 0 })
    await expect(ledger.createTransaction(income(salary.id, { pointUsedAmount: 50 }), 'income-points')).rejects.toMatchObject({ code: 'INVALID_INCOME' })
    await expect(ledger.createTransaction(income(salary.id, { items: [{ categoryId: salary.id, name: '給与', originalAmount: 100, discountAmount: 50 }] }), 'income-discount')).rejects.toMatchObject({ code: 'INVALID_INCOME' })
    await expect(ledger.updateTransaction(valid.transaction.id, valid.transaction.revision, income(salary.id, { pointUsedAmount: 50 }))).rejects.toMatchObject({ code: 'INVALID_INCOME' })
    expect((await ledger.summary('2026-09')).incomeCashPaidAmount).toBe(100)
  })

  it('handles ordinary December rollover and rejects the non-representable terminal month', async () => {
    const local = createLocalD1(); closers.push(local.close); await applyMigrations(local.db); await seedUser(local.db, 'user-a')
    const ledger = new LedgerService(local.db, 'user-a'); const food = (await ledger.listCategories()).find((category) => category.name === '食費')!
    await ledger.createTransaction({ ...expense(food.id), occurredAt: '2026-12-31' }, 'december')
    expect((await ledger.listTransactions({ month: '2026-12' })).transactions).toHaveLength(1)
    await expect(ledger.summary('9999-11')).resolves.toMatchObject({ month: '9999-11' })
    await expect(ledger.listTransactions({ month: '9999-12' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(ledger.summary('9999-12')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

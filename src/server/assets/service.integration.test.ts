import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { LedgerService } from '../ledger/service'
import { AssetService } from './service'

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
      const prepared = { bind(...values: unknown[]) { parameters = values; return prepared }, async first() { return sqlite.prepare(query).get(...parameters) ?? null }, async all() { return { success: true, results: sqlite.prepare(query).all(...parameters), meta: { changes: 0 } } }, async run() { return execute() }, execute }
      return prepared as unknown as BoundStatement
    },
    async batch(statements: D1PreparedStatement[]) {
      sqlite.exec('BEGIN')
      try { const results = statements.map((statement) => (statement as BoundStatement).execute()); sqlite.exec('COMMIT'); return results }
      catch (error) { sqlite.exec('ROLLBACK'); throw error }
    },
    async exec(query: string) { sqlite.exec(query); return { count: 0, duration: 0 } },
  } as unknown as D1Database
  return { db, close: () => sqlite.close() }
}

async function migrate(db: D1Database) {
  for (const name of ['0000_ancient_spiral.sql', '0001_ledger_core.sql', '0002_assets.sql', '0003_planning.sql', '0004_asset_balance_bounds.sql', '0005_utility_item_kind.sql', '0006_asset_cascade_delete_guard.sql']) {
    const source = await readFile(resolve(process.cwd(), 'drizzle', name), 'utf8')
    for (const sql of source.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) await db.exec(sql)
  }
}
async function user(db: D1Database, id: string) { await db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)').bind(id, id, `${id}@example.test`).run() }

describe('assets and ledger local D1 integration', () => {
  const closers: Array<() => void> = []
  afterEach(() => closers.splice(0).forEach((close) => close()))

  it('keeps opening, adjustment, and transfers idempotent while preserving total assets', async () => {
    const local = createLocalD1(); closers.push(local.close); await migrate(local.db); await user(local.db, 'a'); await user(local.db, 'b')
    const assets = new AssetService(local.db, 'a'); const otherUser = new AssetService(local.db, 'b')
    const bank = await assets.createAccount({ type: 'bank', name: 'メイン銀行', initialBalanceAmount: 1_000, idempotencyKey: 'bank-open' })
    const openingDateParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(bank.account.createdAt))
    const openingPart = (type: Intl.DateTimeFormatPartTypes) => openingDateParts.find((part) => part.type === type)?.value
    expect(bank.entries[0]?.occurredAt).toBe(`${openingPart('year')}-${openingPart('month')}-${openingPart('day')}`)
    const cash = await assets.createAccount({ type: 'cash', name: '財布', initialBalanceAmount: 200, idempotencyKey: 'cash-open' })
    const gift = await assets.createAccount({ type: 'gift', name: '商品券', initialBalanceAmount: 100, idempotencyKey: 'gift-open' })
    const replay = await assets.createAccount({ type: 'bank', name: '別名', initialBalanceAmount: 999, idempotencyKey: 'bank-open' })
    expect(replay).toMatchObject({ idempotent: true, account: { id: bank.account.id, balanceAmount: 1_000 } })
    await expect(assets.transfer({ fromAccountId: bank.account.id, toAccountId: cash.account.id, amount: 1, occurredAt: '2026-09-16', idempotencyKey: 'bank-open' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    const transferred = await assets.transfer({ fromAccountId: bank.account.id, toAccountId: gift.account.id, amount: 100, occurredAt: '2026-09-16', idempotencyKey: 'gift-purchase' })
    expect(transferred.entries.map((entry) => entry.amount).sort()).toEqual([-100, 100])
    await expect(assets.transfer({ fromAccountId: bank.account.id, toAccountId: gift.account.id, amount: 100, occurredAt: '2026-09-16', idempotencyKey: 'gift-purchase' })).resolves.toMatchObject({ idempotent: true })
    await expect(assets.adjustAccount(gift.account.id, { amount: -201, occurredAt: '2026-09-16', idempotencyKey: 'gift-overdraw' })).rejects.toMatchObject({ code: 'INSUFFICIENT_GIFT_BALANCE' })
    const summary = await assets.listAccounts()
    expect(summary).toMatchObject({ totalAmount: 1_300, activeTotalAmount: 1_300 })
    expect(summary.accounts.find((account) => account.id === bank.account.id)?.balanceAmount).toBe(900)
    expect(summary.accounts.find((account) => account.id === gift.account.id)?.balanceAmount).toBe(200)
    await expect(otherUser.listEntries(bank.account.id)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' })
    await assets.adjustAccount(cash.account.id, { amount: 1, occurredAt: '2026-09-16', idempotencyKey: 'cash-adjustment' })
    await assets.updateAccount(cash.account.id, { isArchived: true })
    await expect(assets.adjustAccount(cash.account.id, { amount: 1, occurredAt: '2026-09-16', idempotencyKey: 'cash-adjustment' })).resolves.toMatchObject({ idempotent: true })
    await expect(assets.adjustAccount(cash.account.id, { amount: 1, occurredAt: '2026-09-16', idempotencyKey: 'archived' })).rejects.toMatchObject({ code: 'ACCOUNT_ARCHIVED' })

    const history = await assets.createAccount({ type: 'cash', name: '履歴用', initialBalanceAmount: 0, idempotencyKey: 'history-open' })
    await assets.adjustAccount(history.account.id, { amount: 10, occurredAt: '2026-01-03', idempotencyKey: 'history-plus' })
    await assets.adjustAccount(history.account.id, { amount: -3, occurredAt: '2026-01-05', idempotencyKey: 'history-minus' })
    await expect(assets.balanceHistory({ from: '2026-01-03', to: '2026-01-05' })).resolves.toEqual({
      openingBalanceAmount: 0,
      closingBalanceAmount: 7,
      history: [
        { date: '2026-01-03', deltaAmount: 10, balanceAmount: 10 },
        { date: '2026-01-05', deltaAmount: -3, balanceAmount: 7 },
      ],
    })
    const carried = await otherUser.createAccount({ type: 'cash', name: '持越確認用', initialBalanceAmount: 0, idempotencyKey: 'carried-open' })
    await otherUser.adjustAccount(carried.account.id, { amount: 9, occurredAt: '2026-01-04', idempotencyKey: 'carried-adjustment' })
    await expect(otherUser.balanceHistory({ from: '2026-01-05', to: '2026-12-31' })).resolves.toEqual({
      openingBalanceAmount: 9,
      closingBalanceAmount: 9,
      history: [],
    })
    await expect(assets.updateAccount(cash.account.id, { isArchived: false })).resolves.toMatchObject({ id: cash.account.id, isArchived: false })
  })

  it('reverses account effects on transaction update/delete and prevents gift double spending', async () => {
    const local = createLocalD1(); closers.push(local.close); await migrate(local.db); await user(local.db, 'a')
    const assets = new AssetService(local.db, 'a'); const ledger = new LedgerService(local.db, 'a')
    const bank = await assets.createAccount({ type: 'bank', name: '銀行', initialBalanceAmount: 1_000, idempotencyKey: 'bank' })
    const gift = await assets.createAccount({ type: 'gift', name: 'ギフト', initialBalanceAmount: 100, idempotencyKey: 'gift' })
    const categories = await ledger.listCategories(); const food = categories.find((category) => category.name === '食費')!; const salary = categories.find((category) => category.name === '給与')!
    const expense = (giftAmount: number, title = '買い物') => ({ type: 'expense' as const, title, occurredAt: '2026-09-16', accountId: bank.account.id, giftAccountId: gift.account.id, giftCertificateUsedAmount: giftAmount, items: [{ categoryId: food.id, name: '購入品', originalAmount: 100 }] })
    const created = await ledger.createTransaction(expense(40), 'expense-1')
    let summary = await assets.listAccounts(); expect(summary.accounts.find((account) => account.id === bank.account.id)?.balanceAmount).toBe(940); expect(summary.accounts.find((account) => account.id === gift.account.id)?.balanceAmount).toBe(60)
    expect(await ledger.summary('2026-09')).toMatchObject({ assetTotalAmount: 1_000, assetActiveTotalAmount: 1_000 })
    const updated = await ledger.updateTransaction(created.transaction.id, created.transaction.revision, expense(20, '買い物更新'))
    summary = await assets.listAccounts(); expect(summary.accounts.find((account) => account.id === bank.account.id)?.balanceAmount).toBe(920); expect(summary.accounts.find((account) => account.id === gift.account.id)?.balanceAmount).toBe(80)
    await ledger.deleteTransaction(updated.id, updated.revision)
    summary = await assets.listAccounts(); expect(summary.accounts.find((account) => account.id === bank.account.id)?.balanceAmount).toBe(1_000); expect(summary.accounts.find((account) => account.id === gift.account.id)?.balanceAmount).toBe(100)
    await ledger.createTransaction({ type: 'income', title: '給与', occurredAt: '2026-09-16', accountId: bank.account.id, items: [{ categoryId: salary.id, name: '給与', originalAmount: 100 }] }, 'income')
    expect((await assets.listAccounts()).accounts.find((account) => account.id === bank.account.id)?.balanceAmount).toBe(1_100)
    expect((await ledger.summary('2026-09')).monthlyTrend.at(-1)).toMatchObject({ month: '2026-09', incomeCashPaidAmount: 100 })
    const costly = (key: string) => ledger.createTransaction({ type: 'expense', title: key, occurredAt: '2026-09-17', giftAccountId: gift.account.id, giftCertificateUsedAmount: 80, items: [{ categoryId: food.id, name: key, originalAmount: 80 }] }, key)
    const results = await Promise.allSettled([costly('gift-one'), costly('gift-two')])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect((await assets.listAccounts()).accounts.find((account) => account.id === gift.account.id)?.balanceAmount).toBe(20)
  })

  it('rejects balance and aggregate limits atomically without consuming a replay key', async () => {
    const local = createLocalD1(); closers.push(local.close); await migrate(local.db); await user(local.db, 'a'); await user(local.db, 'b'); await user(local.db, 'c')
    const assets = new AssetService(local.db, 'a'); const ledger = new LedgerService(local.db, 'b'); const limit = 1_000_000_000_000
    const bank = await assets.createAccount({ type: 'bank', name: '上限口座', initialBalanceAmount: limit - 1, idempotencyKey: 'limit-opening' })
    await expect(assets.adjustAccount(bank.account.id, { amount: 2, occurredAt: '2026-09-16', idempotencyKey: 'limit-adjustment' })).rejects.toMatchObject({ code: 'ASSET_BALANCE_LIMIT_EXCEEDED' })
    expect((await assets.listAccounts()).accounts[0]?.balanceAmount).toBe(limit - 1)
    await expect(assets.adjustAccount(bank.account.id, { amount: 1, occurredAt: '2026-09-16', idempotencyKey: 'limit-adjustment' })).resolves.toMatchObject({ idempotent: false })
    const cash = await assets.createAccount({ type: 'cash', name: '受取口座', initialBalanceAmount: 0, idempotencyKey: 'receiver-opening' })
    await expect(assets.transfer({ fromAccountId: bank.account.id, toAccountId: cash.account.id, amount: 1, occurredAt: '2026-09-16', idempotencyKey: 'boundary-transfer' })).resolves.toMatchObject({ idempotent: false })
    await expect(assets.adjustAccount(cash.account.id, { amount: 1, occurredAt: '2026-09-16', idempotencyKey: 'aggregate-overflow' })).rejects.toMatchObject({ code: 'ASSET_BALANCE_LIMIT_EXCEEDED' })
    expect((await assets.listAccounts()).totalAmount).toBe(limit)

    const deleteAssets = new AssetService(local.db, 'c'); const opening = await deleteAssets.createAccount({ type: 'bank', name: '削除境界', initialBalanceAmount: limit, idempotencyKey: 'delete-opening' })
    await deleteAssets.adjustAccount(opening.account.id, { amount: -limit, occurredAt: '2026-09-16', idempotencyKey: 'delete-zero' })
    await deleteAssets.adjustAccount(opening.account.id, { amount: -limit, occurredAt: '2026-09-16', idempotencyKey: 'delete-negative' })
    const openingEntry = (await deleteAssets.listEntries(opening.account.id)).find((entry) => entry.kind === 'opening')!
    await expect(local.db.prepare('DELETE FROM asset_entry WHERE id = ?').bind(openingEntry.id).run()).rejects.toThrow(/asset balance out of range/)
    expect((await deleteAssets.listAccounts()).accounts.find((account) => account.id === opening.account.id)?.balanceAmount).toBe(-limit)
    await expect(local.db.prepare("DELETE FROM user WHERE id = 'c'").run()).resolves.toMatchObject({ meta: { changes: 1 } })

    const maxIncomeAccount = await new AssetService(local.db, 'b').createAccount({ type: 'bank', name: '収入境界', initialBalanceAmount: limit - 1, idempotencyKey: 'income-opening' })
    const salary = (await ledger.listCategories()).find((category) => category.name === '給与')!
    const income = await ledger.createTransaction({ type: 'income', title: '上限収入', occurredAt: '2026-09-16', accountId: maxIncomeAccount.account.id, items: [{ categoryId: salary.id, name: '給与', originalAmount: 1 }] }, 'income-boundary')
    await expect(ledger.updateTransaction(income.transaction.id, income.transaction.revision, { type: 'income', title: '上限超過収入', occurredAt: '2026-09-16', accountId: maxIncomeAccount.account.id, items: [{ categoryId: salary.id, name: '給与', originalAmount: 2 }] })).rejects.toMatchObject({ code: 'ASSET_BALANCE_LIMIT_EXCEEDED' })
    expect((await ledger.getTransaction(income.transaction.id))?.revision).toBe(1)
    expect((await new AssetService(local.db, 'b').listAccounts()).accounts[0]?.balanceAmount).toBe(limit)
  })

  it('returns controlled aggregate errors for legacy out-of-range asset rows', async () => {
    const local = createLocalD1(); closers.push(local.close); await migrate(local.db); await user(local.db, 'a')
    const assets = new AssetService(local.db, 'a'); const limit = 1_000_000_000_000
    await local.db.exec('DROP TRIGGER asset_account_insert_balance_guard')
    await local.db.prepare("INSERT INTO asset_account (id, user_id, type, name, balance_amount, is_archived, created_at, updated_at) VALUES ('legacy-one', 'a', 'cash', '旧口座1', ?, 0, 1, 1)").bind(limit).run()
    await local.db.prepare("INSERT INTO asset_account (id, user_id, type, name, balance_amount, is_archived, created_at, updated_at) VALUES ('legacy-two', 'a', 'cash', '旧口座2', ?, 0, 1, 1)").bind(limit).run()
    await expect(assets.listAccounts()).rejects.toMatchObject({ code: 'UNSAFE_ASSET_AGGREGATE' })

    await local.db.exec('DROP TRIGGER asset_entry_bounds_insert_guard; DROP TRIGGER asset_entry_balance_apply')
    await local.db.prepare("INSERT INTO asset_entry (id, user_id, account_id, kind, amount, occurred_at, memo, created_at) VALUES ('legacy-entry-1', 'a', 'legacy-one', 'adjustment', ?, '2026-01-01', '', 1)").bind(limit).run()
    await local.db.prepare("INSERT INTO asset_entry (id, user_id, account_id, kind, amount, occurred_at, memo, created_at) VALUES ('legacy-entry-2', 'a', 'legacy-one', 'adjustment', ?, '2026-01-01', '', 1)").bind(limit).run()
    await expect(assets.balanceHistory({ from: '2026-01-01', to: '2026-01-01' })).rejects.toMatchObject({ code: 'UNSAFE_ASSET_AGGREGATE' })
  })
})

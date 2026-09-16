import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { MAX_PROFILE_IMAGE_BYTES, ProfileService } from './service'

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
  for (const name of ['0000_ancient_spiral.sql', '0001_ledger_core.sql', '0002_assets.sql', '0003_planning.sql', '0004_asset_balance_bounds.sql', '0005_utility_item_kind.sql', '0006_asset_cascade_delete_guard.sql', '0007_bank_account_details.sql', '0008_user_profile_preferences.sql']) {
    const source = await readFile(resolve(process.cwd(), 'drizzle', name), 'utf8')
    for (const sql of source.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) await db.exec(sql)
  }
}

async function seedUser(db: D1Database, id: string) {
  await db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)').bind(id, id, `${id}@example.test`).run()
}

describe('ProfileService local D1 integration', () => {
  const closers: Array<() => void> = []
  afterEach(() => closers.splice(0).forEach((close) => close()))

  it('persists only the authenticated user profile and leaves the other user unchanged', async () => {
    const local = createLocalD1(); closers.push(local.close); await migrate(local.db); await seedUser(local.db, 'user-a'); await seedUser(local.db, 'user-b')
    const alice = new ProfileService(local.db, 'user-a'); const bob = new ProfileService(local.db, 'user-b')
    expect(await alice.get()).toEqual({ name: 'user-a', theme: 'sage', memo: '', image: null })

    const avatar = 'data:image/png;base64,AAAA'
    await expect(alice.update({ name: '山田 花子', theme: 'rose', memo: '生活費を確認する', image: avatar })).resolves.toEqual({ name: '山田 花子', theme: 'rose', memo: '生活費を確認する', image: avatar })
    await expect(alice.update({ theme: 'peach' })).resolves.toMatchObject({ theme: 'peach' })
    expect(await bob.get()).toEqual({ name: 'user-b', theme: 'sage', memo: '', image: null })
    await expect(bob.update({ memo: '別のメモ' })).resolves.toMatchObject({ memo: '別のメモ' })
    expect(await alice.get()).toMatchObject({ name: '山田 花子', theme: 'peach', memo: '生活費を確認する', image: avatar })
    await expect(alice.update({ image: null })).resolves.toMatchObject({ image: null })
  })

  it('rejects malformed updates and over-sized or non-raster data URLs', async () => {
    const local = createLocalD1(); closers.push(local.close); await migrate(local.db); await seedUser(local.db, 'user-a')
    const profile = new ProfileService(local.db, 'user-a')
    await expect(profile.update({})).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(profile.update({ name: ' ' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(profile.update({ theme: 'green' })).rejects.toMatchObject({ code: 'INVALID_THEME' })
    await expect(profile.update({ memo: 'あ'.repeat(501) })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(profile.update({ image: 'data:image/svg+xml;base64,PHN2Zy8+' })).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    await expect(profile.update({ image: 'https://example.test/avatar.png' })).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    const tooLarge = `data:image/png;base64,${'A'.repeat(Math.ceil((MAX_PROFILE_IMAGE_BYTES + 1) / 3) * 4)}`
    await expect(profile.update({ image: tooLarge })).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
  })
})

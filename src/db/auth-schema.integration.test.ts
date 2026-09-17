import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'

import { user as authUser } from './auth-schema'
import { user as productUser } from './schema'

type BoundStatement = D1PreparedStatement & { execute: () => D1Result<unknown> }

function createLocalD1() {
  const sqlite = new DatabaseSync(':memory:')
  const db = {
    prepare(query: string) {
      let parameters: unknown[] = []
      const prepared = {
        bind(...values: unknown[]) { parameters = values; return prepared },
        async first() { return sqlite.prepare(query).get(...parameters) ?? null },
        async all() { return { success: true, results: sqlite.prepare(query).all(...parameters), meta: { changes: 0 } } },
        async raw() { return sqlite.prepare(query).all(...parameters).map((row) => Object.values(row as Record<string, unknown>)) },
        async run() { const result = sqlite.prepare(query).run(...parameters); return { success: true, results: [], meta: { changes: Number(result.changes) } } },
        execute() { const result = sqlite.prepare(query).run(...parameters); return { success: true, results: [], meta: { changes: Number(result.changes) } } },
      }
      return prepared as unknown as BoundStatement
    },
    async batch() { throw new Error('not used by this test') },
    async exec(query: string) { sqlite.exec(query); return { count: 0, duration: 0 } },
  } as unknown as D1Database
  return { db, close: () => sqlite.close() }
}

describe('Better Auth schema compatibility', () => {
  const closers: Array<() => void> = []
  afterEach(() => closers.splice(0).forEach((close) => close()))

  it('can insert and return a canonical user before the profile-preferences migration', async () => {
    const local = createLocalD1(); closers.push(local.close)
    const migration = await readFile(resolve(process.cwd(), 'drizzle/0000_ancient_spiral.sql'), 'utf8')
    for (const statement of migration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) await local.db.exec(statement)

    const database = drizzle(local.db)
    await expect(database.insert(authUser).values({
      id: 'auth-user', name: '認証ユーザー', email: 'auth@example.test', emailVerified: false,
      createdAt: new Date(1), updatedAt: new Date(1),
    }).returning()).resolves.toEqual([expect.objectContaining({ id: 'auth-user', email: 'auth@example.test' })])

    expect(Object.keys(authUser)).not.toContain('theme')
    expect(Object.keys(authUser)).not.toContain('memo')
    expect(Object.keys(productUser)).toEqual(expect.arrayContaining(['theme', 'memo']))
  })
})

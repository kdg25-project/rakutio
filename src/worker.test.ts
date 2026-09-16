import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ runDueRecurring: vi.fn() }))

vi.mock('./server/planning/service', () => ({ runDueRecurring: mocks.runDueRecurring }))

import worker, { runScheduledRecurring } from './worker'

describe('scheduled recurring worker', () => {
  it('runs bounded recurring work and logs aggregate counts without account or user data', async () => {
    mocks.runDueRecurring.mockResolvedValueOnce({ created: 2, skipped: 3, failed: 0, processedRules: 4, hasMore: true })
    const logger = { info: vi.fn(), error: vi.fn() }

    await expect(runScheduledRecurring({} as D1Database, new Date('2026-01-01T00:00:00.000Z'), logger)).resolves.toMatchObject({ created: 2, hasMore: true })
    expect(mocks.runDueRecurring).toHaveBeenCalledWith(expect.anything(), expect.any(Date))
    expect(logger.info).toHaveBeenCalledWith('Recurring rules processed', { created: 2, skipped: 3, failed: 0, processedRules: 4, hasMore: true })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('reports a generic failure without logging thrown details', async () => {
    mocks.runDueRecurring.mockRejectedValueOnce(new Error('sensitive upstream detail'))
    const logger = { info: vi.fn(), error: vi.fn() }

    await expect(runScheduledRecurring({} as D1Database, new Date(), logger)).rejects.toThrow('sensitive upstream detail')
    expect(logger.error).toHaveBeenCalledWith('Recurring rules processing failed')
  })

  it('registers the cron work with waitUntil on the Worker scheduled handler', async () => {
    mocks.runDueRecurring.mockResolvedValueOnce({ created: 0, skipped: 0, failed: 0, processedRules: 0, hasMore: false })
    const pending: Promise<unknown>[] = []
    const scheduled = (worker as unknown as { scheduled: (controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) => void }).scheduled

    scheduled({ cron: '5 15 * * *', scheduledTime: 0, noRetry: vi.fn() }, { DB: {} as D1Database } as Cloudflare.Env, { waitUntil: (promise) => { pending.push(promise) }, passThroughOnException: vi.fn() })
    await Promise.all(pending)
    expect(mocks.runDueRecurring).toHaveBeenCalledWith(expect.anything(), expect.any(Date))
  })
})

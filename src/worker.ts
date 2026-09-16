import startHandler from '@tanstack/react-start/server-entry'

import { runDueRecurring } from './server/planning/service'

type ScheduleLogger = Pick<Console, 'info' | 'error'>

/** Runs bounded catch-up work and logs aggregate counts only. */
export async function runScheduledRecurring(db: D1Database, date = new Date(), logger: ScheduleLogger = console) {
  try {
    const result = await runDueRecurring(db, date)
    logger.info('Recurring rules processed', {
      created: result.created,
      skipped: result.skipped,
      failed: result.failed,
      processedRules: result.processedRules,
      hasMore: result.hasMore,
    })
    return result
  } catch (error) {
    logger.error('Recurring rules processing failed')
    throw error
  }
}

export default {
  fetch(request) {
    return startHandler.fetch(request)
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduledRecurring(env.DB))
  },
} satisfies ExportedHandler<Cloudflare.Env>

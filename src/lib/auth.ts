import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { betterAuth } from 'better-auth'
import { drizzle } from 'drizzle-orm/d1'
import { env } from 'cloudflare:workers'

import { authSchema } from '../db/auth-schema'

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(drizzle(env.DB, { schema: authSchema }), {
    provider: 'sqlite',
    schema: authSchema,
    camelCase: true,
    // D1's batch API does not provide interactive transactions.
    transaction: false,
  }),
  emailAndPassword: {
    enabled: true,
  },
})

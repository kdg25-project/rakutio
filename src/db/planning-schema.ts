import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

import { ledgerCategory, ledgerTransaction, user } from './schema'

/** Planning tables are exported separately until the core schema integrates them. */
export const planningMonthlyTarget = sqliteTable('planning_monthly_target', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  month: text('month').notNull(),
  expenseTargetAmount: integer('expense_target_amount').notNull(),
  incomeTargetAmount: integer('income_target_amount').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [uniqueIndex('planning_monthly_target_user_month_unique').on(table.userId, table.month)])

export const planningRecurringRule = sqliteTable('planning_recurring_rule', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  amount: integer('amount').notNull(),
  categoryId: text('category_id').notNull().references(() => ledgerCategory.id, { onDelete: 'restrict' }),
  paymentMethod: text('payment_method').notNull(),
  accountId: text('account_id'),
  paymentDay: integer('payment_day').notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  /** First month still eligible for generation; only completed months advance it. */
  nextDueMonth: text('next_due_month').notNull(),
  /** Fair global queue order. Every selected rule moves to a unique later slot. */
  lastAttemptedAt: integer('last_attempted_at').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [index('planning_recurring_rule_user_active_idx').on(table.userId, table.active)])

export const planningRecurringRun = sqliteTable('planning_recurring_run', {
  ruleId: text('rule_id').notNull().references(() => planningRecurringRule.id, { onDelete: 'restrict' }),
  month: text('month').notNull(),
  /** A null ID is a permanent run tombstone after a user deletes its transaction. */
  transactionId: text('transaction_id').references(() => ledgerTransaction.id, { onDelete: 'set null' }),
  createdAt: integer('created_at').notNull(),
}, (table) => [primaryKey({ columns: [table.ruleId, table.month] }), index('planning_recurring_run_transaction_idx').on(table.transactionId)])

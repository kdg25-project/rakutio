import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Better Auth's canonical table names and field names. Keep this schema as the
// source of truth and create future product tables in separate modules.
export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull(),
  image: text('image'),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
})

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: integer('accessTokenExpiresAt', { mode: 'timestamp' }),
  refreshTokenExpiresAt: integer('refreshTokenExpiresAt', { mode: 'timestamp' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
})

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
  createdAt: integer('createdAt'),
  updatedAt: integer('updatedAt'),
})

/**
 * A receipt object belongs to exactly one account.  The file itself lives in
 * R2; this table intentionally stores only its private object key and the
 * normalized analysis result needed to re-open an already processed receipt.
 */
export const receipt = sqliteTable('receipt', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  objectKey: text('object_key').notNull().unique(),
  mimeType: text('mime_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  analysisStatus: text('analysis_status', { enum: ['pending', 'analyzed', 'failed', 'deleting'] }).notNull().default('pending'),
  analysisJson: text('analysis_json'),
  createdAt: integer('created_at').notNull(),
  analyzedAt: integer('analyzed_at'),
}, (table) => [index('receipt_user_created_idx').on(table.userId, table.createdAt)])

export const ledgerCategory = sqliteTable('ledger_category', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull(),
  icon: text('icon').notNull(),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [
  uniqueIndex('ledger_category_user_name_unique').on(table.userId, table.name),
  index('ledger_category_user_created_idx').on(table.userId, table.createdAt),
])

export const ledgerTransaction = sqliteTable('ledger_transaction', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  receiptId: text('receipt_id').references(() => receipt.id, { onDelete: 'set null' }),
  accountId: text('account_id'),
  giftAccountId: text('gift_account_id'),
  type: text('type', { enum: ['expense', 'income'] }).notNull(),
  occurredAt: text('occurred_at').notNull(),
  title: text('title').notNull(),
  merchant: text('merchant').notNull().default(''),
  merchantNormalized: text('merchant_normalized').notNull().default(''),
  memo: text('memo').notNull().default(''),
  paymentMethod: text('payment_method').notNull().default('cash'),
  grossAmount: integer('gross_amount').notNull(),
  itemDiscountAmount: integer('item_discount_amount').notNull(),
  receiptDiscountAmount: integer('receipt_discount_amount').notNull(),
  discountAmount: integer('discount_amount').notNull(),
  netAmount: integer('net_amount').notNull(),
  pointUsedAmount: integer('point_used_amount').notNull(),
  giftCertificateUsedAmount: integer('gift_certificate_used_amount').notNull(),
  nonCashAmount: integer('non_cash_amount').notNull(),
  cashPaidAmount: integer('cash_paid_amount').notNull(),
  revision: integer('revision').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [
  index('ledger_transaction_user_date_idx').on(table.userId, table.occurredAt),
  index('ledger_transaction_duplicate_idx').on(table.userId, table.occurredAt, table.merchantNormalized, table.netAmount),
  index('ledger_transaction_receipt_idx').on(table.userId, table.receiptId),
  uniqueIndex('ledger_transaction_receipt_unique').on(table.receiptId),
])

export const ledgerTransactionItem = sqliteTable('ledger_transaction_item', {
  id: text('id').primaryKey(),
  transactionId: text('transaction_id').notNull().references(() => ledgerTransaction.id, { onDelete: 'cascade' }),
  categoryId: text('category_id').notNull().references(() => ledgerCategory.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  originalAmount: integer('original_amount').notNull(),
  itemDiscountAmount: integer('item_discount_amount').notNull(),
  allocatedReceiptDiscountAmount: integer('allocated_receipt_discount_amount').notNull(),
  finalAmount: integer('final_amount').notNull(),
  allocatedPointAmount: integer('allocated_point_amount').notNull(),
  allocatedGiftCertificateAmount: integer('allocated_gift_certificate_amount').notNull(),
  paidAmount: integer('paid_amount').notNull(),
  utilityKind: text('utility_kind', { enum: ['electricity', 'gas', 'water', 'other'] }),
  sortOrder: integer('sort_order').notNull(),
}, (table) => [
  index('ledger_transaction_item_transaction_idx').on(table.transactionId, table.sortOrder),
  index('ledger_transaction_item_category_idx').on(table.categoryId),
])

/** A successful POST reserves this key and points to its sole transaction. */
export const ledgerIdempotency = sqliteTable('ledger_idempotency', {
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  transactionId: text('transaction_id').notNull().references(() => ledgerTransaction.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
}, (table) => [uniqueIndex('ledger_idempotency_user_key_unique').on(table.userId, table.key)])

/** User-managed cash, bank, and gift-certificate balances. */
export const assetAccount = sqliteTable('asset_account', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  type: text('type', { enum: ['bank', 'cash', 'gift'] }).notNull(),
  name: text('name').notNull(),
  balanceAmount: integer('balance_amount').notNull().default(0),
  isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [
  index('asset_account_user_active_idx').on(table.userId, table.isArchived, table.createdAt),
  uniqueIndex('asset_account_user_name_unique').on(table.userId, table.name),
])

export const assetOperation = sqliteTable('asset_operation', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('account_id').references(() => assetAccount.id, { onDelete: 'restrict' }),
  key: text('key').notNull(),
  kind: text('kind', { enum: ['opening', 'adjustment', 'transfer'] }).notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [uniqueIndex('asset_operation_user_key_unique').on(table.userId, table.key)])

export const assetEntry = sqliteTable('asset_entry', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull().references(() => assetAccount.id, { onDelete: 'restrict' }),
  operationId: text('operation_id').references(() => assetOperation.id, { onDelete: 'cascade' }),
  transactionId: text('transaction_id').references(() => ledgerTransaction.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['opening', 'adjustment', 'transfer', 'transaction'] }).notNull(),
  amount: integer('amount').notNull(),
  occurredAt: text('occurred_at').notNull(),
  memo: text('memo').notNull().default(''),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('asset_entry_account_date_idx').on(table.accountId, table.occurredAt, table.createdAt),
  index('asset_entry_user_created_idx').on(table.userId, table.createdAt),
  uniqueIndex('asset_entry_transaction_account_unique').on(table.transactionId, table.accountId),
])

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
  // The scheduler advances this durable cursor only after a month is settled.
  nextDueMonth: text('next_due_month').notNull(),
  lastAttemptedAt: integer('last_attempted_at').notNull().default(0),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [index('planning_recurring_rule_user_active_idx').on(table.userId, table.active)])

export const planningRecurringRun = sqliteTable('planning_recurring_run', {
  ruleId: text('rule_id').notNull().references(() => planningRecurringRule.id, { onDelete: 'restrict' }),
  month: text('month').notNull(),
  transactionId: text('transaction_id').references(() => ledgerTransaction.id, { onDelete: 'set null' }),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  uniqueIndex('planning_recurring_run_rule_month_unique').on(table.ruleId, table.month),
  index('planning_recurring_run_transaction_idx').on(table.transactionId),
])

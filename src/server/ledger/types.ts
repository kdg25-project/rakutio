/** Public, transport-safe models shared by API handlers and the application UI. */
export type LedgerTransactionType = 'expense' | 'income'

export type LedgerCategory = {
  id: string
  name: string
  color: string
  icon: string
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

export type LedgerTransactionItem = {
  id: string
  categoryId: string
  name: string
  originalAmount: number
  itemDiscountAmount: number
  allocatedReceiptDiscountAmount: number
  finalAmount: number
  allocatedPointAmount: number
  allocatedGiftCertificateAmount: number
  paidAmount: number
  sortOrder: number
}

export type LedgerTransaction = {
  id: string
  receiptId: string | null
  accountId: string | null
  giftAccountId: string | null
  type: LedgerTransactionType
  occurredAt: string
  title: string
  merchant: string
  memo: string
  paymentMethod: string
  grossAmount: number
  itemDiscountAmount: number
  receiptDiscountAmount: number
  discountAmount: number
  netAmount: number
  pointUsedAmount: number
  giftCertificateUsedAmount: number
  nonCashAmount: number
  cashPaidAmount: number
  revision: number
  createdAt: number
  updatedAt: number
  items: LedgerTransactionItem[]
}

export type LedgerTransactionInput = {
  receiptId?: string | null
  accountId?: string | null
  giftAccountId?: string | null
  type: LedgerTransactionType
  occurredAt: string
  title: string
  merchant?: string
  memo?: string
  paymentMethod?: string
  receiptDiscountAmount?: number
  pointUsedAmount?: number
  giftCertificateUsedAmount?: number
  items: Array<{
    id?: string
    categoryId: string
    name: string
    originalAmount: number
    discountAmount?: number
  }>
}

export type LedgerTransactionFilter = {
  month?: string
  from?: string
  to?: string
  categoryId?: string
  type?: LedgerTransactionType
  merchant?: string
  minAmount?: number
  maxAmount?: number
  cursor?: string
  limit?: number
}

export type LedgerCategorySummary = LedgerCategory & { cashPaidAmount: number; transactionCount: number }
export type LedgerTrendPoint = { date: string; cashPaidAmount: number }
export type LedgerMonthlyTrendPoint = { month: string; incomeCashPaidAmount: number; expenseCashPaidAmount: number; fixedExpenseCashPaidAmount: number; utilityCashPaidAmount: number }
export type LedgerSummary = {
  month: string
  expenseCashPaidAmount: number
  incomeCashPaidAmount: number
  previousExpenseCashPaidAmount: number
  expenseChangeAmount: number
  assetTotalAmount: number
  assetActiveTotalAmount: number
  categories: LedgerCategorySummary[]
  trend: LedgerTrendPoint[]
  monthlyTrend: LedgerMonthlyTrendPoint[]
}

export type DuplicateReceiptMatch = {
  transaction: LedgerTransaction
  matchingItemCount: number
  sameItems: boolean
}

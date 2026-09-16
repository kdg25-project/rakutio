import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { LedgerSummary, LedgerTransaction } from '../server/ledger/types'
import { dismissOverlayPage, HomeScreen, receiptRetryUrl, summaryForMonth, transactionsForMonth } from './ledger-app'

const summary = (month: string): LedgerSummary => ({
  month,
  expenseCashPaidAmount: 1200,
  incomeCashPaidAmount: 5000,
  previousExpenseCashPaidAmount: 0,
  expenseChangeAmount: 1200,
  assetTotalAmount: 9000,
  assetActiveTotalAmount: 9000,
  categories: [],
  trend: [],
  monthlyTrend: [],
})

const transaction = (id: string, occurredAt: string): LedgerTransaction => ({
  id,
  receiptId: null,
  accountId: null,
  giftAccountId: null,
  type: 'expense',
  occurredAt,
  title: 'テスト明細',
  merchant: '',
  memo: '',
  paymentMethod: 'cash',
  grossAmount: 100,
  itemDiscountAmount: 0,
  receiptDiscountAmount: 0,
  discountAmount: 0,
  netAmount: 100,
  pointUsedAmount: 0,
  giftCertificateUsedAmount: 0,
  nonCashAmount: 0,
  cashPaidAmount: 100,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  items: [],
})

describe('home month guards', () => {
  it('does not expose a previous-month summary under a newly selected month', () => {
    expect(summaryForMonth(summary('2026-08'), '2026-09')).toBeUndefined()
    expect(summaryForMonth(summary('2026-09'), '2026-09')?.expenseCashPaidAmount).toBe(1200)
  })

  it('does not expose previous-month recent transactions while a month refresh is pending', () => {
    const transactions = [transaction('august', '2026-08-31'), transaction('september', '2026-09-01')]

    expect(transactionsForMonth(transactions, '2026-09').map((item) => item.id)).toEqual(['september'])
  })

  it('renders loading, loaded, and loading-again home states without conditional hooks', () => {
    const render = (currentSummary: LedgerSummary | undefined) => renderToString(createElement(HomeScreen, {
      month: '2026-09',
      summary: currentSummary,
      target: undefined,
      transactions: [],
      onRetry: () => undefined,
      onPage: () => undefined,
      onSelect: () => undefined,
    }))

    expect(render(undefined)).toContain('読み込み中')
    expect(render(summary('2026-09'))).toContain('今月の収支')
    expect(render(undefined)).toContain('読み込み中')
  })
})

describe('saved receipt retry route', () => {
  it('keeps a receipt identifier inside the same-origin retry path', () => {
    expect(receiptRetryUrl('saved/receipt?draft')).toBe('/api/receipts/saved%2Freceipt%3Fdraft/retry')
  })
})

describe('home overlays', () => {
  it('returns to the preserved home screen when a registration or capture sheet is dismissed', () => {
    expect(dismissOverlayPage()).toBe('home')
  })
})

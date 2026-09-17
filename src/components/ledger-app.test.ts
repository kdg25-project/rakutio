import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { LedgerCategory, LedgerSummary, LedgerTransaction } from '../server/ledger/types'
import { appendReceiptFiles, dismissOverlayPage, homeAssetValues, homeCategorySlots, HomeScreen, monthLabel, monthRangeLabel, pageAfterTransactionDelete, receiptPageAfterAdd, receiptPageAfterRemove, receiptPageStatusText, receiptRetryUrl, receiptUploadFormData, ScreenTitle, summaryForMonth, transactionsForMonth } from './ledger-app'

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
  it('formats a month once and gives the exact monthly date range', () => {
    expect(monthLabel('2026-09')).toBe('2026年9月')
    expect(monthRangeLabel('2026-02')).toBe('2月1日 - 2月28日')
  })

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
      categories: [],
      target: undefined,
      transactions: [],
      onRetry: () => undefined,
      onPage: () => undefined,
      onSelect: () => undefined,
    }))

    expect(render(undefined)).toContain('home-skeleton')
    expect(render(undefined)).not.toContain('spinner')
    const loaded = render(summary('2026-09'))
    expect(loaded).toContain('今月の収支')
    expect(loaded).toContain('9月1日 - 9月30日')
    expect(loaded).toContain('/icons/wallet.svg')
    expect(loaded).toContain('/icons/chevron-right.svg')
    expect(loaded).toContain('前月比')
    expect(loaded).not.toContain('推移')
    expect(render(undefined)).toContain('home-skeleton')
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

describe('form navigation safety', () => {
  it('marks the shared back control as a non-submitting button in every form hierarchy', () => {
    for (const title of ['手動入力の確認', 'カテゴリを編集', 'プロフィール']) {
      const markup = renderToString(createElement('form', undefined, createElement(ScreenTitle, { title, onBack: () => undefined })))
      expect(markup).toContain('type="button"')
    }
  })

  it('returns to history after a deleted detail instead of retaining a blank detail page', () => {
    expect(pageAfterTransactionDelete()).toBe('history')
  })
})


describe('Figma home category slots', () => {
  const category = (id: string, name: string, icon: string): LedgerCategory => ({ id, name, icon, color: '#708779', isDefault: true, createdAt: 0, updatedAt: 0 })

  it('keeps all six Figma bubbles when just one category has spending', () => {
    const slots = homeCategorySlots([category('other', 'その他', 'more-horizontal')], [{ ...category('other', 'その他', 'more-horizontal'), cashPaidAmount: 1234, transactionCount: 1 }])
    expect(slots).toHaveLength(6)
    expect(slots.find((slot) => slot.id === 'other')).toMatchObject({ icon: 'category-other', cashPaidAmount: 1234 })
    expect(slots.filter((slot) => slot.cashPaidAmount === 0)).toHaveLength(5)
  })
})

describe('receipt review pages', () => {
  it('keeps a second selected image and selects it as page 2 of 2', () => {
    expect(receiptPageAfterAdd(1)).toBe(1)
    expect(receiptPageAfterRemove(2, 1)).toBe(0)
  })

  it('preserves pages already captured when the camera captures another file', () => {
    const first = new File(['first'], 'first.jpg', { type: 'image/jpeg' })
    const second = new File(['second'], 'second.jpg', { type: 'image/jpeg' })
    expect(appendReceiptFiles([first], [second]).map((file) => file.name)).toEqual(['first.jpg', 'second.jpg'])
    expect(appendReceiptFiles([first, second, first, second, first, second], [first])).toHaveLength(6)
  })

  it('posts every selected page in order under images regardless of the active thumbnail', () => {
    const first = new File(['first'], 'first.jpg', { type: 'image/jpeg' })
    const second = new File(['second'], 'second.jpg', { type: 'image/jpeg' })
    const form = receiptUploadFormData([first, second])
    expect(form.getAll('images').map((item) => (item as File).name)).toEqual(['first.jpg', 'second.jpg'])
    expect(form.has('image')).toBe(false)
  })

  it('shows Japanese feedback for an individual failed OCR page', () => {
    expect(receiptPageStatusText({ pageIndex: 1, status: 'failed', errorMessage: '画像が不鮮明です' })).toBe('2枚目を読み取れませんでした。画像が不鮮明です')
  })
})


describe('home asset monthly comparison', () => {
  it('uses the monthly-comparison endpoint values rather than the final daily movement', () => {
    const values = homeAssetValues(summary('2026-09'), { currentAsOfDate: '2026-09-16', previousMonthEndDate: '2026-08-31', comparisonBasis: 'as-of-date', currentBalanceAmount: 285200, previousMonthEndBalanceAmount: 194880, deltaAmount: 90320 })
    expect(values).toEqual({ balance: 285200, delta: 90320 })
  })
})


describe('live receipt camera integration', () => {
  it('renders ReceiptCamera in capture and returns from review without discarding pages', () => {
    const source = readFileSync(new URL('./ledger-app.tsx', import.meta.url), 'utf8')
    expect(source).toContain('mode="receipt"')
    expect(source).toContain('data-phase={phase}')
    expect(source).toContain('<ReceiptCamera onCapture={(file) => addFiles([file])}')
    expect(source).toContain('onFallbackFiles={addFiles}')
    expect(source).toContain("onClick={() => setPhase('capture')}")
  })

  it('locks background scrolling while a bottom sheet is open', () => {
    const source = readFileSync(new URL('./ledger-app.tsx', import.meta.url), 'utf8')
    expect(source).toContain("const previousOverflow = document.body.style.overflow")
    expect(source).toContain("document.body.style.overflow = 'hidden'")
    expect(source).toContain('document.body.style.overflow = previousOverflow')
  })
})

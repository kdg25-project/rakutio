import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { LedgerCategory, LedgerSummary, LedgerTransaction } from '../server/ledger/types'
import { appendReceiptFiles, dismissOverlayPage, hasCapturedReceiptPages, homeAssetValues, homeCategorySlots, HomeScreen, incomeTransactionItems, monthLabel, monthRangeLabel, pageAfterTransactionDelete, receiptCategoryForExtraction, receiptCategoryForText, receiptDraftItems, receiptItemCategoryId, receiptItemsWithAuthoritativeTotal, receiptPageAfterAdd, receiptPageAfterRemove, receiptPageStatusText, receiptRetryUrl, receiptUploadFormData, ScreenTitle, summaryForMonth, transactionsForMonth } from './ledger-app'
import { calculateTransaction } from '../domain/money'

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

const ledgerAppSource = readFileSync(new URL('./ledger-app.tsx', import.meta.url), 'utf8')

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

describe('income entry flow', () => {
  it('creates the one backend item from the entered title, category, and amount', () => {
    expect(incomeTransactionItems('  9月分の給与  ', 'salary', 250000)).toEqual([{ name: '9月分の給与', categoryId: 'salary', originalAmount: 250000 }])
  })

  it('keeps income entry and editing on the basic form while expenses retain their review flow', () => {
    const source = readFileSync(new URL('./ledger-app.tsx', import.meta.url), 'utf8')
    expect(source).toContain("transaction?.type === 'income' ? 'basic' : transaction || receipt ? 'review' : 'basic'")
    expect(source).toContain("stage === 'basic' && type !== 'income' ? goToReview : submit")
    expect(source).toContain('収入カテゴリ')
    expect(source).toContain('入金先口座（任意）')
    expect(source).toContain('<section className="line-items"><div className="section-heading"><h2>購入した商品</h2>')
  })

  it('returns from category management to settings through LedgerApp', () => {
    const source = readFileSync(new URL('./ledger-app.tsx', import.meta.url), 'utf8')
    expect(source).toContain("<CategoriesScreen categories={categories} onBack={() => setPage('settings')}")
    expect(source).toContain('ScreenTitle title="カテゴリ管理" onBack={onBack}')
  })

  it('returns from monthly target settings to settings through LedgerApp', () => {
    const source = readFileSync(new URL('./ledger-app.tsx', import.meta.url), 'utf8')
    expect(source).toContain("<FinanceMonthTargetScreen month={month} notify={setNotice} onBack={() => setPage('settings')}")
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
  const receiptCategories: LedgerCategory[] = [
    { id: 'food', name: '食費', icon: 'utensils', color: '#000', isDefault: true, createdAt: 0, updatedAt: 0 },
    { id: 'fun', name: '娯楽', icon: 'party-popper', color: '#000', isDefault: true, createdAt: 0, updatedAt: 0 },
    { id: 'other', name: 'その他', icon: 'more-horizontal', color: '#000', isDefault: true, createdAt: 0, updatedAt: 0 },
  ]

  it('classifies OCR merchant and item names locally without an LLM request', () => {
    expect(receiptCategoryForText(receiptCategories, 'TOHO CINEMAS', 'オデュッセイア')).toMatchObject({ id: 'fun', name: '娯楽' })
    expect(receiptCategoryForExtraction(receiptCategories, { merchant: 'スーパー', purchasedAt: null, total: 300, tax: null, currency: 'JPY', items: [{ name: 'パン', quantity: 1, amount: 300 }] })).toMatchObject({ id: 'food' })
    expect(receiptItemCategoryId(receiptCategories, 'TOHO CINEMAS', 'パンフレット')).toBe('fun')
    expect(receiptCategoryForText(receiptCategories, '判別できない店舗', '名称不明')).toBeUndefined()
  })

  it('keeps an unknown OCR category editable by using the existing その他 category in the form', () => {
    expect(receiptItemCategoryId(receiptCategories, '判別できない店舗', '名称不明')).toBe('other')
  })

  it('uses the OCR total for registration when individual item prices are unavailable', () => {
    const extraction = { merchant: 'TOHO CINEMAS', purchasedAt: null, total: 2910, tax: null, currency: 'JPY', items: [
      { name: 'パンフレット', quantity: null, amount: null },
      { name: 'キーホルダー', quantity: null, amount: null },
    ] }
    const draft = receiptDraftItems(extraction, receiptCategories)
    const prepared = receiptItemsWithAuthoritativeTotal(draft, extraction.total, 'fun')

    expect(draft.map((item) => item.originalAmount)).toEqual([0, 0])
    expect(prepared.error).toBeUndefined()
    expect(prepared.items.at(-1)).toMatchObject({ name: '未配分（レシート合計）', originalAmount: 2910, categoryId: 'fun' })
    expect(calculateTransaction({ items: prepared.items, receiptDiscountAmount: 0, pointUsedAmount: 0, giftCertificateUsedAmount: 0 }).totals).toMatchObject({ grossAmount: 2910, cashPaidAmount: 2910 })
  })

  it('keeps line prices when they fit under the OCR total and makes only the difference unallocated', () => {
    const prepared = receiptItemsWithAuthoritativeTotal([{ name: '飲み物', originalAmount: 280, discountAmount: 30, categoryId: 'food' }], 500, 'food')
    expect(prepared.items).toEqual([
      { name: '飲み物', originalAmount: 280, discountAmount: 0, categoryId: 'food' },
      { name: '未配分（レシート合計）', originalAmount: 220, discountAmount: 0, categoryId: 'food' },
    ])
    expect(calculateTransaction({ items: prepared.items, receiptDiscountAmount: 0, pointUsedAmount: 0, giftCertificateUsedAmount: 0 }).totals.cashPaidAmount).toBe(500)
  })

  it('does not let conflicting OCR item prices override the printed total', () => {
    const extraction = { merchant: '店舗', purchasedAt: null, total: 194, tax: null, currency: 'JPY', items: [{ name: '誤読した商品', quantity: 1, amount: 280 }] }
    expect(receiptDraftItems(extraction, receiptCategories)).toMatchObject([{ originalAmount: 0 }])
    expect(receiptItemsWithAuthoritativeTotal([{ name: '手入力', originalAmount: 195, discountAmount: 0, categoryId: 'food' }], 194, 'food').error).toBe('各商品の金額がレシートの合計金額を超えています。')
  })

  it('uses a validated Gemini category before the local fallback and shows its representative category', () => {
    const extraction = { merchant: 'TOHO CINEMAS', purchasedAt: null, total: 300, tax: null, currency: 'JPY', items: [
      { name: 'パンフレット', quantity: 1, amount: 300, categoryId: 'food' },
    ] }
    expect(receiptItemCategoryId(receiptCategories, extraction.merchant, extraction.items[0]!.name, extraction.items[0]!.categoryId)).toBe('food')
    expect(receiptCategoryForExtraction(receiptCategories, extraction)).toMatchObject({ id: 'food' })
  })

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

  it('only exposes the capture-to-review return path after an image exists', () => {
    const page = new File(['page'], 'page.jpg', { type: 'image/jpeg' })
    expect(hasCapturedReceiptPages([])).toBe(false)
    expect(hasCapturedReceiptPages([page])).toBe(true)
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

  it('keeps normal and failed OCR review feedback below the preview controls', () => {
    const preview = ledgerAppSource.indexOf('<div className="receipt-preview">')
    const pages = ledgerAppSource.indexOf('<div className="receipt-pages">', preview)
    const feedback = ledgerAppSource.indexOf('<div className="receipt-review-feedback">', pages)
    const action = ledgerAppSource.indexOf('この写真で読み取る', feedback)

    expect(preview).toBeGreaterThan(-1)
    expect(pages).toBeGreaterThan(preview)
    expect(feedback).toBeGreaterThan(pages)
    expect(action).toBeGreaterThan(feedback)
    expect(ledgerAppSource).toContain('role="alert"')
    expect(ledgerAppSource).toContain('aria-label="ページ別の読み取り結果"')
    expect(ledgerAppSource).toContain('失敗したページを再読み取り')
    expect(ledgerAppSource).toContain("files.length > 1 && <button type=\"button\" className=\"button secondary\" onClick={() => void retrySavedDraft(true)}>すべてのページを再読み取り")
    expect(ledgerAppSource).toContain('receiptCategoryForExtraction(categories, result.extraction)')
    expect(ledgerAppSource).toContain("{resultCategory?.name ?? '未設定'}")
    expect(ledgerAppSource).toContain("{result.extraction.paymentMethod ?? '未設定'}")
    expect(ledgerAppSource).toContain("item.amount == null ? '未取得' : yen(item.amount)")
    expect(ledgerAppSource).toContain('合計金額（レシートOCR）')
    expect(ledgerAppSource).toContain('!hasAuthoritativeReceiptTotal && <input aria-label={`値引き ${index + 1}`}')
  })

  it('does not pretend that unobservable server-side OCR stages are complete while waiting for the response', () => {
    expect(ledgerAppSource).toContain('読み取りサービスからの応答を待っています')
    expect(ledgerAppSource).toContain('通信中は各項目を完了表示にしません。')
    expect(ledgerAppSource).toContain('支払い方法を確認中')
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
    expect(source).toContain("mode === 'receipt'")
    expect(source).toContain("'app-receipt-screen'")
    expect(source).toContain("mode={phase === 'capture' ? 'receipt-capture' : 'receipt'}")
    expect(source).toContain('data-phase={phase}')
    expect(source).toContain('receipt-capture-heading')
    expect(source).toContain('続けて撮影')
    expect(source).toContain('<ReceiptCamera onCapture={(file) => addFiles([file])}')
    expect(source).toContain('onFallbackFiles={addFiles}')
    expect(source).toContain("onClick={() => setPhase('capture')}")
    expect(source).toContain("hasCapturedReceiptPages(files) && <button className=\"receipt-capture-return\"")
    expect(source).toContain("onClick={() => setPhase('review')}")
    expect(source).toContain('aria-label="撮影した画像に戻る"')
  })

  it('locks background scrolling while a bottom sheet is open', () => {
    const source = readFileSync(new URL('./ledger-app.tsx', import.meta.url), 'utf8')
    expect(source).toContain("const previousOverflow = document.body.style.overflow")
    expect(source).toContain("document.body.style.overflow = 'hidden'")
    expect(source).toContain('document.body.style.overflow = previousOverflow')
  })
})

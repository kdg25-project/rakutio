import { describe, expect, it } from 'vitest'

import { MoneyCalculationError, calculateTransaction } from './money'

describe('calculateTransaction', () => {
  it('allocates receipt discounts and non-cash payment with deterministic largest remainders', () => {
    const transaction = calculateTransaction({
      items: [
        { id: 'a', name: '牛乳', originalAmount: 101, discountAmount: 1, categoryId: 'food' },
        { id: 'b', name: '洗剤', originalAmount: 100, discountAmount: 0, categoryId: 'daily' },
        { id: 'c', name: 'パン', originalAmount: 100, discountAmount: 0, categoryId: 'food' },
      ],
      receiptDiscountAmount: 2,
      pointUsedAmount: 1,
      giftCertificateUsedAmount: 2,
    })

    expect(transaction.items.map((item) => item.allocatedDiscount)).toEqual([1, 1, 0])
    expect(transaction.items.map((item) => item.finalAmount)).toEqual([99, 99, 100])
    expect(transaction.items.map((item) => item.allocatedPointAmount)).toEqual([0, 0, 1])
    expect(transaction.items.map((item) => item.allocatedGiftCertificateAmount)).toEqual([1, 1, 0])
    expect(transaction.items.map((item) => item.paidAmount)).toEqual([98, 98, 99])
    expect(transaction.totals).toMatchObject({
      grossAmount: 301,
      itemDiscountAmount: 1,
      receiptDiscountAmount: 2,
      discountAmount: 3,
      netAmount: 298,
      pointUsedAmount: 1,
      giftCertificateUsedAmount: 2,
      nonCashAmount: 3,
      cashPaidAmount: 295,
      categoryPaidTotals: { food: 197, daily: 98 },
    })
    expect(Object.values(transaction.totals.categoryPaidTotals).reduce((sum, value) => sum + value, 0)).toBe(transaction.totals.cashPaidAmount)
  })

  it('keeps points and gift certificates separate and never deducts either twice', () => {
    const transaction = calculateTransaction({
      items: [
        { name: 'りんご', originalAmount: 50, discountAmount: 0, categoryId: 'food' },
        { name: '電池', originalAmount: 50, discountAmount: 0, categoryId: 'daily' },
      ],
      receiptDiscountAmount: 0,
      pointUsedAmount: 30,
      giftCertificateUsedAmount: 20,
    })

    expect(transaction.items.reduce((sum, item) => sum + item.allocatedPointAmount, 0)).toBe(30)
    expect(transaction.items.reduce((sum, item) => sum + item.allocatedGiftCertificateAmount, 0)).toBe(20)
    expect(transaction.items.reduce((sum, item) => sum + item.paidAmount, 0)).toBe(50)
    expect(transaction.totals.cashPaidAmount).toBe(50)
  })

  it('weights the receipt-wide discount by pre-discount line amounts', () => {
    const transaction = calculateTransaction({
      items: [
        { name: '高額商品', originalAmount: 1_000, discountAmount: 500, categoryId: 'a' },
        { name: '通常商品', originalAmount: 500, discountAmount: 0, categoryId: 'b' },
      ],
      receiptDiscountAmount: 300,
      pointUsedAmount: 0,
      giftCertificateUsedAmount: 0,
    })

    expect(transaction.items.map((item) => item.allocatedDiscount)).toEqual([200, 100])
    expect(transaction.items.map((item) => item.finalAmount)).toEqual([300, 400])
  })

  it('caps a receipt-wide discount at each line balance then redistributes the excess', () => {
    const transaction = calculateTransaction({
      items: [
        { name: '値引き済み商品', originalAmount: 1_000, discountAmount: 950, categoryId: 'a' },
        { name: '通常商品', originalAmount: 500, discountAmount: 0, categoryId: 'b' },
      ],
      receiptDiscountAmount: 300,
      pointUsedAmount: 0,
      giftCertificateUsedAmount: 0,
    })

    expect(transaction.items.map((item) => item.allocatedDiscount)).toEqual([50, 250])
    expect(transaction.items.map((item) => item.finalAmount)).toEqual([0, 250])
  })

  it('allows a receipt to be completely paid by a gift certificate', () => {
    const transaction = calculateTransaction({
      items: [{ name: '書籍', originalAmount: 500, discountAmount: 0, categoryId: 'hobby' }],
      receiptDiscountAmount: 0,
      pointUsedAmount: 0,
      giftCertificateUsedAmount: 500,
    })

    expect(transaction.items[0]).toMatchObject({ finalAmount: 500, allocatedGiftCertificateAmount: 500, paidAmount: 0 })
    expect(transaction.totals).toMatchObject({ netAmount: 500, cashPaidAmount: 0, categoryPaidTotals: { hobby: 0 } })
  })

  it('rejects invalid monetary inputs and deductions beyond the net amount', () => {
    const validItem = { name: '水', originalAmount: 100, discountAmount: 0, categoryId: 'food' }
    expect(() => calculateTransaction({ items: [], receiptDiscountAmount: 0, pointUsedAmount: 0, giftCertificateUsedAmount: 0 })).toThrow(MoneyCalculationError)
    expect(() => calculateTransaction({ items: [{ ...validItem, discountAmount: 101 }], receiptDiscountAmount: 0, pointUsedAmount: 0, giftCertificateUsedAmount: 0 })).toThrow(MoneyCalculationError)
    expect(() => calculateTransaction({ items: [validItem], receiptDiscountAmount: 0, pointUsedAmount: 101, giftCertificateUsedAmount: 0 })).toThrow(MoneyCalculationError)
    expect(() => calculateTransaction({ items: [{ ...validItem, originalAmount: 0 }], receiptDiscountAmount: 0, pointUsedAmount: 0, giftCertificateUsedAmount: 0 })).toThrow(MoneyCalculationError)
    expect(() => calculateTransaction({ items: [{ ...validItem, originalAmount: Number.MAX_SAFE_INTEGER + 1 }], receiptDiscountAmount: 0, pointUsedAmount: 0, giftCertificateUsedAmount: 0 })).toThrow(MoneyCalculationError)
  })

  it('breaks equal fractional remainders by original item index', () => {
    const transaction = calculateTransaction({
      items: [
        { name: '先頭', originalAmount: 1, discountAmount: 0, categoryId: 'a' },
        { name: '後方', originalAmount: 1, discountAmount: 0, categoryId: 'b' },
      ],
      receiptDiscountAmount: 1,
      pointUsedAmount: 0,
      giftCertificateUsedAmount: 0,
    })
    expect(transaction.items.map((item) => item.allocatedDiscount)).toEqual([1, 0])
  })
})

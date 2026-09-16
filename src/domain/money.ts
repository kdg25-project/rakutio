/**
 * Monetary calculations for one receipt. All amounts are Japanese yen stored as
 * safe integer line totals; quantities intentionally do not participate here.
 */
export type TransactionItemInput = {
  id?: string
  name: string
  originalAmount: number
  discountAmount: number
  categoryId: string
}

export type TransactionCalculationInput = {
  items: TransactionItemInput[]
  receiptDiscountAmount: number
  pointUsedAmount: number
  giftCertificateUsedAmount: number
}

export type CalculatedTransactionItem = TransactionItemInput & {
  /** Discount printed on this line. */
  itemDiscount: number
  /** Share of a receipt-wide discount assigned to this line. */
  allocatedDiscount: number
  /** Amount after both kinds of discount, before points or gift certificates. */
  finalAmount: number
  allocatedPointAmount: number
  allocatedGiftCertificateAmount: number
  /** Cash charged to this line after non-cash payment methods. */
  paidAmount: number
}

export type TransactionTotals = {
  grossAmount: number
  itemDiscountAmount: number
  receiptDiscountAmount: number
  discountAmount: number
  netAmount: number
  pointUsedAmount: number
  giftCertificateUsedAmount: number
  nonCashAmount: number
  cashPaidAmount: number
  categoryPaidTotals: Record<string, number>
}

export type CalculatedTransaction = {
  items: CalculatedTransactionItem[]
  totals: TransactionTotals
}

export class MoneyCalculationError extends Error {
  override name = 'MoneyCalculationError'
}

const MAX_ITEM_COUNT = 1_000
const MAX_LINE_AMOUNT = 1_000_000_000_000

function fail(message: string): never {
  throw new MoneyCalculationError(message)
}

function assertYen(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_LINE_AMOUNT) {
    fail(`${field} は 0 以上 ${MAX_LINE_AMOUNT.toLocaleString('ja-JP')} 以下の整数円で指定してください。`)
  }
}

function safeAdd(left: number, right: number, field: string) {
  const total = left + right
  if (!Number.isSafeInteger(total)) fail(`${field} が安全に扱える範囲を超えています。`)
  return total
}

function sum(values: readonly number[], field: string) {
  return values.reduce((total, value) => safeAdd(total, value, field), 0)
}

/**
 * Integer largest-remainder apportionment. Equal fractions keep source order,
 * which makes a saved receipt reproducible regardless of sort stability.
 */
function allocateProportionally(total: number, bases: readonly number[], field: string) {
  if (total === 0) return bases.map(() => 0)
  const baseTotal = sum(bases, field)
  if (baseTotal === 0) fail(`${field} を配分する対象がありません。`)
  if (total > baseTotal) fail(`${field} が配分可能な金額を超えています。`)

  const denominator = BigInt(baseTotal)
  const numerator = BigInt(total)
  const allocations = bases.map((base) => Number((BigInt(base) * numerator) / denominator))
  const allocated = sum(allocations, field)
  const missing = total - allocated

  const rank = bases.map((base, index) => ({
    index,
    remainder: (BigInt(base) * numerator) % denominator,
  })).sort((left, right) => {
    if (left.remainder === right.remainder) return left.index - right.index
    return left.remainder > right.remainder ? -1 : 1
  })

  for (let offset = 0; offset < missing; offset += 1) {
    const target = rank[offset]
    if (!target) fail(`${field} の端数配分に失敗しました。`)
    allocations[target.index] += 1
  }
  return allocations
}

/**
 * Receipt-wide discounts are weighted by the pre-discount line amounts. A line
 * cannot receive more than its remaining balance, so any capped share is
 * redistributed using the same original weights and original-index tie break.
 */
function allocateReceiptDiscount(total: number, originalAmounts: readonly number[], remainingAmounts: readonly number[]) {
  if (total === 0) return originalAmounts.map(() => 0)
  if (total > sum(remainingAmounts, 'レシート割引')) fail('レシート割引が値引き後合計を超えています。')

  const allocations = originalAmounts.map(() => 0)
  let unallocated = total
  while (unallocated > 0) {
    const active = originalAmounts.map((weight, index) => ({ index, weight, capacity: remainingAmounts[index] - allocations[index] }))
      .filter((line) => line.capacity > 0)
    if (active.length === 0) fail('レシート割引の再配分に失敗しました。')

    const proposed = allocateProportionally(unallocated, active.map((line) => line.weight), 'レシート割引')
    const allocatedThisRound = proposed.reduce((roundTotal, amount, activeIndex) => {
      const line = active[activeIndex]
      const applied = Math.min(amount, line.capacity)
      allocations[line.index] += applied
      return safeAdd(roundTotal, applied, 'レシート割引')
    }, 0)
    if (allocatedThisRound === 0) fail('レシート割引の再配分に失敗しました。')
    unallocated -= allocatedThisRound
  }
  return allocations
}

function validateInput(input: TransactionCalculationInput) {
  if (!Array.isArray(input.items) || input.items.length === 0) fail('明細を 1 件以上指定してください。')
  if (input.items.length > MAX_ITEM_COUNT) fail(`明細は ${MAX_ITEM_COUNT} 件以下にしてください。`)
  assertYen(input.receiptDiscountAmount, 'レシート割引')
  assertYen(input.pointUsedAmount, 'ポイント利用額')
  assertYen(input.giftCertificateUsedAmount, '商品券利用額')

  input.items.forEach((item, index) => {
    if (!item || typeof item !== 'object') fail(`明細 ${index + 1} が不正です。`)
    if (typeof item.name !== 'string' || !item.name.trim()) fail(`明細 ${index + 1} の品名を指定してください。`)
    if (typeof item.categoryId !== 'string' || !item.categoryId.trim()) fail(`明細 ${index + 1} のカテゴリを指定してください。`)
    assertYen(item.originalAmount, `明細 ${index + 1} の金額`)
    assertYen(item.discountAmount, `明細 ${index + 1} の値引き`)
    if (item.discountAmount > item.originalAmount) fail(`明細 ${index + 1} の値引きが金額を超えています。`)
  })
}

/**
 * Calculates discounts and actual cash paid without floating-point rounding.
 * Points are allocated first, then gift certificates against the remaining
 * line amounts, so no item can receive more non-cash deduction than its net.
 */
export function calculateTransaction(input: TransactionCalculationInput): CalculatedTransaction {
  validateInput(input)

  const grossAmount = sum(input.items.map((item) => item.originalAmount), '合計金額')
  if (grossAmount === 0) fail('合計金額が 0 円の明細は登録できません。')

  const itemDiscountAmount = sum(input.items.map((item) => item.discountAmount), '明細値引き合計')
  const afterItemDiscount = input.items.map((item) => item.originalAmount - item.discountAmount)
  const subtotalAfterItemDiscount = sum(afterItemDiscount, '値引き後合計')
  if (input.receiptDiscountAmount > subtotalAfterItemDiscount) fail('レシート割引が値引き後合計を超えています。')

  const allocatedDiscounts = allocateReceiptDiscount(input.receiptDiscountAmount, input.items.map((item) => item.originalAmount), afterItemDiscount)
  const finalAmounts = afterItemDiscount.map((amount, index) => amount - allocatedDiscounts[index])
  const netAmount = sum(finalAmounts, '支払対象合計')
  const nonCashAmount = safeAdd(input.pointUsedAmount, input.giftCertificateUsedAmount, 'ポイント・商品券利用合計')
  if (nonCashAmount > netAmount) fail('ポイントと商品券の利用合計が支払対象合計を超えています。')

  const allocatedPoints = allocateProportionally(input.pointUsedAmount, finalAmounts, 'ポイント利用額')
  const afterPoints = finalAmounts.map((amount, index) => amount - allocatedPoints[index])
  const allocatedGifts = allocateProportionally(input.giftCertificateUsedAmount, afterPoints, '商品券利用額')
  const paidAmounts = afterPoints.map((amount, index) => amount - allocatedGifts[index])
  const cashPaidAmount = sum(paidAmounts, '現金支払額')

  const categoryPaidTotals: Record<string, number> = {}
  input.items.forEach((item, index) => {
    categoryPaidTotals[item.categoryId] = safeAdd(categoryPaidTotals[item.categoryId] ?? 0, paidAmounts[index], 'カテゴリ別支払額')
  })

  return {
    items: input.items.map((item, index) => ({
      ...item,
      itemDiscount: item.discountAmount,
      allocatedDiscount: allocatedDiscounts[index],
      finalAmount: finalAmounts[index],
      allocatedPointAmount: allocatedPoints[index],
      allocatedGiftCertificateAmount: allocatedGifts[index],
      paidAmount: paidAmounts[index],
    })),
    totals: {
      grossAmount,
      itemDiscountAmount,
      receiptDiscountAmount: input.receiptDiscountAmount,
      discountAmount: safeAdd(itemDiscountAmount, input.receiptDiscountAmount, '値引き合計'),
      netAmount,
      pointUsedAmount: input.pointUsedAmount,
      giftCertificateUsedAmount: input.giftCertificateUsedAmount,
      nonCashAmount,
      cashPaidAmount,
      categoryPaidTotals,
    },
  }
}

export type AssetAccountType = 'bank' | 'cash' | 'gift'
export type BankAccountKind = 'ordinary' | 'checking' | 'time'
export type AssetEntryKind = 'opening' | 'adjustment' | 'transfer' | 'transaction'

export type AssetAccount = {
  id: string
  type: AssetAccountType
  name: string
  bankKind: BankAccountKind | null
  bankMemo: string | null
  balanceAmount: number
  isArchived: boolean
  createdAt: number
  updatedAt: number
}

export type AssetEntry = {
  id: string
  accountId: string
  operationId: string | null
  transactionId: string | null
  kind: AssetEntryKind
  amount: number
  occurredAt: string
  memo: string
  createdAt: number
}

export type AssetSummary = {
  totalAmount: number
  activeTotalAmount: number
  accounts: AssetAccount[]
}

export type AssetBalanceHistoryPoint = { date: string; deltaAmount: number; balanceAmount: number }

/**
 * Total assets at the selected endpoint compared with the prior calendar
 * month's closing balance.  `currentAsOfDate` is the selected `to` date; it
 * is only a month-end snapshot when `comparisonBasis` is `month-end`.
 */
export type AssetMonthlyComparison = {
  currentAsOfDate: string
  previousMonthEndDate: string
  comparisonBasis: 'month-end' | 'as-of-date'
  currentBalanceAmount: number
  previousMonthEndBalanceAmount: number
  deltaAmount: number
}

/**
 * History contains actual movement dates only. Boundary snapshots expose the
 * carried balance without inventing a zero-value asset entry.
 */
export type AssetBalanceHistory = {
  history: AssetBalanceHistoryPoint[]
  openingBalanceAmount: number
  closingBalanceAmount: number
  monthlyComparison: AssetMonthlyComparison
}

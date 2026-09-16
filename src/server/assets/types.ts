export type AssetAccountType = 'bank' | 'cash' | 'gift'
export type AssetEntryKind = 'opening' | 'adjustment' | 'transfer' | 'transaction'

export type AssetAccount = {
  id: string
  type: AssetAccountType
  name: string
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
 * History contains actual movement dates only. Boundary snapshots expose the
 * carried balance without inventing a zero-value asset entry.
 */
export type AssetBalanceHistory = {
  history: AssetBalanceHistoryPoint[]
  openingBalanceAmount: number
  closingBalanceAmount: number
}

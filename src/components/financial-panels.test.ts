import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { AssetAccount } from '../server/assets/types'
import { assetHistoryRange, tokyoToday } from '../lib/jst-date'
import { bankSettingsAccounts, completeAssetMutation, restoreAssetAccount, transferSelection } from './financial-panels'

function account(id: string, type: AssetAccount['type'], isArchived = false): AssetAccount {
  return { id, type, name: id, bankKind: type === 'bank' ? 'ordinary' : null, bankMemo: null, balanceAmount: 0, isArchived, createdAt: 0, updatedAt: 0 }
}

describe('Tokyo calendar helpers', () => {
  it('keeps the Japanese date before and after the UTC rollover boundary', () => {
    expect(tokyoToday(new Date('2026-02-28T15:00:00.000Z'))).toBe('2026-03-01')
    expect(tokyoToday(new Date('2026-02-28T23:59:59.999Z'))).toBe('2026-03-01')
  })

  it('uses the Tokyo month when building the six-month history range', () => {
    expect(assetHistoryRange(new Date('2026-02-28T15:00:00.000Z'))).toEqual({ from: '2025-10-01', to: '2026-03-01' })
    expect(assetHistoryRange(new Date('2026-01-31T23:00:00.000Z'))).toEqual({ from: '2025-09-01', to: '2026-02-01' })
  })

  it('clamps the route default range at February month-end, including leap years', () => {
    expect(assetHistoryRange(new Date('2026-07-31T14:59:59.999Z'))).toEqual({ from: '2026-02-28', to: '2026-07-31' })
    expect(assetHistoryRange(new Date('2024-07-31T14:59:59.999Z'))).toEqual({ from: '2024-02-29', to: '2024-07-31' })
  })

  it('uses the next Japanese date after the UTC boundary for the route default range', () => {
    expect(assetHistoryRange(new Date('2026-07-31T15:00:00.000Z'))).toEqual({ from: '2026-03-01', to: '2026-08-01' })
  })
})

describe('asset restore confirmation mutation', () => {
  it('sends the restore PATCH and closes both confirmation states only after a successful refresh', async () => {
    const request = vi.fn().mockResolvedValue({})
    const changed = vi.fn().mockResolvedValue(undefined)
    const ui = { panel: 'edit' as string | undefined, archive: true as boolean | undefined, restore: true as boolean | undefined }

    await completeAssetMutation(
      () => restoreAssetAccount('archived/account', request),
      changed,
      () => { ui.panel = undefined; ui.archive = undefined; ui.restore = undefined },
    )

    expect(request).toHaveBeenCalledWith('/api/assets/accounts/archived%2Faccount', { method: 'PATCH', body: JSON.stringify({ isArchived: false }) })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(ui).toEqual({ panel: undefined, archive: undefined, restore: undefined })
  })

  it('keeps the restore confirmation state open when the restore request fails', async () => {
    const ui = { panel: 'edit' as string | undefined, archive: true as boolean | undefined, restore: true as boolean | undefined }
    await expect(completeAssetMutation(
      () => restoreAssetAccount('archived', async () => { throw new Error('offline') }),
      async () => undefined,
      () => { ui.panel = undefined; ui.archive = undefined; ui.restore = undefined },
    )).rejects.toThrow('offline')
    expect(ui).toEqual({ panel: 'edit', archive: true, restore: true })
  })
})

describe('transfer account selection', () => {
  const accounts = [account('gift', 'gift'), account('bank', 'bank'), account('cash', 'cash'), account('archived-bank', 'bank', true)]

  it('allows only active bank/cash accounts as sources and excludes the selected source from destinations', () => {
    const selection = transferSelection(accounts, 'bank', 'gift')
    expect(selection.sourceAccounts.map((item) => item.id)).toEqual(['bank', 'cash'])
    expect(selection.destinationAccounts.map((item) => item.id)).toEqual(['gift', 'cash'])
    expect(selection.sourceId).toBe('bank')
    expect(selection.destinationId).toBe('gift')
  })

  it('keeps still-valid selections and clears impossible defaults when only a gift account remains', () => {
    expect(transferSelection(accounts, 'cash', 'bank')).toMatchObject({ sourceId: 'cash', destinationId: 'bank' })
    expect(transferSelection([account('gift', 'gift')], 'gift', 'gift')).toMatchObject({ sourceId: '', destinationId: '' })
  })
})

describe('bank settings account grouping', () => {
  it('keeps the bank settings list focused on banks while retaining cash and gift management', () => {
    const grouped = bankSettingsAccounts([account('bank', 'bank'), account('cash', 'cash'), account('gift', 'gift')])
    expect(grouped.banks.map((item) => item.id)).toEqual(['bank'])
    expect(grouped.otherAssets.map((item) => item.id)).toEqual(['cash', 'gift'])
  })

  it('keeps the add CTA in content flow and opens account detail actions from a selected row', async () => {
    const [styles, component] = await Promise.all([
      readFile(resolve(process.cwd(), 'src/components/financial-panels.css'), 'utf8'),
      readFile(resolve(process.cwd(), 'src/components/financial-panels.tsx'), 'utf8'),
    ])
    expect(styles).toMatch(/\.finance-bank-add\{[^}]*position:static/)
    expect(styles).not.toMatch(/\.finance-bank-add\{[^}]*position:fixed/)
    expect(styles).toMatch(/\.finance-bank-list \.finance-account-row\{[^}]*min-height:50px/)
    expect(component).toContain("setPanel('details')")
    expect(component).toContain('BankAccountDetailScreen')
  })

  it('keeps the bank list row limited to its Figma fields and uses a compact security notice', async () => {
    const component = await readFile(resolve(process.cwd(), 'src/components/financial-panels.tsx'), 'utf8')
    const bankList = component.slice(component.indexOf('bankAccounts.map'), component.indexOf('</ul>', component.indexOf('bankAccounts.map')))

    expect(bankList).toContain('<b>{account.name}</b>')
    expect(bankList).toContain("bankKindLabel[account.bankKind ?? 'ordinary']")
    expect(bankList).toContain('<strong>{yen(account.balanceAmount)}</strong>')
    expect(bankList).toContain('<ChevronIcon />')
    expect(bankList).not.toMatch(/残高を調整|>編集</)
    expect(component).toContain('登録した銀行情報は、安全に保存されます。')
    expect(component).not.toContain('Cloudflare D1')
    expect(component).not.toContain('外部に送信されることはありません')
  })
})

describe('financial screen loading states', () => {
  it('keeps navigation loading inside static skeleton geometry without a spinner', async () => {
    const component = await readFile(resolve(process.cwd(), 'src/components/financial-panels.tsx'), 'utf8')
    const styles = await readFile(resolve(process.cwd(), 'src/components/financial-panels-loading.css'), 'utf8')

    expect(component).toContain('function FinancePanelSkeleton')
    expect(component).toContain('function FinanceInlineSkeleton')
    expect(component).toContain("if (loading && !assets) return <FinancePanelSkeleton")
    expect(component).toContain("if (loading && !target) return <FinancePanelSkeleton")
    expect(component).toContain("if (loading && !rules.length && !categories.length && !accounts.length) return <FinancePanelSkeleton")
    expect(component).not.toContain('function Loading(')
    expect(styles).not.toContain('finance-spin')
    expect(styles).toContain('finance-skeleton-pulse')
  })
})

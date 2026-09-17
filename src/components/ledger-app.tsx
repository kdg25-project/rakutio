import { ChangeEvent, FormEvent, ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'

import { calculateTransaction, MoneyCalculationError } from '../domain/money'
import type { ReceiptExtraction } from '../ocr/receipt'
import type { AssetAccount, AssetBalanceHistory, AssetBalanceHistoryPoint, AssetMonthlyComparison, AssetSummary } from '../server/assets/types'
import type { LedgerCategory, LedgerSummary, LedgerTransaction, LedgerTransactionInput, UtilityKind } from '../server/ledger/types'
import type { MonthlyTarget } from '../server/planning/service'
import { ExpenseBubbles } from './expense-bubbles'
import { BrandLogo } from './brand-logo'
import { ReceiptCamera } from './receipt-camera'
import { invalidateViewCache, readViewCache, viewCacheKey, writeViewCache } from '../lib/view-cache'
import { AssetsScreen as FinanceAssetsScreen, MonthTargetScreen as FinanceMonthTargetScreen, RecurringScreen as FinanceRecurringScreen } from './financial-panels'
import { AnalyticsScreen as HistoryAnalyticsScreen, HistoryScreen as LedgerHistoryScreen } from './history-analytics'

type Page = 'home' | 'history' | 'detail' | 'add' | 'entry' | 'receipt' | 'receipt-saved' | 'analytics' | 'settings' | 'profile' | 'categories' | 'budget' | 'assets' | 'recurring'
type Notice = { kind: 'success' | 'error'; text: string } | undefined
type Confirmation = { title: string; text: string; action: () => Promise<void> } | undefined
type ApiErrorBody = { error?: { code?: unknown; message?: unknown; details?: unknown } }
type OcrPageStatus = { pageIndex: number; status: 'analyzed' | 'failed'; errorCode?: string | null; errorMessage?: string | null }
type OcrResponse = { receipt?: ReceiptExtraction; receiptId?: string; pageCount?: number; pages?: OcrPageStatus[]; error?: { code?: unknown; message?: unknown } }
type EditorItem = { id?: string; name: string; originalAmount: number; discountAmount: number; categoryId: string; utilityKind?: UtilityKind }
type ProfileTheme = 'sage' | 'rose' | 'beige' | 'lavender' | 'blue' | 'gray' | 'peach'
type Profile = { name: string; theme: ProfileTheme; memo: string; image: string | null }

const defaultProfile: Profile = { name: '', theme: 'sage', memo: '', image: null }
const profileThemes: Array<{ value: ProfileTheme; label: string }> = [
  { value: 'sage', label: 'セージ' }, { value: 'blue', label: 'ブルー' }, { value: 'beige', label: 'ベージュ' },
  { value: 'lavender', label: 'ラベンダー' }, { value: 'rose', label: 'ローズ' }, { value: 'gray', label: 'マスタード' }, { value: 'peach', label: 'ピーチ' },
]

const pages: Array<{ id: Page; label: string; icon: string }> = [
  { id: 'home', label: 'ホーム', icon: '/icons/home.svg' }, { id: 'history', label: '履歴', icon: '/icons/history.svg' },
  { id: 'entry', label: '新規登録', icon: '/icons/add.svg' }, { id: 'analytics', label: '分析', icon: '/icons/analytics.svg' }, { id: 'settings', label: '設定', icon: '/icons/settings.svg' },
]

function japanDate(date = new Date()) {
  const values = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) => values.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}
function monthNow() { return japanDate().slice(0, 7) }
function dateNow() { return japanDate() }
function yen(value: number) { return `¥ ${new Intl.NumberFormat('ja-JP').format(value)}` }
export function monthLabel(month: string) { const [year, rawMonth] = month.split('-'); return `${year}年${Number(rawMonth)}月` }
export function monthRangeLabel(month: string) { const [year, rawMonth] = month.split('-').map(Number); const lastDay = new Date(year, rawMonth, 0).getDate(); return `${rawMonth}月1日 - ${rawMonth}月${lastDay}日` }
function headerDateLabel(date = new Date()) { return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'short' }).format(date) }
function dateLabel(value: string) { return new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${value}T00:00:00`)) }
export function summaryForMonth(summary: LedgerSummary | undefined, month: string) {
  return summary?.month === month ? summary : undefined
}
export function homeAssetValues(summary: LedgerSummary, comparison?: AssetMonthlyComparison) {
  return { balance: comparison?.currentBalanceAmount ?? summary.assetActiveTotalAmount, delta: comparison?.deltaAmount ?? 0 }
}
export function transactionsForMonth(transactions: LedgerTransaction[], month: string) {
  return transactions.filter((transaction) => transaction.occurredAt.startsWith(`${month}-`))
}
export function receiptRetryUrl(receiptId: string) {
  return `/api/receipts/${encodeURIComponent(receiptId)}/retry`
}
export function dismissOverlayPage() { return 'home' as const }
export function pageAfterTransactionDelete() { return 'history' as const }
function apiError(body: ApiErrorBody | undefined, fallback: string) {
  return typeof body?.error?.message === 'string' ? body.error.message : fallback
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  })
  const body = await response.json().catch(() => undefined) as T & ApiErrorBody | undefined
  if (!response.ok) {
    const error = new Error(apiError(body, '操作を完了できませんでした。')) as Error & { code?: unknown; details?: unknown }
    error.code = body?.error?.code; error.details = body?.error?.details
    throw error
  }
  return body as T
}

function EmptyState({ text }: { text: string }) { return <div className="empty-state"><span>○</span><p>{text}</p></div> }

function HomeSkeleton() {
  return <div className="home-screen home-skeleton screen-stack" aria-busy="true" aria-label="ホームデータを準備中">
    <section className="income-card"><i /><i /><div><span /><span /></div></section>
    <section className="asset-card"><span /><div><i /><i /><i /></div><b /></section>
    <section className="home-category-section"><div className="section-heading"><div><i /></div><span /></div><div className="home-skeleton-bubbles"><i /><i /><i /><i /><i /><i /></div></section>
    <section className="home-recent-section"><div className="section-heading"><div><i /></div><span /></div><div className="transaction-list"><i /><i /></div></section>
  </div>
}

function AppDialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    dialog.showModal()
    dialog.querySelector<HTMLElement>('button, [href], input, select, textarea')?.focus()
    return () => dialog.close()
  }, [])
  return <dialog ref={ref} className="app-dialog" aria-label={label} onCancel={(event) => { event.preventDefault(); onClose() }} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>{children}</dialog>
}

function BottomSheet({ label, onClose, children, mode = 'sheet' }: { label: string; onClose: () => void; children: ReactNode; mode?: 'sheet' | 'fullscreen' | 'receipt' }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.showModal()
    dialog.querySelector<HTMLElement>('button, [href], input, select, textarea')?.focus()
    return () => {
      document.body.style.overflow = previousOverflow
      dialog.close()
    }
  }, [])
  const className = mode === 'fullscreen' ? 'app-fullscreen-dialog' : mode === 'receipt' ? 'app-bottom-sheet app-receipt-sheet' : 'app-bottom-sheet'
  return <dialog ref={ref} className={className} aria-label={label} onCancel={(event) => { event.preventDefault(); onClose() }} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>{children}</dialog>
}

type LedgerHomeCache = { summary: LedgerSummary; categories: LedgerCategory[]; transactions: LedgerTransaction[]; accounts: AssetAccount[]; monthlyTarget?: MonthlyTarget }

export function LedgerApp({ userId, userName, onSignOut }: { userId: string; userName: string; onSignOut: () => Promise<void> }) {
  const [profileName, setProfileName] = useState(userName)
  const [profile, setProfile] = useState<Profile>({ ...defaultProfile, name: userName })
  const [page, setPage] = useState<Page>('home')
  const [month, setMonth] = useState(monthNow)
  const initialHomeCache = readViewCache<LedgerHomeCache>(viewCacheKey(userId, 'ledger-home', month))
  const [summary, setSummary] = useState<LedgerSummary | undefined>(() => initialHomeCache?.summary)
  const [monthlyTarget, setMonthlyTarget] = useState<MonthlyTarget | undefined>(() => initialHomeCache?.monthlyTarget)
  const [categories, setCategories] = useState<LedgerCategory[]>(() => initialHomeCache?.categories ?? [])
  const [transactions, setTransactions] = useState<LedgerTransaction[]>(() => initialHomeCache?.transactions ?? [])
  const [accounts, setAccounts] = useState<AssetAccount[]>(() => initialHomeCache?.accounts ?? [])
  const [selected, setSelected] = useState<LedgerTransaction>()
  const [editing, setEditing] = useState<LedgerTransaction>()
  const [entryType, setEntryType] = useState<'expense' | 'income'>('expense')
  const [receiptInput, setReceiptInput] = useState<{ receiptId: string; extraction?: ReceiptExtraction }>()
  const [savedReceiptItemCount, setSavedReceiptItemCount] = useState(0)
  const [notice, setNotice] = useState<Notice>()
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [loadError, setLoadError] = useState<string>()
  const refreshGeneration = useRef(0)
  const [editorKey, setEditorKey] = useState(0)

  const refresh = async () => {
    const generation = refreshGeneration.current + 1
    refreshGeneration.current = generation
    const cacheKey = viewCacheKey(userId, 'ledger-home', month)
    const cached = readViewCache<LedgerHomeCache>(cacheKey)
    if (cached) { setSummary(cached.summary); setCategories(cached.categories); setTransactions(cached.transactions); setAccounts(cached.accounts); setMonthlyTarget(cached.monthlyTarget) }
    setLoadError(undefined)
    try {
      const targetResult = request<{ targets: MonthlyTarget[] }>(`/api/planning/monthly-targets/?month=${encodeURIComponent(month)}`).catch(() => undefined)
      const [summaryResult, categoryResult, transactionResult, assetResult, target] = await Promise.all([
        request<{ summary: LedgerSummary }>(`/api/ledger/summary?month=${encodeURIComponent(month)}`),
        request<{ categories: LedgerCategory[] }>('/api/ledger/categories/'),
        request<{ transactions: LedgerTransaction[] }>(`/api/ledger/transactions/?month=${encodeURIComponent(month)}&limit=100`),
        request<{ assets: AssetSummary }>('/api/assets/accounts/?includeArchived=false'),
        targetResult,
      ])
      if (refreshGeneration.current !== generation) return
      const next = { summary: summaryResult.summary, categories: categoryResult.categories, transactions: transactionResult.transactions, accounts: assetResult.assets.accounts, monthlyTarget: target?.targets[0] }
      setSummary(next.summary); setCategories(next.categories); setTransactions(next.transactions); setAccounts(next.accounts); setMonthlyTarget(next.monthlyTarget); writeViewCache(cacheKey, next)
    } catch (error) {
      if (refreshGeneration.current === generation) {
        const text = error instanceof Error ? error.message : 'データを読み込めませんでした。'
        setLoadError(text)
        setNotice({ kind: 'error', text })
      }
    } finally { /* Home retains its static skeleton until data or the retry state is available. */ }
  }

  useEffect(() => { void refresh() }, [month, userId])
  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(undefined), 4800)
    return () => window.clearTimeout(timeout)
  }, [notice])

  function openEntry(transaction?: LedgerTransaction, receipt?: { receiptId: string; extraction?: ReceiptExtraction }) {
    setEditing(transaction); setEntryType(transaction?.type ?? 'expense'); setReceiptInput(receipt); setSelected(undefined); setEditorKey((value) => value + 1); setPage('entry')
  }

  function startNew(page: 'add' | 'entry' | 'receipt' | 'recurring', type: 'expense' | 'income' = 'expense') {
    setEditing(undefined); setReceiptInput(undefined); setEntryType(type); setSelected(undefined); setEditorKey((value) => value + 1); setPage(page)
  }

  async function saveTransaction(transaction: LedgerTransactionInput, revision?: number, idempotencyKey?: string, overrideDuplicate = false) {
    try {
      if (editing && revision) {
        await request<{ transaction: LedgerTransaction }>(`/api/ledger/transactions/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: JSON.stringify({ revision, transaction }) })
        setNotice({ kind: 'success', text: '明細を更新しました。' })
      } else {
        await request<{ transaction: LedgerTransaction }>('/api/ledger/transactions/', { method: 'POST', body: JSON.stringify({ transaction, idempotencyKey, overrideDuplicate }) })
        setNotice({ kind: 'success', text: '明細を登録しました。' })
      }
      invalidateViewCache(userId)
      const savedFromReceipt = Boolean(receiptInput)
      if (savedFromReceipt) setSavedReceiptItemCount(transaction.items.length)
      setEditing(undefined); setReceiptInput(undefined); setPage(savedFromReceipt ? 'receipt-saved' : 'history'); await refresh()
    } catch (error) {
      if ((error as { code?: unknown }).code === 'DUPLICATE_RECEIPT' && !overrideDuplicate) {
        setConfirmation({ title: '重複の可能性があります', text: '同じ日付・店舗・金額の明細がすでにあります。それでも登録しますか？', action: () => saveTransaction(transaction, revision, idempotencyKey, true) })
        return
      }
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '明細を保存できませんでした。' })
    }
  }

  async function removeTransaction(transaction: LedgerTransaction) {
    setConfirmation({ title: '明細を削除しますか？', text: '削除した明細は元に戻せません。', action: async () => {
      try {
        await request<void>(`/api/ledger/transactions/${encodeURIComponent(transaction.id)}`, { method: 'DELETE', body: JSON.stringify({ revision: transaction.revision }) })
        invalidateViewCache(userId)
        setSelected(undefined); setPage(pageAfterTransactionDelete()); setNotice({ kind: 'success', text: '明細を削除しました。' }); await refresh()
      } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : '削除できませんでした。' }) }
    } })
  }

  useEffect(() => {
    let active = true
    void request<{ profile: Profile }>('/api/profile').then((result) => {
      if (!active) return
      setProfile(result.profile)
      setProfileName(result.profile.name)
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  async function updateProfile(input: Partial<Profile>) {
    const result = await request<{ profile: Profile }>('/api/profile', { method: 'PUT', body: JSON.stringify(input) })
    setProfile(result.profile)
    setProfileName(result.profile.name)
  }

  const currentSummary = summaryForMonth(summary, month)
  const currentTransactions = transactionsForMonth(transactions, month)
  const overlayingHome = page === 'add' || page === 'receipt'

  return (
    <div className="ledger-shell">
      {(page === 'home' || overlayingHome) && <header className="ledger-topbar"><div className="ledger-brand"><p className="date-kicker">{headerDateLabel()}</p><BrandLogo /></div><div className="ledger-top-actions"><button className="top-icon" type="button" aria-label="お知らせ"><img src="/icons/bell.svg" alt="" /></button><button className="avatar" onClick={() => setPage('settings')} aria-label="設定">{profile.image ? <img className="profile-photo" src={profile.image} alt="" /> : <img src="/icons/avatar.svg" alt="" />}</button></div></header>}
      <main className="ledger-main">
        <>
            {(page === 'home' || overlayingHome) && <HomeScreen month={month} summary={currentSummary} categories={categories} target={monthlyTarget} transactions={currentTransactions} loadError={loadError} onRetry={() => void refresh()} onPage={setPage} onSelect={(transaction) => { setSelected(transaction); setPage('detail') }} />}
            {page === 'history' && <LedgerHistoryScreen month={month} setMonth={setMonth} categories={categories} onSelect={(transaction) => { setSelected(transaction); setPage('detail') }} onError={(text) => setNotice({ kind: 'error', text })} cacheScope={userId} />}
            {page === 'detail' && selected && <TransactionDetail transaction={selected} categories={categories} accounts={accounts} onClose={() => { setSelected(undefined); setPage('history') }} onEdit={() => openEntry(selected)} onDelete={() => void removeTransaction(selected)} />}
            {page === 'add' && <AddTransactionScreen onChoose={startNew} onDismiss={() => setPage(dismissOverlayPage())} />}
            {page === 'entry' && <TransactionEditor key={editorKey} categories={categories} accounts={accounts} transaction={editing} receipt={receiptInput} initialType={entryType} onCancel={() => setPage(editing ? 'history' : receiptInput ? 'receipt' : 'add')} onSave={saveTransaction} />}
            {page === 'receipt' && <ReceiptFlow onUseReceipt={(receipt) => openEntry(undefined, receipt)} onCancel={() => setPage(dismissOverlayPage())} />}
            {page === 'receipt-saved' && <ReceiptSavedScreen itemCount={savedReceiptItemCount} onContinue={() => startNew('receipt')} onClose={() => setPage('home')} />}
            {page === 'analytics' && <HistoryAnalyticsScreen month={month} setMonth={setMonth} summary={summary} categories={categories} onSelect={(transaction) => { setSelected(transaction); setPage('detail') }} cacheScope={userId} />}
            {page === 'categories' && <CategoriesScreen categories={categories} onChanged={async () => { invalidateViewCache(userId); await refresh() }} notify={setNotice} confirm={(title, text, action) => setConfirmation({ title, text, action })} />}
            {page === 'budget' && <FinanceMonthTargetScreen month={month} notify={setNotice} onChanged={async () => { invalidateViewCache(userId); await refresh() }} cacheScope={userId} />}
            {page === 'assets' && <FinanceAssetsScreen notify={setNotice} onChanged={async () => { invalidateViewCache(userId); await refresh() }} onBack={() => setPage('settings')} cacheScope={userId} />}
            {page === 'recurring' && <FinanceRecurringScreen notify={setNotice} onChanged={async () => { invalidateViewCache(userId); await refresh() }} cacheScope={userId} />}
            {page === 'settings' && <SettingsScreen userName={profileName} onPage={setPage} onSignOut={async () => {
              try {
                await onSignOut()
              } catch (error) {
                setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'ログアウトできませんでした。' })
                throw error
              }
            }} />}
            {page === 'profile' && <ProfileScreen profile={profile} onBack={() => setPage('settings')} onUpdateProfile={updateProfile} />}
        </>
      </main>
      {confirmation && <ConfirmationDialog title={confirmation.title} text={confirmation.text} onCancel={() => setConfirmation(undefined)} onConfirm={async () => { await confirmation.action(); setConfirmation(undefined) }} />}
      {notice && <div className={`toast ${notice.kind}`} role="status">{notice.text}</div>}
      {!['detail', 'entry', 'categories', 'profile', 'budget', 'assets', 'recurring', 'receipt-saved'].includes(page) && <nav className="bottom-nav" aria-label="アプリ内ナビゲーション">{pages.map((item) => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => item.id === 'entry' ? startNew('add') : setPage(item.id)}><span><img src={item.icon} alt="" /></span>{item.label}</button>)}</nav>}
    </div>
  )
}

type HomeCategory = Pick<LedgerCategory, 'id' | 'name' | 'icon' | 'color'> & { cashPaidAmount: number }
const figmaHomeCategories: Array<Pick<HomeCategory, 'name' | 'icon' | 'color'>> = [
  { name: '食費', icon: 'category-food', color: '#708779' }, { name: '日用品', icon: 'category-daily', color: '#cfb170' },
  { name: '交通費', icon: 'category-transit', color: '#c4cfdb' }, { name: '光熱費', icon: 'category-utility', color: '#d0cbd9' },
  { name: 'サブスク', icon: 'category-subscription', color: '#e5cbcd' }, { name: 'その他', icon: 'category-other', color: '#d1d1cf' },
]
export function homeCategorySlots(categories: LedgerCategory[], summaryCategories: LedgerSummary['categories']): HomeCategory[] {
  const totalsById = new Map(summaryCategories.map((category) => [category.id, category.cashPaidAmount]))
  const claimed = new Set<string>()
  const matchesReference = (category: LedgerCategory, reference: Pick<HomeCategory, 'name' | 'icon'>) => category.name === reference.name || category.icon === reference.icon || categoryIconName(category.icon, category.name) === reference.icon
  const slots = figmaHomeCategories.map((reference, index) => {
    const category = categories.find((candidate) => !claimed.has(candidate.id) && matchesReference(candidate, reference))
    if (category) { claimed.add(category.id); return { ...category, icon: categoryIconName(category.icon, category.name), cashPaidAmount: totalsById.get(category.id) ?? 0 } }
    return { id: `figma-home-${index}`, ...reference, cashPaidAmount: 0 }
  })
  for (const category of categories) {
    if (claimed.has(category.id)) continue
    const empty = slots.findIndex((slot) => slot.id.startsWith('figma-home-'))
    if (empty < 0) break
    slots[empty] = { ...category, icon: categoryIconName(category.icon, category.name), cashPaidAmount: totalsById.get(category.id) ?? 0 }
  }
  return slots
}
export function HomeScreen({ month, summary, categories, target: _target, transactions, loadError, onRetry, onPage, onSelect }: { month: string; summary?: LedgerSummary; categories: LedgerCategory[]; target?: MonthlyTarget; transactions: LedgerTransaction[]; loadError?: string; onRetry: () => void; onPage: (page: Page) => void; onSelect: (transaction: LedgerTransaction) => void }) {
  const [assetHistory, setAssetHistory] = useState<AssetBalanceHistoryPoint[]>([])
  const [assetComparison, setAssetComparison] = useState<AssetBalanceHistory['monthlyComparison']>()
  useEffect(() => { let active = true; void request<AssetBalanceHistory>('/api/assets/history').then((result) => { if (active) { setAssetHistory(result.history); setAssetComparison(result.monthlyComparison) } }).catch(() => { if (active) { setAssetHistory([]); setAssetComparison(undefined) } }); return () => { active = false } }, [])
  if (!summary) return loadError
    ? <div className="screen-stack"><section className="home-data-state" aria-live="polite"><p className="inline-error" role="alert">{loadError}</p><button className="button secondary" onClick={onRetry}>再読み込み</button></section></div>
    : <HomeSkeleton />
  const income = summary.incomeCashPaidAmount; const expense = summary.expenseCashPaidAmount
  const expenseCategories = homeCategorySlots(categories, summary.categories)
  const { balance: latestAsset, delta: assetDelta } = homeAssetValues(summary, assetComparison)
  return <div className="home-screen screen-stack">
    <section className="income-card"><div className="income-heading"><p>今月の収支</p><small>{monthRangeLabel(month)}</small></div><h1>{income - expense >= 0 ? '+' : '−'} {yen(Math.abs(income - expense))}</h1><div className="income-breakdown"><span><i aria-hidden="true">↑</i><small>収入</small><b>{yen(income)}</b></span><span><i aria-hidden="true">↓</i><small>支出</small><b>{yen(expense)}</b></span></div></section>
    <button className="asset-card" onClick={() => onPage('assets')}><span><img src="/icons/wallet.svg" alt="" /></span><div><small>総資産 <img className="asset-eye" src="/icons/eye.svg" alt="" /></small><strong>{yen(latestAsset)}</strong><small className="asset-change">{assetDelta >= 0 ? '+' : '−'} {yen(Math.abs(assetDelta))}　前月比</small></div><AssetSparkline history={assetHistory} /><img className="row-chevron" src="/icons/chevron-right.svg" alt="" /></button>
    <section className="home-category-section"><div className="section-heading"><div><h2>カテゴリ別の支出</h2></div><button onClick={() => onPage('analytics')}>すべて見る <img src="/icons/chevron-right.svg" alt="" /></button></div><ExpenseBubbles items={expenseCategories.map((category) => ({ id: category.id, label: category.name, amount: category.cashPaidAmount, icon: category.icon, color: category.color }))} onSelect={() => onPage('analytics')} /></section>
    <section className="home-recent-section"><div className="section-heading"><div><h2>最近の収支</h2></div><button onClick={() => onPage('history')}>すべて見る <img src="/icons/chevron-right.svg" alt="" /></button></div>{transactions.length ? <TransactionRows transactions={transactions.slice(0, 2)} categoriesById={new Map(categories.map((category) => [category.id, category]))} onSelect={onSelect} /> : <EmptyState text="最初の明細を登録しましょう。" />}</section>
  </div>
}

function categoryIconName(icon: string, name: string) { return ({ utensils: 'category-food', 'shopping-bag': 'category-daily', train: 'category-transit', zap: 'category-utility', 'repeat-2': 'category-subscription', 'more-horizontal': 'category-other', 'category-food': 'category-food', 'category-daily': 'category-daily', 'category-transit': 'category-transit', 'category-utility': 'category-utility', 'category-subscription': 'category-subscription', 'category-other': 'category-other' } as Record<string, string>)[icon] ?? ({ 食費: 'category-food', 日用品: 'category-daily', 交通費: 'category-transit', 光熱費: 'category-utility', サブスク: 'category-subscription', その他: 'category-other' } as Record<string, string>)[name] ?? 'category-food' }
function AssetSparkline({ history }: { history: AssetBalanceHistoryPoint[] }) { if (history.length < 2) return null; const values = history.map((point) => point.balanceAmount); const min = Math.min(...values); const range = Math.max(1, Math.max(...values) - min); const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${34 - ((value - min) / range) * 30}`).join(' '); return <svg className="asset-sparkline" viewBox="0 0 100 40" role="img" aria-label={`資産残高の推移。現在 ${yen(values.at(-1) ?? 0)}`}><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg> }

function TransactionRows({ transactions, categoriesById = new Map(), onSelect, grouped = false }: { transactions: LedgerTransaction[]; categoriesById?: Map<string, LedgerCategory>; onSelect: (transaction: LedgerTransaction) => void; grouped?: boolean }) {
  let lastDate = ''
  return <div className="transaction-list">{transactions.map((transaction) => { const heading = grouped && transaction.occurredAt !== lastDate ? (lastDate = transaction.occurredAt, <p className="date-heading" key={`${transaction.id}-date`}>{dateLabel(transaction.occurredAt)}</p>) : null; const category = transaction.items[0] ? categoriesById.get(transaction.items[0].categoryId) : undefined; const iconName = transaction.type === 'income' ? 'category-other' : category ? categoryIconName(category.icon, category.name) : 'category-food'; return <div key={transaction.id}>{heading}<button className="transaction-row" onClick={() => onSelect(transaction)}><span className={`row-icon ${transaction.type}`}><img src={`/icons/${iconName}.svg`} alt="" /></span><span><b>{transaction.title}</b><small>{transaction.merchant || transaction.paymentMethod || '未設定'}</small></span><strong className={transaction.type}>{transaction.type === 'income' ? '+' : '−'} {yen(transaction.cashPaidAmount)}</strong><img className="row-chevron" src="/icons/chevron-right.svg" alt="" /></button></div> })}</div>
}

function AddTransactionScreen({ onChoose, onDismiss }: { onChoose: (page: 'add' | 'entry' | 'receipt' | 'recurring', type?: 'expense' | 'income') => void; onDismiss: () => void }) {
  return <BottomSheet label="新規登録" onClose={onDismiss}><section className="add-screen"><button type="button" className="sheet-close" onClick={onDismiss} aria-label="閉じる">閉じる</button><span className="sheet-handle" /><h1>新規登録</h1><p>登録方法を選択してください。</p><div className="add-options"><button onClick={() => onChoose('receipt')}><span className="add-option-icon receipt"><img src="/icons/category-other.svg" alt="" /></span><b>レシート</b><small>レシートを撮影して自動で読み取ります</small></button><button onClick={() => onChoose('entry', 'expense')}><span className="add-option-icon expense"><img src="/icons/category-daily.svg" alt="" /></span><b>手動入力</b><small>自分で金額や内容を入力します</small></button><button onClick={() => onChoose('recurring')}><span className="add-option-icon recurring"><img src="/icons/category-subscription.svg" alt="" /></span><b>定期支出</b><small>毎月の支出を自動で登録します</small></button><button onClick={() => onChoose('entry', 'income')}><span className="add-option-icon income"><img src="/icons/category-other.svg" alt="" /></span><b>収入</b><small>給与や臨時収入などを登録できます</small></button></div></section></BottomSheet>
}

export function ScreenTitle({ title, onBack, rightAction }: { title: string; onBack?: () => void; rightAction?: ReactNode }) { return <div className="screen-title">{onBack ? <button type="button" className="plain-button screen-back" onClick={onBack} aria-label="戻る"><img src="/icons/chevron-left.svg" alt="" /></button> : <span className="screen-title-spacer" />}<h1>{title}</h1>{rightAction ?? <span className="screen-title-spacer" />}</div> }

function TransactionEditor({ categories, accounts, transaction, receipt, initialType, onCancel, onSave }: { categories: LedgerCategory[]; accounts: AssetAccount[]; transaction?: LedgerTransaction; receipt?: { receiptId: string; extraction?: ReceiptExtraction }; initialType: 'expense' | 'income'; onCancel: () => void; onSave: (input: LedgerTransactionInput, revision?: number, idempotencyKey?: string) => Promise<void> }) {
  const extraction = receipt?.extraction
  const [type, setType] = useState<'expense' | 'income'>(transaction?.type ?? initialType)
  const [title, setTitle] = useState(transaction?.title ?? extraction?.merchant ?? '')
  const [merchant, setMerchant] = useState(transaction?.merchant ?? extraction?.merchant ?? '')
  const [occurredAt, setOccurredAt] = useState(transaction?.occurredAt ?? (receipt ? extraction?.purchasedAt ?? '' : dateNow()))
  const [paymentMethod, setPaymentMethod] = useState(transaction?.paymentMethod ?? '')
  const [accountId, setAccountId] = useState(transaction?.accountId ?? '')
  const [giftAccountId, setGiftAccountId] = useState(transaction?.giftAccountId ?? '')
  const [memo, setMemo] = useState(transaction?.memo ?? '')
  const fallbackCategory = categories[0]?.id ?? ''
  const [items, setItems] = useState<EditorItem[]>(() => transaction?.items.map((item) => ({ id: item.id, name: item.name, originalAmount: item.originalAmount, discountAmount: item.itemDiscountAmount, categoryId: item.categoryId, utilityKind: item.utilityKind ?? undefined })) ?? extraction?.items.map((item) => ({ name: item.name, originalAmount: item.amount ?? 0, discountAmount: 0, categoryId: fallbackCategory })) ?? [{ name: '', originalAmount: 0, discountAmount: 0, categoryId: fallbackCategory }])
  const [receiptDiscountAmount, setReceiptDiscountAmount] = useState(transaction?.receiptDiscountAmount ?? 0)
  const [pointUsedAmount, setPointUsedAmount] = useState(transaction?.pointUsedAmount ?? 0)
  const [giftCertificateUsedAmount, setGiftCertificateUsedAmount] = useState(transaction?.giftCertificateUsedAmount ?? 0)
  const [inlineError, setInlineError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [stage, setStage] = useState<'basic' | 'review'>(transaction || receipt ? 'review' : 'basic')
  const [addingItem, setAddingItem] = useState(false)
  const idempotencyKey = useRef(crypto.randomUUID())
  useEffect(() => {
    if (!accountId) {
      const preferred = accounts.find((account) => account.type === 'cash') ?? accounts.find((account) => account.type === 'bank')
      if (preferred) setAccountId(preferred.id)
    }
  }, [accounts, accountId])
  useEffect(() => {
    if (giftCertificateUsedAmount > 0 && !giftAccountId) {
      const gift = accounts.find((account) => account.type === 'gift')
      if (gift) setGiftAccountId(gift.id)
    }
  }, [accounts, giftAccountId, giftCertificateUsedAmount])
  const calculation = useMemo(() => { try { return calculateTransaction({ items, receiptDiscountAmount, pointUsedAmount, giftCertificateUsedAmount }) } catch (error) { return error instanceof MoneyCalculationError ? error : undefined } }, [items, receiptDiscountAmount, pointUsedAmount, giftCertificateUsedAmount])
  const totals = calculation instanceof Error ? undefined : calculation?.totals

  function updateItem(index: number, key: 'name' | 'categoryId' | 'originalAmount' | 'discountAmount' | 'utilityKind', value: string) { setItems((previous) => previous.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: key === 'name' || key === 'categoryId' || key === 'utilityKind' ? value || undefined : Math.max(0, Number(value) || 0) } : item)) }
  function goToReview(event: FormEvent) { event.preventDefault(); if (!title.trim()) { setInlineError(type === 'expense' ? '店舗名または内容を入力してください。' : '収入の内容を入力してください。'); return }; setInlineError(undefined); setStage('review') }
  async function submit(event: FormEvent) { event.preventDefault(); if (calculation instanceof Error || !totals) { setInlineError(calculation instanceof Error ? calculation.message : '入力内容を確認してください。'); return }; if (!title.trim()) { setInlineError('タイトルを入力してください。'); return }; setInlineError(undefined); setSaving(true); try { await onSave({ receiptId: receipt?.receiptId ?? transaction?.receiptId, accountId: accountId || null, giftAccountId: giftAccountId || null, type, occurredAt, title, merchant, memo, paymentMethod, receiptDiscountAmount, pointUsedAmount, giftCertificateUsedAmount, items }, transaction?.revision, idempotencyKey.current) } finally { setSaving(false) } }

  return <form className={`entry-form screen-stack entry-${stage}`} onSubmit={stage === 'basic' ? goToReview : submit}>
    <ScreenTitle title={transaction ? '明細を編集' : receipt ? 'レシートを確認' : type === 'income' ? '収入を入力' : stage === 'basic' ? '手動で入力' : '商品を追加'} onBack={stage === 'review' && !transaction && !receipt ? () => setStage('basic') : onCancel} />
    {receipt && <p className="form-note">{receipt.extraction ? 'OCR結果は下書きです。内容を確認・編集してから登録してください。' : '画像は保存されています。内容を手入力してから登録してください。'}</p>}
    {stage === 'basic' ? <>
      {!receipt && <div className="segmented"><button type="button" className={type === 'expense' ? 'active expense' : ''} onClick={() => setType('expense')}>支出</button><button type="button" className={type === 'income' ? 'active income' : ''} onClick={() => setType('income')}>収入</button></div>}
      <section className="entry-basic-fields"><label>{type === 'expense' ? '店舗名' : '内容'}<input value={title} onChange={(event) => setTitle(event.target.value)} required placeholder={type === 'expense' ? '例）カフェ' : '例）給与'} /></label><label>日付<input type="date" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} required /></label><label>カテゴリ<select value={items[0]?.categoryId ?? fallbackCategory} onChange={(event) => setItems((previous) => previous.map((item, index) => index === 0 ? { ...item, categoryId: event.target.value } : item))}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>支払い方法<input value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} placeholder="現金・カードなど" /></label><label>メモ（任意）<textarea value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="例）日用品のまとめ買い" /></label></section>
      {inlineError && <p className="inline-error" role="alert">{inlineError}</p>}
      <button className={`primary-action entry-fixed-action ${type === 'expense' ? 'expense-action' : ''}`} type="submit">次へ</button>
    </> : <>
      <section className="entry-summary"><h2>基本情報</h2><button type="button" onClick={() => setStage('basic')}>編集</button><dl><div><dt>店舗名</dt><dd>{title}</dd></div><div><dt>日付</dt><dd>{occurredAt || '未入力'}</dd></div><div><dt>支払い方法</dt><dd>{paymentMethod || '未設定'}</dd></div></dl></section>
      <div className="form-grid"><label>支払い口座<select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">指定しない</option>{accounts.filter((account) => account.type !== 'gift').map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>{type === 'expense' && <label>商品券口座<select value={giftAccountId} onChange={(event) => setGiftAccountId(event.target.value)}><option value="">使用しない</option>{accounts.filter((account) => account.type === 'gift').map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>}</div>
      <section className="line-items"><div className="section-heading"><h2>購入した商品</h2><span>{items.length}件</span></div>{items.map((item, index) => { const utility = categories.find((category) => category.id === item.categoryId)?.name === '光熱費'; return <div className="item-editor" key={item.id ?? index}><input aria-label={`品名 ${index + 1}`} value={item.name} onChange={(event) => updateItem(index, 'name', event.target.value)} placeholder="品名" /><input aria-label={`金額 ${index + 1}`} value={item.originalAmount || ''} type="number" min="0" inputMode="numeric" onChange={(event) => updateItem(index, 'originalAmount', event.target.value)} placeholder="金額" /><select aria-label={`カテゴリ ${index + 1}`} value={item.categoryId} onChange={(event) => updateItem(index, 'categoryId', event.target.value)}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>{utility && <select aria-label={`光熱費内訳 ${index + 1}`} value={item.utilityKind ?? ''} onChange={(event) => updateItem(index, 'utilityKind', event.target.value)}><option value="">内訳を選択</option><option value="electricity">電気</option><option value="gas">ガス</option><option value="water">水道</option><option value="other">その他</option></select>}<input aria-label={`値引き ${index + 1}`} value={item.discountAmount || ''} type="number" min="0" inputMode="numeric" onChange={(event) => updateItem(index, 'discountAmount', event.target.value)} placeholder="値引き" />{items.length > 1 && <button type="button" className="delete-line" onClick={() => setItems((previous) => previous.filter((_, itemIndex) => itemIndex !== index))}>削除</button>}</div> })}<button type="button" className="item-add-button" onClick={() => setAddingItem(true)}>商品を追加</button></section>
      {type === 'expense' && <section className="form-grid"><label>レシート値引き<input type="number" min="0" value={receiptDiscountAmount || ''} onChange={(event) => setReceiptDiscountAmount(Math.max(0, Number(event.target.value) || 0))} /></label><label>ポイント利用<input type="number" min="0" value={pointUsedAmount || ''} onChange={(event) => setPointUsedAmount(Math.max(0, Number(event.target.value) || 0))} /></label><label>商品券利用<input type="number" min="0" value={giftCertificateUsedAmount || ''} onChange={(event) => setGiftCertificateUsedAmount(Math.max(0, Number(event.target.value) || 0))} /></label></section>}
      {totals && <div className="total-box"><span>合計金額</span><strong>{yen(totals.cashPaidAmount)}</strong><small>値引き {yen(totals.discountAmount)} / 非現金 {yen(totals.nonCashAmount)}</small></div>}
      {inlineError && <p className="inline-error" role="alert">{inlineError}</p>}
      <button className={`primary-action entry-fixed-action ${type === 'expense' ? 'expense-action' : ''}`} type="submit" disabled={saving}>{saving ? '保存中…' : transaction ? '変更を保存' : 'この内容で登録する'}</button>
    </>}
    {addingItem && <ItemAddDialog categories={categories} fallbackCategory={fallbackCategory} onClose={() => setAddingItem(false)} onAdd={(item) => { setItems((previous) => [...previous, item]); setAddingItem(false) }} />}
  </form>
}

function ItemAddDialog({ categories, fallbackCategory, onClose, onAdd }: { categories: LedgerCategory[]; fallbackCategory: string; onClose: () => void; onAdd: (item: EditorItem) => void }) { const [name, setName] = useState(''); const [amount, setAmount] = useState(''); const [categoryId, setCategoryId] = useState(fallbackCategory); const valid = name.trim().length > 0 && Number(amount) >= 0; function add() { if (!valid) return; onAdd({ name, originalAmount: Math.max(0, Number(amount) || 0), discountAmount: 0, categoryId }) } return <BottomSheet label="商品を追加" onClose={onClose}><section className="item-add-dialog"><ScreenTitle title="商品を追加" onBack={onClose} /><label>商品名<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例）サントリー天然水 2L" /></label><label>金額<input value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min="0" inputMode="numeric" /></label><label>カテゴリ<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><button className="primary-action" type="button" disabled={!valid} onClick={add}>追加する</button></section></BottomSheet> }

export function appendReceiptFiles(existing: readonly File[], added: readonly File[]) { return [...existing, ...added].slice(0, 6) }
export function receiptPageAfterAdd(currentLength: number) { return Math.max(0, currentLength) }
export function receiptPageAfterRemove(currentLength: number, activeIndex: number) { return Math.max(0, Math.min(activeIndex, currentLength - 2)) }
export function receiptUploadFormData(files: readonly File[]) { const form = new FormData(); files.forEach((file) => form.append('images', file)); return form }
export function receiptPageStatusText(page: OcrPageStatus) { return page.status === 'analyzed' ? `${page.pageIndex + 1}枚目を読み取りました。` : `${page.pageIndex + 1}枚目を読み取れませんでした。${page.errorMessage ? `${page.errorMessage}` : ''}` }
function ReceiptFlow({ onUseReceipt, onCancel }: { onUseReceipt: (receipt: { receiptId: string; extraction?: ReceiptExtraction }) => void; onCancel: () => void }) {
  const [files, setFiles] = useState<File[]>([]); const [previews, setPreviews] = useState<string[]>([]); const [activePage, setActivePage] = useState(0); const [error, setError] = useState<string>(); const [failedReceiptId, setFailedReceiptId] = useState<string>(); const [pageStatuses, setPageStatuses] = useState<OcrPageStatus[]>([]); const [result, setResult] = useState<{ receiptId: string; extraction: ReceiptExtraction }>(); const [phase, setPhase] = useState<'capture' | 'review' | 'analyzing' | 'result'>('capture'); const generation = useRef(0)
  useEffect(() => { const urls = files.map((file) => URL.createObjectURL(file)); setPreviews(urls); return () => urls.forEach((url) => URL.revokeObjectURL(url)) }, [files])
  function addFiles(added: readonly File[], moveToReview = true) { generation.current += 1; if (!added.length) return; const next = appendReceiptFiles(files, added); setFiles(next); setActivePage(receiptPageAfterAdd(files.length)); if (moveToReview) setPhase('review'); setError(next.length < files.length + added.length ? 'レシート画像は6枚まで追加できます。' : undefined); setFailedReceiptId(undefined); setPageStatuses([]); setResult(undefined) }
  function removePage(index: number) { generation.current += 1; if (files.length <= 1) { setFiles([]); setActivePage(0); setPhase('capture'); return }; setFiles((previous) => previous.filter((_, page) => page !== index)); setActivePage(receiptPageAfterRemove(files.length, index)); setError(undefined); setFailedReceiptId(undefined); setPageStatuses([]) }
  const file = files[activePage]; const preview = previews[activePage]
  function goBack() { generation.current += 1; if (phase === 'capture') { onCancel(); return }; if (phase === 'review') { setPhase('capture'); return }; setPhase('review') }
  function applyOcrResponse(response: Response, payload: OcrResponse | undefined, receiptId: string | undefined, current: number) { if (generation.current !== current) return; const statuses = payload?.pages ?? []; setPageStatuses(statuses); if (receiptId) setFailedReceiptId(receiptId); if (payload?.receipt && receiptId) { setResult({ receiptId, extraction: payload.receipt }); setPhase('result'); return } const invalidImage = payload?.error?.code === 'INVALID_IMAGE' || payload?.error?.code === 'INVALID_MULTIPART'; setError(invalidImage ? apiError(payload, '画像の形式または内容を確認してください。') : receiptId ? '一部またはすべての画像を読み取れませんでした。ページごとの結果を確認して再試行してください。' : 'レシートの読み取りを開始できませんでした。画像を確認して再試行してください。'); setPhase('review') }
  async function read() { if (!files.length) return; const current = generation.current + 1; generation.current = current; setPhase('analyzing'); setError(undefined); setFailedReceiptId(undefined); setPageStatuses([]); try { const response = await fetch('/api/ocr/receipt', { method: 'POST', body: receiptUploadFormData(files) }); const payload = await response.json().catch(() => undefined) as OcrResponse | undefined; applyOcrResponse(response, payload, typeof payload?.receiptId === 'string' ? payload.receiptId : undefined, current) } catch { if (generation.current === current) { setError('通信に失敗しました。接続を確認して再試行してください。'); setPhase('review') } } }
  async function retrySavedDraft(allPages = false) { const receiptId = failedReceiptId; if (!receiptId) return; const current = generation.current + 1; generation.current = current; setPhase('analyzing'); setError(undefined); try { const response = await fetch(receiptRetryUrl(receiptId), { method: 'POST', headers: { accept: 'application/json', ...(allPages ? { 'content-type': 'application/json' } : {}) }, credentials: 'same-origin', body: allPages ? JSON.stringify({ allPages: true }) : undefined }); const payload = await response.json().catch(() => undefined) as OcrResponse | undefined; applyOcrResponse(response, payload, receiptId, current) } catch { if (generation.current === current) { setError('通信に失敗しました。接続を確認して再試行してください。'); setPhase('review') } } }
  const failedPages = pageStatuses.filter((page) => page.status === 'failed')
  return <BottomSheet label="レシートを撮影" onClose={goBack} mode="receipt"><section className="receipt-flow screen-stack" data-phase={phase}>
    <ScreenTitle title={phase === 'capture' ? 'レシートを撮影' : phase === 'review' ? '撮影した画像' : phase === 'analyzing' ? '' : '読み取り結果'} onBack={phase === 'capture' ? undefined : goBack} rightAction={phase === 'result' ? <button type="button" className="text-action" onClick={() => onUseReceipt(result!)}>編集</button> : undefined} />
    {phase === 'capture' && <><ReceiptCamera onCapture={(file) => addFiles([file])} onFallbackFiles={addFiles} onCancel={() => { if (files.length) setPhase('review'); else onCancel() }} /><p className="receipt-tip"><b>きれいに読み取るコツ</b><br />・明るい場所で撮影してください<br />・レシート全体が枠に収まるようにしてください<br />・長いレシートは複数回に分けて撮影できます</p></>}
    {phase === 'review' && <><div className="receipt-preview">{preview && <img src={preview} alt={`選択したレシート ${activePage + 1}枚目`} />}</div><div className="receipt-pages"><b>{activePage + 1}/{files.length}</b><div>{previews.map((url, index) => <button type="button" className={index === activePage ? 'active' : ''} key={url} onClick={() => setActivePage(index)} aria-label={`レシート ${index + 1}枚目を表示`}><img src={url} alt="" />{files.length > 1 && <span className="receipt-page-delete" onClick={(event) => { event.stopPropagation(); removePage(index) }}>×</span>}</button>)}<button type="button" className="receipt-continue-capture" onClick={() => setPhase('capture')}><span>＋</span><small>続けて撮影</small></button></div><p>長いレシートは複数回に分けて撮影できます。追加した画像はすべて順番に読み取ります。</p></div>{error && <div className="inline-error" role="alert"><p>{error}</p>{failedReceiptId && <p><a href={`/api/receipts/${encodeURIComponent(failedReceiptId)}/image`}>保存済みの元画像を開く</a></p>}</div>}{pageStatuses.length > 0 && <ul className="receipt-page-statuses" aria-label="ページ別の読み取り結果">{pageStatuses.map((page) => <li className={page.status} key={page.pageIndex}>{receiptPageStatusText(page)}</li>)}</ul>}{failedReceiptId && <div className="receipt-retry-actions"><button type="button" className="button secondary" onClick={() => void retrySavedDraft()}>失敗したページを再読み取り</button>{files.length > 1 && <button type="button" className="button secondary" onClick={() => void retrySavedDraft(true)}>すべてのページを再読み取り</button>}<button type="button" className="button secondary" onClick={() => onUseReceipt({ receiptId: failedReceiptId })}>手入力で明細を作成</button></div>}<button className="primary-action entry-fixed-action" type="button" disabled={!files.length} onClick={() => void read()}>この写真で読み取る</button></>}
    {phase === 'analyzing' && <div className="receipt-analysis" role="status"><span className="receipt-ocr-mark">☷</span><h2>データを読み取っています</h2><p>しばらくお待ちください</p><ul><li>画像を解析中</li><li>文字を認識中</li><li>商品情報を抽出中</li><li>カテゴリを判定</li><li>結果を整理</li></ul><button type="button" className="text-action" onClick={goBack}>キャンセル</button></div>}
    {phase === 'result' && result && <>{failedPages.length > 0 && <section className="receipt-partial-result" aria-live="polite"><b>{failedPages.length}枚の画像を読み取れませんでした</b><ul>{failedPages.map((page) => <li key={page.pageIndex}>{receiptPageStatusText(page)}</li>)}</ul><button type="button" className="button secondary" onClick={() => { setPhase('review') }}>再試行する</button></section>}<section className="receipt-analysis-summary"><div className="receipt-analysis-image">{preview && <img src={preview} alt="読み取ったレシート" />}</div><div><b>{result.extraction.merchant || '未取得'}</b><small>{result.extraction.purchasedAt || '日付未取得'}</small><strong>合計 {result.extraction.total == null ? '未取得' : yen(result.extraction.total)}</strong></div></section><dl className="receipt-analysis-fields"><div><dt>カテゴリ</dt><dd>未設定</dd></div><div><dt>支払い方法</dt><dd>未設定</dd></div><div><dt>メモ</dt><dd>—</dd></div></dl><section className="receipt-result-summary"><h2>検出した商品 <small>{result.extraction.items.length}商品</small></h2>{result.extraction.items.map((item, index) => <span key={`${item.name}-${index}`}><b>{item.name || '名称未取得'}</b><strong>{item.amount == null ? '未取得' : yen(item.amount)}</strong></span>)}</section><button className="primary-action entry-fixed-action" type="button" onClick={() => onUseReceipt(result)}>この内容で登録する</button></>}
  </section></BottomSheet>
}

function ReceiptSavedScreen({ itemCount, onContinue, onClose }: { itemCount: number; onContinue: () => void; onClose: () => void }) {
  return <section className="receipt-saved-screen screen-stack"><div className="receipt-result-mark"><span>✓</span></div><h1>登録しました</h1><p>{itemCount}件の商品を追加しました</p><div className="receipt-saved-actions"><button type="button" className="button secondary" onClick={onContinue}>続けて登録</button><button type="button" className="primary-action" onClick={onClose}>閉じる</button></div></section>
}


const categoryIconChoices = ['category-food', 'category-daily', 'category-transit', 'category-utility', 'category-subscription', 'category-other']
const categoryColorChoices = ['#819a8b', '#bd8384', '#d4a16d', '#908ab0', '#6e9eb2', '#a5a59e', '#77997e', '#d0a1a4', '#b6a789', '#939998']

function CategoriesScreen({ categories, onChanged, notify, confirm }: { categories: LedgerCategory[]; onChanged: () => Promise<void>; notify: (value: Notice) => void; confirm: (title: string, text: string, action: () => Promise<void>) => void }) {
  const [draft, setDraft] = useState<Pick<LedgerCategory, 'name' | 'color' | 'icon'> & { id?: string }>({ name: '', color: categoryColorChoices[0], icon: categoryIconChoices[0] })
  const [editing, setEditing] = useState(false); const [saving, setSaving] = useState(false); const [kind, setKind] = useState<'expense' | 'income'>('expense'); const [editMode, setEditMode] = useState(false); const tabsId = useId()
  function begin(category?: LedgerCategory) { setDraft(category ? { id: category.id, name: category.name, color: category.color, icon: category.icon } : { name: '', color: categoryColorChoices[0], icon: categoryIconChoices[0] }); setEditing(true) }
  async function save(event: FormEvent) { event.preventDefault(); if (!draft.name.trim()) return; setSaving(true); try { if (draft.id) await request(`/api/ledger/categories/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body: JSON.stringify({ name: draft.name.trim(), color: draft.color, icon: draft.icon }) }); else await request('/api/ledger/categories/', { method: 'POST', body: JSON.stringify({ name: draft.name.trim(), color: draft.color, icon: draft.icon }) }); await onChanged(); notify({ kind: 'success', text: draft.id ? 'カテゴリを更新しました。' : 'カテゴリを追加しました。' }); setEditing(false) } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : '保存できませんでした。' }) } finally { setSaving(false) } }
  function remove(category: LedgerCategory) { confirm(`「${category.name}」を削除しますか？`, 'このカテゴリの明細は「その他」へ移されます。', async () => { try { await request(`/api/ledger/categories/${encodeURIComponent(category.id)}`, { method: 'DELETE' }); await onChanged(); notify({ kind: 'success', text: 'カテゴリを削除しました。' }) } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : '削除できませんでした。' }) } }) }
  if (editing) return <form className="category-edit screen-stack" onSubmit={save}><ScreenTitle title={draft.id ? 'カテゴリを編集' : 'カテゴリの追加'} onBack={() => setEditing(false)} /><div className="category-icon-preview" style={{ backgroundColor: draft.color }}><img src={`/icons/${categoryIconName(draft.icon, draft.name)}.svg`} alt="選択中のアイコン" /></div><p className="category-picker-label">アイコンを選択</p><div className="category-icon-grid">{categoryIconChoices.map((icon) => <button type="button" className={draft.icon === icon ? 'selected' : ''} key={icon} onClick={() => setDraft({ ...draft, icon })}><img src={`/icons/${icon}.svg`} alt="" /></button>)}</div><label className="category-name-field">カテゴリ名<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例）書籍" maxLength={40} required /></label><p className="category-picker-label">アイコンの色</p><div className="category-color-grid">{categoryColorChoices.map((color) => <button type="button" className={draft.color === color ? 'selected' : ''} style={{ backgroundColor: color }} key={color} onClick={() => setDraft({ ...draft, color })} aria-label={`${color}を選択`}><span>選択中</span></button>)}</div><div className="category-fixed-actions">{draft.id && !categories.find((category) => category.id === draft.id)?.isDefault && <button className="outline-danger" type="button" onClick={() => remove(categories.find((category) => category.id === draft.id)!)}>このカテゴリを削除</button>}<button className="primary-action" disabled={saving}>{saving ? '保存中…' : draft.id ? '保存する' : 'カテゴリを追加'}</button></div></form>
  const incomeNames = new Set(['給与', '副収入']); const filtered = categories.filter((category) => kind === 'income' ? incomeNames.has(category.name) : !incomeNames.has(category.name))
  const selectTab = (next: 'expense' | 'income', focus = false) => { setKind(next); if (focus) document.getElementById(`${tabsId}-${next}`)?.focus() }
  const handleTabKey = (event: React.KeyboardEvent<HTMLButtonElement>) => { if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); selectTab(kind === 'expense' ? 'income' : 'expense', true) } if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); selectTab(kind === 'expense' ? 'income' : 'expense', true) } if (event.key === 'Home') { event.preventDefault(); selectTab('expense', true) } if (event.key === 'End') { event.preventDefault(); selectTab('income', true) } }
  return <section className="categories-screen screen-stack"><ScreenTitle title="カテゴリ管理" rightAction={<button type="button" className="text-action" onClick={() => setEditMode((value) => !value)}>{editMode ? '完了' : '編集'}</button>} /><div className="category-tabs" role="tablist" aria-label="カテゴリ種別"><button id={`${tabsId}-expense`} type="button" role="tab" aria-selected={kind === 'expense'} aria-controls={`${tabsId}-panel`} tabIndex={kind === 'expense' ? 0 : -1} className={kind === 'expense' ? 'active' : ''} onKeyDown={handleTabKey} onClick={() => selectTab('expense')}>支出カテゴリ</button><button id={`${tabsId}-income`} type="button" role="tab" aria-selected={kind === 'income'} aria-controls={`${tabsId}-panel`} tabIndex={kind === 'income' ? 0 : -1} className={kind === 'income' ? 'active' : ''} onKeyDown={handleTabKey} onClick={() => selectTab('income')}>収入カテゴリ</button></div><div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${kind}`} className="category-list">{filtered.map((category) => <div key={category.id}><button type="button" className="category-list-row" onClick={() => begin(category)}><span className="category-dot" style={{ backgroundColor: category.color }}><img src={`/icons/${categoryIconName(category.icon, category.name)}.svg`} alt="" /></span><b>{category.name}</b><img className="row-chevron" src="/icons/chevron-right.svg" alt="" /></button>{editMode && !category.isDefault && <button className="category-delete" type="button" onClick={() => remove(category)}>削除</button>}</div>)}{filtered.length === 0 && <EmptyState text={`${kind === 'income' ? '収入' : '支出'}カテゴリはまだありません。`} />}</div><button type="button" className="primary-action entry-fixed-action" onClick={() => begin()}>{kind === 'income' ? '収入カテゴリを追加' : 'カテゴリを追加'}</button></section>
}

function SettingsScreen({ userName, onPage, onSignOut }: { userName: string; onPage: (page: Page) => void; onSignOut: () => Promise<void> }) {
  const [signingOut, setSigningOut] = useState(false)
  async function signOut() { setSigningOut(true); try { await onSignOut() } catch { /* LedgerApp keeps this page visible and shows the error toast. */ } finally { setSigningOut(false) } }
  const chevron = <img className="row-chevron" src="/icons/chevron-right.svg" alt="" />
  const row = (label: string, icon: string, page?: Page) => page ? <button type="button" onClick={() => onPage(page)}><img className="settings-icon" src={icon} alt="" /><span>{label}</span>{chevron}</button> : <div><img className="settings-icon" src={icon} alt="" /><span>{label}</span>{chevron}</div>
  return <div className="settings-screen screen-stack"><h1 className="settings-title">設定</h1><div className="settings-list"><button type="button" className="settings-profile-row" onClick={() => onPage('profile')}><span className="settings-avatar"><img src="/icons/avatar.svg" alt="" /></span><span><b>{userName}</b><small>プロフィールを編集</small></span>{chevron}</button><div className="settings-group">{row('アカウント', '/icons/user.svg', 'profile')}{row('カテゴリ管理', '/icons/folder.svg', 'categories')}{row('予算・目標設定', '/icons/yen.svg', 'budget')}{row('銀行口座設定', '/icons/bank.svg', 'assets')}</div><div className="settings-group">{row('アプリ設定', '/icons/settings.svg')}{row('ヘルプ', '/icons/help.svg')}</div><div className="settings-group"><button type="button" className="danger" onClick={() => void signOut()} disabled={signingOut}><img className="settings-icon" src="/icons/logout.svg" alt="" /><span>{signingOut ? 'ログアウト中…' : 'ログアウト'}</span>{chevron}</button></div></div></div>
}

async function profileImageDataUrl(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('JPEG、PNG、WebP形式の画像を選択してください。')
  const source = await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => { URL.revokeObjectURL(url); resolve(image) }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした。')) }
    image.src = url
  })
  const scale = Math.min(1, 512 / Math.max(source.naturalWidth, source.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(source.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(source.naturalHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('画像を処理できませんでした。')
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.82)
}

function ProfileScreen({ profile, onBack, onUpdateProfile }: { profile: Profile; onBack: () => void; onUpdateProfile: (input: Partial<Profile>) => Promise<void> }) {
  const [name, setName] = useState(profile.name); const [memo, setMemo] = useState(profile.memo === 'めもめも' ? '' : profile.memo); const [theme, setTheme] = useState<ProfileTheme>(profile.theme); const [image, setImage] = useState<string | null>(profile.image); const [saving, setSaving] = useState(false); const [error, setError] = useState<string>()
  useEffect(() => { setName(profile.name); setMemo(profile.memo === 'めもめも' ? '' : profile.memo); setTheme(profile.theme); setImage(profile.image) }, [profile])
  async function chooseImage(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (!file) return; try { setError(undefined); setImage(await profileImageDataUrl(file)) } catch (cause) { setError(cause instanceof Error ? cause.message : '画像を設定できませんでした。') } finally { event.target.value = '' } }
  async function save(event: FormEvent) { event.preventDefault(); if (!name.trim()) { setError('表示名を入力してください。'); return }; setSaving(true); setError(undefined); try { await onUpdateProfile({ name: name.trim(), memo, theme, image }); onBack() } catch (cause) { setError(cause instanceof Error ? cause.message : '更新できませんでした。') } finally { setSaving(false) } }
  return <form className="profile-edit screen-stack" onSubmit={save}><ScreenTitle title="プロフィール" onBack={onBack} /><label className="profile-avatar" aria-label="プロフィール画像を変更"><span>{image ? <img className="profile-photo" src={image} alt="プロフィール画像" /> : <img src="/icons/avatar.svg" alt="" />}</span><i aria-hidden="true">◉</i><input type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseImage} /></label><label className="profile-field"><span className="profile-field-label">名前</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="ユーザー名" required /></label><div className="profile-field"><span className="profile-field-label">通貨</span><span className="profile-field-value">日本円（¥）<img src="/icons/chevron-right.svg" alt="" /></span></div><fieldset className="profile-field profile-theme"><legend>アプリのテーマ</legend><div>{profileThemes.map((option) => <button key={option.value} type="button" className={theme === option.value ? 'active' : ''} data-theme={option.value} aria-label={`${option.label}を選択`} aria-pressed={theme === option.value} onClick={() => setTheme(option.value)} />)}</div></fieldset><label className="profile-field"><span className="profile-field-label">メモ（任意）</span><textarea value={memo} onChange={(event) => setMemo(event.target.value)} maxLength={500} aria-label="メモ" placeholder="メモを入力" /></label>{error && <p className="inline-error" role="alert">{error}</p>}<button className="primary-action entry-fixed-action" disabled={saving}>{saving ? '保存中…' : '保存する'}</button></form>
}

function TransactionDetail({ transaction, categories, accounts: _accounts, onClose, onEdit, onDelete }: { transaction: LedgerTransaction; categories: LedgerCategory[]; accounts: AssetAccount[]; onClose: () => void; onEdit: () => void; onDelete: () => void }) {
  const categoriesById = new Map(categories.map((category) => [category.id, category]))
  const [imageFailed, setImageFailed] = useState(false)
  const receiptImageUrl = transaction.receiptId ? `/api/receipts/${encodeURIComponent(transaction.receiptId)}/image` : undefined
  const categoryNames = transaction.items.map((item) => categoriesById.get(item.categoryId)?.name ?? 'その他').filter((name, index, values) => values.indexOf(name) === index).join('・') || '未設定'
  return <section className="detail-page screen-stack" aria-label="明細詳細">
      <div className="detail-topbar"><button type="button" className="plain-button screen-back" aria-label="戻る" onClick={onClose}><img src="/icons/chevron-left.svg" alt="" /></button></div>
      <span className={`detail-icon ${transaction.type}`}><img src={`/icons/${transaction.type === 'income' ? 'category-other' : 'category-food'}.svg`} alt="" /></span>
      <span className={`detail-kind ${transaction.type}`}>{transaction.type === 'income' ? '収入' : '支出'}</span>
      <strong className="detail-amount">{yen(transaction.cashPaidAmount)}</strong>
      <h2>{transaction.title}</h2><p>{new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${transaction.occurredAt}T00:00:00`))}</p>
      <dl className="detail-facts"><div><dt><img src="/icons/detail-category.svg" alt="" />カテゴリ</dt><dd>{categoryNames}</dd></div><div><dt><img src="/icons/detail-payment.svg" alt="" />支払い方法</dt><dd>{transaction.paymentMethod || '未設定'}</dd></div><div><dt><img src="/icons/detail-memo.svg" alt="" />メモ</dt><dd>{transaction.memo || '—'}</dd></div></dl>
      {receiptImageUrl && <section className="detail-receipt"><h3>レシート</h3>{imageFailed ? <p className="detail-image-error">画像を表示できません。</p> : <img src={receiptImageUrl} alt="保存済みレシート" onError={() => setImageFailed(true)} />}</section>}
      {transaction.items.length > 1 && <section className="detail-lines"><h3>購入した商品 <small>{transaction.items.length}点</small></h3>{transaction.items.map((item) => <article className="detail-line" key={item.id}><span><b>{item.name}</b><small>{categoriesById.get(item.categoryId)?.name ?? 'その他'}</small></span><strong>{yen(item.paidAmount)}</strong></article>)}</section>}
      <div className="detail-fixed-actions"><button onClick={onEdit} className="primary-action"><img src="/icons/edit.svg" alt="" />編集</button><button onClick={onDelete} className="outline-danger"><img src="/icons/trash.svg" alt="" />削除</button></div>
    </section>
}

function ConfirmationDialog({ title, text, onCancel, onConfirm }: { title: string; text: string; onCancel: () => void; onConfirm: () => Promise<void> }) { const [saving, setSaving] = useState(false); async function confirm() { setSaving(true); try { await onConfirm() } finally { setSaving(false) } } return <AppDialog label={title} onClose={saving ? () => undefined : onCancel}><section className="confirm-modal"><h2>{title}</h2><p>{text}</p><div className="modal-actions"><button className="outline-danger" onClick={onCancel} disabled={saving}>キャンセル</button><button className="primary-action" onClick={() => void confirm()} disabled={saving}>{saving ? '処理中…' : '続ける'}</button></div></section></AppDialog> }

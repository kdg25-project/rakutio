import { ChangeEvent, FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import { calculateTransaction, MoneyCalculationError } from '../domain/money'
import { authClient } from '../lib/auth-client'
import type { ReceiptExtraction } from '../ocr/receipt'
import type { AssetAccount, AssetBalanceHistoryPoint, AssetSummary } from '../server/assets/types'
import type { LedgerCategory, LedgerSummary, LedgerTransaction, LedgerTransactionInput, UtilityKind } from '../server/ledger/types'
import type { MonthlyTarget } from '../server/planning/service'
import { AssetsScreen as FinanceAssetsScreen, MonthTargetScreen as FinanceMonthTargetScreen, RecurringScreen as FinanceRecurringScreen } from './financial-panels'
import { AnalyticsScreen as HistoryAnalyticsScreen, HistoryScreen as LedgerHistoryScreen } from './history-analytics'

type Page = 'home' | 'history' | 'add' | 'entry' | 'receipt' | 'analytics' | 'settings' | 'profile' | 'app-settings' | 'help' | 'categories' | 'budget' | 'assets' | 'recurring'
type Notice = { kind: 'success' | 'error'; text: string } | undefined
type Confirmation = { title: string; text: string; action: () => Promise<void> } | undefined
type ApiErrorBody = { error?: { code?: unknown; message?: unknown; details?: unknown } }
type OcrResponse = { receipt?: ReceiptExtraction; receiptId?: string; error?: { code?: unknown; message?: unknown } }
type EditorItem = { id?: string; name: string; originalAmount: number; discountAmount: number; categoryId: string; utilityKind?: UtilityKind }

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
function dateLabel(value: string) { return new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${value}T00:00:00`)) }
export function summaryForMonth(summary: LedgerSummary | undefined, month: string) {
  return summary?.month === month ? summary : undefined
}
export function transactionsForMonth(transactions: LedgerTransaction[], month: string) {
  return transactions.filter((transaction) => transaction.occurredAt.startsWith(`${month}-`))
}
export function receiptRetryUrl(receiptId: string) {
  return `/api/receipts/${encodeURIComponent(receiptId)}/retry`
}
export function dismissOverlayPage() { return 'home' as const }
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

function Loading() { return <div className="loading"><span className="spinner" />読み込み中…</div> }

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

function BottomSheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const dialog = ref.current; if (!dialog) return; dialog.showModal(); dialog.querySelector<HTMLElement>('button, [href], input, select, textarea')?.focus(); return () => dialog.close() }, [])
  return <dialog ref={ref} className="app-bottom-sheet" aria-label={label} onCancel={(event) => { event.preventDefault(); onClose() }} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>{children}</dialog>
}

export function LedgerApp({ userName, onSignOut }: { userName: string; onSignOut: () => Promise<void> }) {
  const [profileName, setProfileName] = useState(userName)
  const [page, setPage] = useState<Page>('home')
  const [month, setMonth] = useState(monthNow)
  const [summary, setSummary] = useState<LedgerSummary>()
  const [monthlyTarget, setMonthlyTarget] = useState<MonthlyTarget>()
  const [categories, setCategories] = useState<LedgerCategory[]>([])
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([])
  const [accounts, setAccounts] = useState<AssetAccount[]>([])
  const [selected, setSelected] = useState<LedgerTransaction>()
  const [editing, setEditing] = useState<LedgerTransaction>()
  const [entryType, setEntryType] = useState<'expense' | 'income'>('expense')
  const [receiptInput, setReceiptInput] = useState<{ receiptId: string; extraction?: ReceiptExtraction }>()
  const [notice, setNotice] = useState<Notice>()
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const refreshGeneration = useRef(0)
  const [editorKey, setEditorKey] = useState(0)

  const refresh = async () => {
    const generation = refreshGeneration.current + 1
    refreshGeneration.current = generation
    setLoading(true)
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
      setSummary(summaryResult.summary); setCategories(categoryResult.categories); setTransactions(transactionResult.transactions); setAccounts(assetResult.assets.accounts); setMonthlyTarget(target?.targets[0])
    } catch (error) {
      if (refreshGeneration.current === generation) {
        const text = error instanceof Error ? error.message : 'データを読み込めませんでした。'
        setLoadError(text)
        setNotice({ kind: 'error', text })
      }
    } finally { if (refreshGeneration.current === generation) setLoading(false) }
  }

  useEffect(() => { void refresh() }, [month])
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
      setEditing(undefined); setReceiptInput(undefined); setPage('history'); await refresh()
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
        setSelected(undefined); setNotice({ kind: 'success', text: '明細を削除しました。' }); await refresh()
      } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : '削除できませんでした。' }) }
    } })
  }

  async function updateProfile(name: string) {
    const { error } = await authClient.updateUser({ name })
    if (error) throw new Error(error.message || 'プロフィールを更新できませんでした。')
    setProfileName(name)
  }

  const currentSummary = summaryForMonth(summary, month)
  const currentTransactions = transactionsForMonth(transactions, month)
  const overlayingHome = page === 'add' || page === 'receipt'

  return (
    <div className="ledger-shell">
      {(page === 'home' || overlayingHome) && <header className="ledger-topbar"><button className="top-icon" type="button" aria-label="お知らせ"><img src="/icons/bell.svg" alt="" /></button><div><p className="date-kicker">{month.replace('-', '年')}月</p><strong>家計簿</strong></div><button className="avatar" onClick={() => setPage('settings')} aria-label="設定"><img src="/icons/avatar.svg" alt="" /></button></header>}
      <main className="ledger-main">
        {loading && !summary && page !== 'entry' && page !== 'receipt' ? <Loading /> : (
          <>
            {(page === 'home' || overlayingHome) && <HomeScreen month={month} summary={currentSummary} target={monthlyTarget} transactions={currentTransactions} loadError={loadError} onRetry={() => void refresh()} onPage={setPage} onSelect={setSelected} />}
            {page === 'history' && <LedgerHistoryScreen month={month} setMonth={setMonth} categories={categories} onSelect={setSelected} onError={(text) => setNotice({ kind: 'error', text })} />}
            {page === 'add' && <AddTransactionScreen onChoose={startNew} onDismiss={() => setPage(dismissOverlayPage())} />}
            {page === 'entry' && <TransactionEditor key={editorKey} categories={categories} accounts={accounts} transaction={editing} receipt={receiptInput} initialType={entryType} onCancel={() => setPage(editing ? 'history' : receiptInput ? 'receipt' : 'add')} onSave={saveTransaction} />}
            {page === 'receipt' && <ReceiptFlow onUseReceipt={(receipt) => openEntry(undefined, receipt)} onCancel={() => setPage(dismissOverlayPage())} />}
            {page === 'analytics' && <HistoryAnalyticsScreen month={month} setMonth={setMonth} summary={summary} categories={categories} onSelect={setSelected} />}
            {page === 'categories' && <CategoriesScreen categories={categories} onChanged={refresh} notify={setNotice} confirm={(title, text, action) => setConfirmation({ title, text, action })} />}
            {page === 'budget' && <FinanceMonthTargetScreen month={month} notify={setNotice} onChanged={refresh} />}
            {page === 'assets' && <FinanceAssetsScreen notify={setNotice} onChanged={refresh} />}
            {page === 'recurring' && <FinanceRecurringScreen notify={setNotice} onChanged={refresh} />}
            {page === 'settings' && <SettingsScreen userName={profileName} onPage={setPage} onSignOut={onSignOut} />}
            {page === 'profile' && <ProfileScreen userName={profileName} onBack={() => setPage('settings')} onUpdateProfile={updateProfile} />}
            {page === 'app-settings' && <InformationScreen title="アプリ設定" onBack={() => setPage('settings')} text="表示や通知に関する設定は、今後ここから管理できます。" />}
            {page === 'help' && <InformationScreen title="ヘルプ" onBack={() => setPage('settings')} text="収支の登録、レシートの読み取り、資産の管理について案内します。" />}
          </>
        )}
      </main>
      {selected && <TransactionDetail transaction={selected} categories={categories} accounts={accounts} onClose={() => setSelected(undefined)} onEdit={() => openEntry(selected)} onDelete={() => void removeTransaction(selected)} />}
      {confirmation && <ConfirmationDialog title={confirmation.title} text={confirmation.text} onCancel={() => setConfirmation(undefined)} onConfirm={async () => { await confirmation.action(); setConfirmation(undefined) }} />}
      {notice && <div className={`toast ${notice.kind}`} role="status">{notice.text}</div>}
      <nav className="bottom-nav" aria-label="アプリ内ナビゲーション">{pages.map((item) => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => item.id === 'entry' ? startNew('add') : setPage(item.id)}><span><img src={item.icon} alt="" /></span>{item.label}</button>)}</nav>
    </div>
  )
}

export function HomeScreen({ month, summary, target, transactions, loadError, onRetry, onPage, onSelect }: { month: string; summary?: LedgerSummary; target?: MonthlyTarget; transactions: LedgerTransaction[]; loadError?: string; onRetry: () => void; onPage: (page: Page) => void; onSelect: (transaction: LedgerTransaction) => void }) {
  const [assetHistory, setAssetHistory] = useState<AssetBalanceHistoryPoint[]>([])
  useEffect(() => { let active = true; void request<{ history: AssetBalanceHistoryPoint[] }>('/api/assets/history').then((result) => { if (active) setAssetHistory(result.history) }).catch(() => { if (active) setAssetHistory([]) }); return () => { active = false } }, [])
  if (!summary) return <div className="screen-stack"><section className="home-data-state" aria-live="polite">{loadError ? <><p className="inline-error" role="alert">{loadError}</p><button className="button secondary" onClick={onRetry}>再読み込み</button></> : <Loading />}</section></div>
  const income = summary.incomeCashPaidAmount; const expense = summary.expenseCashPaidAmount
  const currentTarget = target?.month === month ? target : undefined
  const expenseCategories = summary.categories.filter((category) => category.cashPaidAmount > 0).sort((left, right) => right.cashPaidAmount - left.cashPaidAmount).slice(0, 5)
  const latestAsset = assetHistory.at(-1)?.balanceAmount ?? summary.assetActiveTotalAmount
  return <div className="screen-stack">
    <section className="income-card"><p>今月の収支</p><h1>{yen(income - expense)}</h1><div><span>↑ 収入 <b>{yen(income)}</b></span><span>↓ 支出 <b>{yen(expense)}</b></span></div></section>
    {currentTarget && <button className="target-card" onClick={() => onPage('budget')}><div><small>支出予算</small><b>{yen(currentTarget.expenseActualAmount)} / {yen(currentTarget.expenseTargetAmount)}</b><i><span style={{ width: `${Math.min(100, Math.round((currentTarget.expenseProgress ?? 0) * 100))}%` }} /></i></div><div><small>収入目標</small><b>{yen(currentTarget.incomeActualAmount)} / {yen(currentTarget.incomeTargetAmount)}</b><i><span style={{ width: `${Math.min(100, Math.round((currentTarget.incomeProgress ?? 0) * 100))}%` }} /></i></div></button>}
    <button className="asset-card" onClick={() => onPage('assets')}><span>▣</span><div><small>総資産</small><strong>{yen(latestAsset)}</strong>{assetHistory.length > 1 && <small>推移 {yen(assetHistory.at(-1)?.deltaAmount ?? 0)}</small>}</div><AssetSparkline history={assetHistory} /><i>›</i></button>
    <section><div className="section-heading"><h2>カテゴリ別の支出</h2><button onClick={() => onPage('analytics')}>すべて見る ›</button></div>{expenseCategories.length ? <div className="category-bubbles">{expenseCategories.map((category) => <div key={category.id} style={{ backgroundColor: category.color }}><img src={`/icons/${categoryIconName(category.name)}.svg`} alt="" /><span>{category.name}</span><b>{yen(category.cashPaidAmount)}</b></div>)}</div> : <EmptyState text="今月の支出はまだありません。" />}</section>
    <section><div className="section-heading"><h2>最近の収支</h2><button onClick={() => onPage('history')}>すべて見る ›</button></div>{transactions.length ? <TransactionRows transactions={transactions.slice(0, 4)} onSelect={onSelect} /> : <EmptyState text="最初の明細を登録しましょう。" />}</section>
  </div>
}

function categoryIconName(name: string) { return ({ 食費: 'category-food', 日用品: 'category-daily', 交通費: 'category-transit', 光熱費: 'category-utility', サブスク: 'category-subscription', その他: 'category-other' } as Record<string, string>)[name] ?? 'category-other' }
function AssetSparkline({ history }: { history: AssetBalanceHistoryPoint[] }) { if (history.length < 2) return null; const values = history.map((point) => point.balanceAmount); const min = Math.min(...values); const range = Math.max(1, Math.max(...values) - min); const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${34 - ((value - min) / range) * 30}`).join(' '); return <svg className="asset-sparkline" viewBox="0 0 100 40" role="img" aria-label={`資産残高の推移。現在 ${yen(values.at(-1) ?? 0)}`}><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg> }

function TransactionRows({ transactions, onSelect, grouped = false }: { transactions: LedgerTransaction[]; onSelect: (transaction: LedgerTransaction) => void; grouped?: boolean }) {
  let lastDate = ''
  return <div className="transaction-list">{transactions.map((transaction) => { const heading = grouped && transaction.occurredAt !== lastDate ? (lastDate = transaction.occurredAt, <p className="date-heading" key={`${transaction.id}-date`}>{dateLabel(transaction.occurredAt)}</p>) : null; return <div key={transaction.id}>{heading}<button className="transaction-row" onClick={() => onSelect(transaction)}><span className={`row-icon ${transaction.type}`}>{transaction.type === 'income' ? '↑' : '↓'}</span><span><b>{transaction.title}</b><small>{transaction.merchant || transaction.paymentMethod || '未設定'}</small></span><strong className={transaction.type}>{transaction.type === 'income' ? '+' : '−'} {yen(transaction.cashPaidAmount)}</strong><i>›</i></button></div> })}</div>
}

function AddTransactionScreen({ onChoose, onDismiss }: { onChoose: (page: 'add' | 'entry' | 'receipt' | 'recurring', type?: 'expense' | 'income') => void; onDismiss: () => void }) {
  return <BottomSheet label="新規登録" onClose={onDismiss}><section className="add-screen"><button type="button" className="sheet-close" onClick={onDismiss} aria-label="閉じる">×</button><span className="sheet-handle" /><h1>新規登録</h1><p>登録方法を選択してください。</p><div className="add-options"><button onClick={() => onChoose('receipt')}><span className="add-option-icon receipt">▧</span><b>レシート</b><small>レシートを撮影して自動で読み取ります</small></button><button onClick={() => onChoose('entry', 'expense')}><span className="add-option-icon expense">Aa</span><b>手動入力</b><small>自分で金額や内容を入力します</small></button><button onClick={() => onChoose('recurring')}><span className="add-option-icon recurring">↻</span><b>定期支出</b><small>毎月の支出を自動で登録します</small></button><button onClick={() => onChoose('entry', 'income')}><span className="add-option-icon income">¥</span><b>収入</b><small>給与や臨時収入などを登録できます</small></button></div></section></BottomSheet>
}

function ScreenTitle({ title, onBack }: { title: string; onBack?: () => void }) { return <div className="screen-title">{onBack ? <button type="button" className="plain-button" onClick={onBack} aria-label="戻る">‹</button> : <span className="screen-title-spacer" />}<h1>{title}</h1><span className="screen-title-spacer" /></div> }

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
      <button className="primary-action entry-fixed-action" type="submit">次へ</button>
    </> : <>
      <section className="entry-summary"><h2>基本情報</h2><button type="button" onClick={() => setStage('basic')}>編集</button><dl><div><dt>店舗名</dt><dd>{title}</dd></div><div><dt>日付</dt><dd>{occurredAt || '未入力'}</dd></div><div><dt>支払い方法</dt><dd>{paymentMethod || '未設定'}</dd></div></dl></section>
      <div className="form-grid"><label>支払い口座<select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">指定しない</option>{accounts.filter((account) => account.type !== 'gift').map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>{type === 'expense' && <label>商品券口座<select value={giftAccountId} onChange={(event) => setGiftAccountId(event.target.value)}><option value="">使用しない</option>{accounts.filter((account) => account.type === 'gift').map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>}</div>
      <section className="line-items"><div className="section-heading"><h2>購入した商品</h2><span>{items.length}件</span></div>{items.map((item, index) => { const utility = categories.find((category) => category.id === item.categoryId)?.name === '光熱費'; return <div className="item-editor" key={item.id ?? index}><input aria-label={`品名 ${index + 1}`} value={item.name} onChange={(event) => updateItem(index, 'name', event.target.value)} placeholder="品名" /><input aria-label={`金額 ${index + 1}`} value={item.originalAmount || ''} type="number" min="0" inputMode="numeric" onChange={(event) => updateItem(index, 'originalAmount', event.target.value)} placeholder="金額" /><select aria-label={`カテゴリ ${index + 1}`} value={item.categoryId} onChange={(event) => updateItem(index, 'categoryId', event.target.value)}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>{utility && <select aria-label={`光熱費内訳 ${index + 1}`} value={item.utilityKind ?? ''} onChange={(event) => updateItem(index, 'utilityKind', event.target.value)}><option value="">内訳を選択</option><option value="electricity">電気</option><option value="gas">ガス</option><option value="water">水道</option><option value="other">その他</option></select>}<input aria-label={`値引き ${index + 1}`} value={item.discountAmount || ''} type="number" min="0" inputMode="numeric" onChange={(event) => updateItem(index, 'discountAmount', event.target.value)} placeholder="値引き" />{items.length > 1 && <button type="button" className="delete-line" onClick={() => setItems((previous) => previous.filter((_, itemIndex) => itemIndex !== index))}>削除</button>}</div> })}<button type="button" className="item-add-button" onClick={() => setAddingItem(true)}>商品を追加</button></section>
      {type === 'expense' && <section className="form-grid"><label>レシート値引き<input type="number" min="0" value={receiptDiscountAmount || ''} onChange={(event) => setReceiptDiscountAmount(Math.max(0, Number(event.target.value) || 0))} /></label><label>ポイント利用<input type="number" min="0" value={pointUsedAmount || ''} onChange={(event) => setPointUsedAmount(Math.max(0, Number(event.target.value) || 0))} /></label><label>商品券利用<input type="number" min="0" value={giftCertificateUsedAmount || ''} onChange={(event) => setGiftCertificateUsedAmount(Math.max(0, Number(event.target.value) || 0))} /></label></section>}
      {totals && <div className="total-box"><span>合計金額</span><strong>{yen(totals.cashPaidAmount)}</strong><small>値引き {yen(totals.discountAmount)} / 非現金 {yen(totals.nonCashAmount)}</small></div>}
      {inlineError && <p className="inline-error" role="alert">{inlineError}</p>}
      <button className="primary-action entry-fixed-action" type="submit" disabled={saving}>{saving ? '保存中…' : transaction ? '変更を保存' : 'この内容で登録する'}</button>
    </>}
    {addingItem && <ItemAddDialog categories={categories} fallbackCategory={fallbackCategory} onClose={() => setAddingItem(false)} onAdd={(item) => { setItems((previous) => [...previous, item]); setAddingItem(false) }} />}
  </form>
}

function ItemAddDialog({ categories, fallbackCategory, onClose, onAdd }: { categories: LedgerCategory[]; fallbackCategory: string; onClose: () => void; onAdd: (item: EditorItem) => void }) { const [name, setName] = useState(''); const [amount, setAmount] = useState(''); const [categoryId, setCategoryId] = useState(fallbackCategory); const valid = name.trim().length > 0 && Number(amount) >= 0; function add() { if (!valid) return; onAdd({ name, originalAmount: Math.max(0, Number(amount) || 0), discountAmount: 0, categoryId }) } return <BottomSheet label="商品を追加" onClose={onClose}><section className="item-add-dialog"><ScreenTitle title="商品を追加" onBack={onClose} /><label>商品名<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例）サントリー天然水 2L" /></label><label>金額<input value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min="0" inputMode="numeric" /></label><label>カテゴリ<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><button className="primary-action" type="button" disabled={!valid} onClick={add}>追加する</button></section></BottomSheet> }

function ReceiptFlow({ onUseReceipt, onCancel }: { onUseReceipt: (receipt: { receiptId: string; extraction?: ReceiptExtraction }) => void; onCancel: () => void }) {
  const [file, setFile] = useState<File>(); const [preview, setPreview] = useState<string>(); const [error, setError] = useState<string>(); const [failedReceiptId, setFailedReceiptId] = useState<string>(); const [result, setResult] = useState<{ receiptId: string; extraction: ReceiptExtraction }>(); const [phase, setPhase] = useState<'capture' | 'review' | 'analyzing' | 'result'>('capture'); const generation = useRef(0)
  useEffect(() => { if (!file) { setPreview(undefined); return }; const objectUrl = URL.createObjectURL(file); setPreview(objectUrl); return () => URL.revokeObjectURL(objectUrl) }, [file])
  function choose(event: ChangeEvent<HTMLInputElement>) { generation.current += 1; const next = event.target.files?.[0]; if (!next) return; setFile(next); setPhase('review'); setError(undefined); setFailedReceiptId(undefined); setResult(undefined) }
  async function read() { if (!file) return; const current = generation.current + 1; generation.current = current; setPhase('analyzing'); setError(undefined); setFailedReceiptId(undefined); try { const form = new FormData(); form.set('image', file); const response = await fetch('/api/ocr/receipt', { method: 'POST', body: form }); const payload = await response.json().catch(() => undefined) as OcrResponse | undefined; if (generation.current !== current) return; const receiptId = typeof payload?.receiptId === 'string' ? payload.receiptId : undefined; if (receiptId) setFailedReceiptId(receiptId); if (response.ok && payload?.receipt && receiptId) { setResult({ receiptId, extraction: payload.receipt }); setPhase('result'); return } const invalidImage = payload?.error?.code === 'INVALID_IMAGE' || payload?.error?.code === 'INVALID_MULTIPART'; setError(invalidImage ? apiError(payload, '画像の形式または内容を確認してください。') : receiptId ? '現在レシートの読み取りを利用できません。画像は保存しました。手入力で登録できます。' : 'レシートの読み取りを開始できませんでした。画像を確認して再試行してください。'); setPhase('review') } catch { if (generation.current === current) { setError('通信に失敗しました。接続を確認して再試行してください。'); setPhase('review') } } }
  async function retrySavedDraft() { const receiptId = failedReceiptId; if (!receiptId) return; const current = generation.current + 1; generation.current = current; setPhase('analyzing'); setError(undefined); try { const response = await fetch(receiptRetryUrl(receiptId), { method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin' }); const payload = await response.json().catch(() => undefined) as OcrResponse | undefined; if (generation.current !== current) return; if (response.ok && payload?.receipt) { setResult({ receiptId, extraction: payload.receipt }); setPhase('result'); return } const code = payload?.error?.code; setError(code === 'RECEIPT_ANALYSIS_IN_PROGRESS' ? '別の読み取りを処理しています。しばらく待ってから再試行してください。' : '現在レシートの読み取りを利用できません。画像は保存されています。手入力で登録できます。'); setPhase('review') } catch { if (generation.current === current) { setError('通信に失敗しました。接続を確認して再試行してください。'); setPhase('review') } } }
  return <BottomSheet label="レシートを撮影" onClose={onCancel}><section className="receipt-flow screen-stack"><ScreenTitle title={phase === 'capture' ? 'レシートを撮影' : phase === 'review' ? '撮影した画像' : phase === 'analyzing' ? 'データを読み取り中' : '読み取り結果'} onBack={onCancel} />{phase === 'capture' && <><p>カメラで撮影するか、保存済みの画像からレシートを選択します。</p><label className="receipt-capture"><span className="capture-frame">▧</span><b>写真を選択</b><small>PNG / JPEG / WebP、8 MB 以下</small><input type="file" accept="image/png,image/jpeg,image/webp" capture="environment" onChange={choose} /></label><p className="receipt-tip">明るい場所で、レシート全体が入るように撮影してください。</p></>}{phase === 'review' && <><div className="receipt-preview">{preview && <img src={preview} alt="選択したレシート" />}</div><p className="receipt-file-name">{file?.name}</p>{error && <div className="inline-error" role="alert"><p>{error}</p>{failedReceiptId && <p><a href={`/api/receipts/${encodeURIComponent(failedReceiptId)}/image`}>保存済みの元画像を開く</a></p>}</div>}{failedReceiptId && <div className="receipt-retry-actions"><button type="button" className="button secondary" onClick={() => void retrySavedDraft()}>もう一度読み取る</button><button type="button" className="button secondary" onClick={() => onUseReceipt({ receiptId: failedReceiptId })}>手入力で明細を作成</button></div>}<label className="receipt-change-file">別の写真を選ぶ<input type="file" accept="image/png,image/jpeg,image/webp" capture="environment" onChange={choose} /></label><button className="primary-action entry-fixed-action" type="button" disabled={!file} onClick={() => void read()}>この写真で読み取る</button></>}{phase === 'analyzing' && <div className="receipt-analysis" role="status"><span className="spinner" /><h2>データを読み取っています</h2><p>しばらくお待ちください</p><ul><li>画像を確認</li><li>文字を読み取り</li><li>商品情報を整理</li><li>結果を確認</li></ul><button type="button" className="button secondary" onClick={onCancel}>キャンセル</button></div>}{phase === 'result' && result && <><div className="receipt-result-mark">✓</div><h2>読み取りが完了しました</h2><p>内容を確認・編集してから登録できます。</p><div className="receipt-result-summary"><span>店舗名<b>{result.extraction.merchant || '未取得'}</b></span><span>合計<b>{result.extraction.total == null ? '未取得' : yen(result.extraction.total)}</b></span><span>商品<b>{result.extraction.items.length}件</b></span></div><button className="primary-action entry-fixed-action" type="button" onClick={() => onUseReceipt(result)}>内容を確認する</button></>}</section></BottomSheet>
}


const categoryIconChoices = ['category-food', 'category-daily', 'category-transit', 'category-utility', 'category-subscription', 'category-other']
const categoryColorChoices = ['#819a8b', '#bd8384', '#d4a16d', '#908ab0', '#6e9eb2', '#a5a59e', '#77997e', '#d0a1a4', '#b6a789', '#939998']

function CategoriesScreen({ categories, onChanged, notify, confirm }: { categories: LedgerCategory[]; onChanged: () => Promise<void>; notify: (value: Notice) => void; confirm: (title: string, text: string, action: () => Promise<void>) => void }) {
  const [draft, setDraft] = useState<Pick<LedgerCategory, 'name' | 'color' | 'icon'> & { id?: string }>({ name: '', color: categoryColorChoices[0], icon: categoryIconChoices[0] })
  const [editing, setEditing] = useState(false); const [saving, setSaving] = useState(false)
  function begin(category?: LedgerCategory) { setDraft(category ? { id: category.id, name: category.name, color: category.color, icon: category.icon } : { name: '', color: categoryColorChoices[0], icon: categoryIconChoices[0] }); setEditing(true) }
  async function save(event: FormEvent) { event.preventDefault(); if (!draft.name.trim()) return; setSaving(true); try { if (draft.id) await request(`/api/ledger/categories/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body: JSON.stringify({ name: draft.name.trim(), color: draft.color, icon: draft.icon }) }); else await request('/api/ledger/categories/', { method: 'POST', body: JSON.stringify({ name: draft.name.trim(), color: draft.color, icon: draft.icon }) }); await onChanged(); notify({ kind: 'success', text: draft.id ? 'カテゴリを更新しました。' : 'カテゴリを追加しました。' }); setEditing(false) } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : '保存できませんでした。' }) } finally { setSaving(false) } }
  function remove(category: LedgerCategory) { confirm(`「${category.name}」を削除しますか？`, 'このカテゴリの明細は「その他」へ移されます。', async () => { try { await request(`/api/ledger/categories/${encodeURIComponent(category.id)}`, { method: 'DELETE' }); await onChanged(); notify({ kind: 'success', text: 'カテゴリを削除しました。' }) } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : '削除できませんでした。' }) } }) }
  if (editing) return <form className="category-edit screen-stack" onSubmit={save}><ScreenTitle title={draft.id ? 'カテゴリを編集' : 'カテゴリの追加'} onBack={() => setEditing(false)} /><div className="category-icon-preview" style={{ backgroundColor: draft.color }}><img src={`/icons/${categoryIconChoices.includes(draft.icon) ? draft.icon : 'category-other'}.svg`} alt="選択中のアイコン" /></div><p className="category-picker-label">アイコンを選択</p><div className="category-icon-grid">{categoryIconChoices.map((icon) => <button type="button" className={draft.icon === icon ? 'selected' : ''} key={icon} onClick={() => setDraft({ ...draft, icon })}><img src={`/icons/${icon}.svg`} alt="" /></button>)}</div><label>カテゴリ名<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例）書籍" maxLength={40} required /></label><p className="category-picker-label">アイコンの色</p><div className="category-color-grid">{categoryColorChoices.map((color) => <button type="button" className={draft.color === color ? 'selected' : ''} style={{ backgroundColor: color }} key={color} onClick={() => setDraft({ ...draft, color })} aria-label={`${color}を選択`}><span>✓</span></button>)}</div><button className="primary-action entry-fixed-action" disabled={saving}>{saving ? '保存中…' : draft.id ? '保存する' : 'カテゴリを追加'}</button></form>
  return <section className="categories-screen screen-stack"><div className="title-row"><h1>カテゴリ管理</h1><button type="button" className="text-action" onClick={() => begin()}>追加</button></div><p className="category-section-label">支出カテゴリ</p><div className="category-list">{categories.map((category) => <div key={category.id}><button type="button" className="category-list-row" onClick={() => begin(category)}><span className="category-dot" style={{ backgroundColor: category.color }}><img src={`/icons/${categoryIconChoices.includes(category.icon) ? category.icon : categoryIconName(category.name)}.svg`} alt="" /></span><b>{category.name}</b><i>›</i></button>{!category.isDefault && <button className="category-delete" type="button" onClick={() => remove(category)}>削除</button>}</div>)}</div></section>
}

function SettingsScreen({ userName, onPage, onSignOut }: { userName: string; onPage: (page: Page) => void; onSignOut: () => Promise<void> }) { const [signingOut, setSigningOut] = useState(false); async function signOut() { setSigningOut(true); await onSignOut() } return <div className="screen-stack"><h1>設定</h1><div className="settings-list"><button onClick={() => onPage('profile')}><span className="settings-avatar">{userName.slice(0, 1)}</span><span><b>{userName}</b><small>プロフィールを編集</small></span><i>›</i></button><button onClick={() => onPage('profile')}>アカウント <i>›</i></button><button onClick={() => onPage('categories')}>カテゴリ管理 <i>›</i></button><button onClick={() => onPage('budget')}>予算・目標設定 <i>›</i></button><button onClick={() => onPage('assets')}>銀行口座設定 <i>›</i></button><button onClick={() => onPage('app-settings')}>アプリ設定 <i>›</i></button><button onClick={() => onPage('help')}>ヘルプ <i>›</i></button><button className="danger" onClick={() => void signOut()} disabled={signingOut}>{signingOut ? 'ログアウト中…' : 'ログアウト'} <i>›</i></button></div></div> }

function ProfileScreen({ userName, onBack, onUpdateProfile }: { userName: string; onBack: () => void; onUpdateProfile: (name: string) => Promise<void> }) { const [name, setName] = useState(userName); const [saving, setSaving] = useState(false); const [error, setError] = useState<string>(); async function save(event: FormEvent) { event.preventDefault(); if (!name.trim()) { setError('表示名を入力してください。'); return }; setSaving(true); setError(undefined); try { await onUpdateProfile(name.trim()); onBack() } catch (cause) { setError(cause instanceof Error ? cause.message : '更新できませんでした。') } finally { setSaving(false) } } return <form className="profile-edit screen-stack" onSubmit={save}><ScreenTitle title="プロフィール" onBack={onBack} /><section className="profile-card"><span className="settings-avatar">{userName.slice(0, 1)}</span><div><b>{userName}</b><small>プロフィール</small></div></section><label>名前<input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required /></label><label>通貨<input value="日本円（¥）" disabled /></label>{error && <p className="inline-error" role="alert">{error}</p>}<button className="primary-action entry-fixed-action" disabled={saving}>{saving ? '保存中…' : '保存する'}</button></form> }

function InformationScreen({ title, text, onBack }: { title: string; text: string; onBack: () => void }) { return <section className="screen-stack information-screen"><ScreenTitle title={title} onBack={onBack} /><div className="information-card"><p>{text}</p></div></section> }

function TransactionDetail({ transaction, categories, accounts, onClose, onEdit, onDelete }: { transaction: LedgerTransaction; categories: LedgerCategory[]; accounts: AssetAccount[]; onClose: () => void; onEdit: () => void; onDelete: () => void }) {
  const categoriesById = new Map(categories.map((category) => [category.id, category]))
  const accountsById = new Map(accounts.map((account) => [account.id, account]))
  const [imageFailed, setImageFailed] = useState(false)
  const hasDeductions = transaction.type === 'expense' && (transaction.itemDiscountAmount > 0 || transaction.receiptDiscountAmount > 0 || transaction.pointUsedAmount > 0 || transaction.giftCertificateUsedAmount > 0)
  const receiptImageUrl = transaction.receiptId ? `/api/receipts/${encodeURIComponent(transaction.receiptId)}/image` : undefined
  return <AppDialog label="明細詳細" onClose={onClose}>
    <section className="detail-modal">
      <button className="modal-close" onClick={onClose} aria-label="閉じる">×</button>
      <span className={`detail-icon ${transaction.type}`}>{transaction.type === 'income' ? '↑' : '↓'}</span>
      <h2>{transaction.title}</h2><p>{dateLabel(transaction.occurredAt)}</p>
      <strong className="detail-amount">{transaction.type === 'income' ? '+' : '−'} {yen(transaction.cashPaidAmount)}</strong>
      <dl><div><dt>店舗</dt><dd>{transaction.merchant || '未設定'}</dd></div><div><dt>カテゴリ</dt><dd>{transaction.items.map((item) => categoriesById.get(item.categoryId)?.name ?? 'その他').join('・')}</dd></div><div><dt>支払い方法</dt><dd>{transaction.paymentMethod || '未設定'}</dd></div>{transaction.accountId && <div><dt>支払い口座</dt><dd>{accountsById.get(transaction.accountId)?.name ?? '口座情報なし'}</dd></div>}{transaction.giftAccountId && <div><dt>商品券口座</dt><dd>{accountsById.get(transaction.giftAccountId)?.name ?? '口座情報なし'}</dd></div>}{transaction.memo && <div><dt>メモ</dt><dd>{transaction.memo}</dd></div>}</dl>
      {receiptImageUrl && <details className="receipt-original"><summary>保存済みレシート原本</summary>{imageFailed ? <p className="detail-image-error">画像を表示できません。<a href={receiptImageUrl}>元画像を開く</a></p> : <><img src={receiptImageUrl} alt="保存済みレシート原本" onError={() => setImageFailed(true)} /><a href={receiptImageUrl}>元画像を開く</a></>}</details>}
      <section className="detail-lines"><h3>明細と金額配分</h3>{transaction.items.map((item) => <article className="detail-line" key={item.id}><header><span>{item.name}</span><b>{yen(item.paidAmount)}</b></header><dl><div><dt>元の金額</dt><dd>{yen(item.originalAmount)}</dd></div>{transaction.type === 'expense' && <><div><dt>明細値引き</dt><dd>− {yen(item.itemDiscountAmount)}</dd></div><div><dt>レシート割引配分</dt><dd>− {yen(item.allocatedReceiptDiscountAmount)}</dd></div><div><dt>値引き後</dt><dd>{yen(item.finalAmount)}</dd></div><div><dt>ポイント配分</dt><dd>− {yen(item.allocatedPointAmount)}</dd></div><div><dt>商品券配分</dt><dd>− {yen(item.allocatedGiftCertificateAmount)}</dd></div></>}{item.utilityKind && <div><dt>光熱費の内訳</dt><dd>{{ electricity: '電気', gas: 'ガス', water: '水道', other: 'その他' }[item.utilityKind]}</dd></div>}<div><dt>実際の支払額</dt><dd>{yen(item.paidAmount)}</dd></div></dl></article>)}</section>
      <section className="detail-totals"><h3>合計の内訳</h3><dl><div><dt>元の合計</dt><dd>{yen(transaction.grossAmount)}</dd></div>{transaction.type === 'expense' && <><div><dt>明細値引き合計</dt><dd>− {yen(transaction.itemDiscountAmount)}</dd></div><div><dt>レシート値引き</dt><dd>− {yen(transaction.receiptDiscountAmount)}</dd></div><div><dt>値引き合計</dt><dd>− {yen(transaction.discountAmount)}</dd></div><div><dt>値引き後合計</dt><dd>{yen(transaction.netAmount)}</dd></div>{hasDeductions && <><div><dt>ポイント利用</dt><dd>− {yen(transaction.pointUsedAmount)}</dd></div><div><dt>商品券利用</dt><dd>− {yen(transaction.giftCertificateUsedAmount)}</dd></div></>}</>}<div className="detail-total-final"><dt>{transaction.type === 'income' ? '受取金額' : '現金・口座からの支払額'}</dt><dd>{yen(transaction.cashPaidAmount)}</dd></div></dl></section>
      <div className="modal-actions"><button onClick={onDelete} className="outline-danger">削除</button><button onClick={onEdit} className="primary-action">編集</button></div>
    </section>
  </AppDialog>
}

function ConfirmationDialog({ title, text, onCancel, onConfirm }: { title: string; text: string; onCancel: () => void; onConfirm: () => Promise<void> }) { const [saving, setSaving] = useState(false); async function confirm() { setSaving(true); try { await onConfirm() } finally { setSaving(false) } } return <AppDialog label={title} onClose={saving ? () => undefined : onCancel}><section className="confirm-modal"><h2>{title}</h2><p>{text}</p><div className="modal-actions"><button className="outline-danger" onClick={onCancel} disabled={saving}>キャンセル</button><button className="primary-action" onClick={() => void confirm()} disabled={saving}>{saving ? '処理中…' : '続ける'}</button></div></section></AppDialog> }

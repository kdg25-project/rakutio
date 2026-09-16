import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react'

import { calculateTransaction, MoneyCalculationError } from '../domain/money'
import type { ReceiptExtraction } from '../ocr/receipt'
import type { LedgerCategory, LedgerSummary, LedgerTransaction, LedgerTransactionInput } from '../server/ledger/types'

type Page = 'home' | 'history' | 'entry' | 'receipt' | 'analytics' | 'settings' | 'categories' | 'budget' | 'assets' | 'recurring'
type Notice = { kind: 'success' | 'error'; text: string } | undefined
type ApiErrorBody = { error?: { message?: unknown } }
type OcrResponse = { receipt?: ReceiptExtraction; receiptId?: string; error?: { message?: unknown } }
type EditorItem = { id?: string; name: string; originalAmount: number; discountAmount: number; categoryId: string }

const pages: Array<{ id: Page; label: string; icon: string }> = [
  { id: 'home', label: 'ホーム', icon: '⌂' }, { id: 'history', label: '履歴', icon: '☷' },
  { id: 'entry', label: '新規登録', icon: '＋' }, { id: 'analytics', label: '分析', icon: '▥' }, { id: 'settings', label: '設定', icon: '⚙' },
]

function monthNow() { return new Date().toISOString().slice(0, 7) }
function dateNow() { return new Date().toISOString().slice(0, 10) }
function yen(value: number) { return `¥ ${new Intl.NumberFormat('ja-JP').format(value)}` }
function dateLabel(value: string) { return new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${value}T00:00:00`)) }
function apiError(body: ApiErrorBody | undefined, fallback: string) {
  return typeof body?.error?.message === 'string' ? body.error.message : fallback
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  })
  const body = await response.json().catch(() => undefined) as T & ApiErrorBody | undefined
  if (!response.ok) throw new Error(apiError(body, '操作を完了できませんでした。'))
  return body as T
}

function EmptyState({ text }: { text: string }) { return <div className="empty-state"><span>○</span><p>{text}</p></div> }

function Loading() { return <div className="loading"><span className="spinner" />読み込み中…</div> }

export function LedgerApp({ userName, onSignOut }: { userName: string; onSignOut: () => Promise<void> }) {
  const [page, setPage] = useState<Page>('home')
  const [month, setMonth] = useState(monthNow)
  const [summary, setSummary] = useState<LedgerSummary>()
  const [categories, setCategories] = useState<LedgerCategory[]>([])
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([])
  const [selected, setSelected] = useState<LedgerTransaction>()
  const [editing, setEditing] = useState<LedgerTransaction>()
  const [receiptInput, setReceiptInput] = useState<{ receiptId: string; extraction: ReceiptExtraction }>()
  const [notice, setNotice] = useState<Notice>()
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    setLoading(true)
    try {
      const [summaryResult, categoryResult, transactionResult] = await Promise.all([
        request<{ summary: LedgerSummary }>(`/api/ledger/summary?month=${encodeURIComponent(month)}`),
        request<{ categories: LedgerCategory[] }>('/api/ledger/categories/'),
        request<{ transactions: LedgerTransaction[] }>(`/api/ledger/transactions/?month=${encodeURIComponent(month)}&limit=100`),
      ])
      setSummary(summaryResult.summary); setCategories(categoryResult.categories); setTransactions(transactionResult.transactions)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'データを読み込めませんでした。' })
    } finally { setLoading(false) }
  }

  useEffect(() => { void refresh() }, [month])
  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(undefined), 4800)
    return () => window.clearTimeout(timeout)
  }, [notice])

  function openEntry(transaction?: LedgerTransaction, receipt?: { receiptId: string; extraction: ReceiptExtraction }) {
    setEditing(transaction); setReceiptInput(receipt); setSelected(undefined); setPage('entry')
  }

  async function saveTransaction(transaction: LedgerTransactionInput, revision?: number) {
    try {
      if (editing && revision) {
        await request<{ transaction: LedgerTransaction }>(`/api/ledger/transactions/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: JSON.stringify({ revision, transaction }) })
        setNotice({ kind: 'success', text: '明細を更新しました。' })
      } else {
        await request<{ transaction: LedgerTransaction }>('/api/ledger/transactions/', { method: 'POST', body: JSON.stringify({ transaction, idempotencyKey: crypto.randomUUID() }) })
        setNotice({ kind: 'success', text: '明細を登録しました。' })
      }
      setEditing(undefined); setReceiptInput(undefined); setPage('history'); await refresh()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '明細を保存できませんでした。' })
    }
  }

  async function removeTransaction(transaction: LedgerTransaction) {
    if (!window.confirm('この明細を削除しますか？')) return
    try {
      await request<void>(`/api/ledger/transactions/${encodeURIComponent(transaction.id)}`, { method: 'DELETE', body: JSON.stringify({ revision: transaction.revision }) })
      setSelected(undefined); setNotice({ kind: 'success', text: '明細を削除しました。' }); await refresh()
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : '削除できませんでした。' }) }
  }

  return (
    <div className="ledger-shell">
      <header className="ledger-topbar"><button className="plain-button" onClick={() => setPage('settings')} aria-label="設定を開く">☰</button><div><p className="date-kicker">{month.replace('-', '年')}月</p><strong>家計簿</strong></div><button className="avatar" onClick={() => setPage('settings')} aria-label="設定">{userName.slice(0, 1)}</button></header>
      <main className="ledger-main">
        {loading && page !== 'entry' && page !== 'receipt' ? <Loading /> : (
          <>
            {page === 'home' && <HomeScreen summary={summary} transactions={transactions} onPage={setPage} onSelect={setSelected} />}
            {page === 'history' && <HistoryScreen month={month} setMonth={setMonth} transactions={transactions} summary={summary} onSelect={setSelected} />}
            {page === 'entry' && <TransactionEditor categories={categories} transaction={editing} receipt={receiptInput} onCancel={() => setPage(editing ? 'history' : 'home')} onSave={saveTransaction} />}
            {page === 'receipt' && <ReceiptFlow onUseReceipt={(receipt) => openEntry(undefined, receipt)} />}
            {page === 'analytics' && <AnalyticsScreen summary={summary} />}
            {page === 'categories' && <CategoriesScreen categories={categories} onChanged={refresh} notify={setNotice} />}
            {page === 'budget' && <MonthTargetScreen month={month} />}
            {page === 'assets' && <AssetsScreen />}
            {page === 'recurring' && <RecurringScreen categories={categories} />}
            {page === 'settings' && <SettingsScreen userName={userName} onPage={setPage} onSignOut={onSignOut} />}
          </>
        )}
      </main>
      {selected && <TransactionDetail transaction={selected} categories={categories} onClose={() => setSelected(undefined)} onEdit={() => openEntry(selected)} onDelete={() => void removeTransaction(selected)} />}
      {notice && <div className={`toast ${notice.kind}`} role="status">{notice.text}</div>}
      <nav className="bottom-nav" aria-label="アプリ内ナビゲーション">{pages.map((item) => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => item.id === 'entry' ? openEntry() : setPage(item.id)}><span>{item.icon}</span>{item.label}</button>)}</nav>
    </div>
  )
}

function HomeScreen({ summary, transactions, onPage, onSelect }: { summary?: LedgerSummary; transactions: LedgerTransaction[]; onPage: (page: Page) => void; onSelect: (transaction: LedgerTransaction) => void }) {
  const income = summary?.incomeCashPaidAmount ?? 0; const expense = summary?.expenseCashPaidAmount ?? 0
  return <div className="screen-stack"><section className="income-card"><p>今月の収支</p><h1>{yen(income - expense)}</h1><div><span>↑ 収入 <b>{yen(income)}</b></span><span>↓ 支出 <b>{yen(expense)}</b></span></div></section><button className="asset-card" onClick={() => onPage('assets')}><span>▣</span><div><small>総資産</small><strong>{yen(summary?.assetActiveTotalAmount ?? 0)}</strong></div><i>›</i></button><section><div className="section-heading"><h2>カテゴリ別の支出</h2><button onClick={() => onPage('analytics')}>すべて見る ›</button></div>{summary?.categories.length ? <div className="category-bubbles">{summary.categories.slice(0, 5).map((category) => <div key={category.id} style={{ backgroundColor: category.color }}><span>{category.name}</span><b>{yen(category.cashPaidAmount)}</b></div>)}</div> : <EmptyState text="今月の支出はまだありません。" />}</section><section><div className="section-heading"><h2>最近の収支</h2><button onClick={() => onPage('history')}>すべて見る ›</button></div>{transactions.length ? <TransactionRows transactions={transactions.slice(0, 4)} onSelect={onSelect} /> : <EmptyState text="最初の明細を登録しましょう。" />}</section></div>
}

function HistoryScreen({ month, setMonth, transactions, summary, onSelect }: { month: string; setMonth: (value: string) => void; transactions: LedgerTransaction[]; summary?: LedgerSummary; onSelect: (transaction: LedgerTransaction) => void }) {
  return <div className="screen-stack"><div className="title-row"><h1>履歴</h1><input aria-label="表示月" type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></div><div className="stat-strip"><span>収入<b>{yen(summary?.incomeCashPaidAmount ?? 0)}</b></span><span>支出<b>{yen(summary?.expenseCashPaidAmount ?? 0)}</b></span><span>収支<b>{yen((summary?.incomeCashPaidAmount ?? 0) - (summary?.expenseCashPaidAmount ?? 0))}</b></span></div>{transactions.length ? <TransactionRows transactions={transactions} onSelect={onSelect} grouped /> : <EmptyState text="この月の明細はありません。" />}</div>
}

function TransactionRows({ transactions, onSelect, grouped = false }: { transactions: LedgerTransaction[]; onSelect: (transaction: LedgerTransaction) => void; grouped?: boolean }) {
  let lastDate = ''
  return <div className="transaction-list">{transactions.map((transaction) => { const heading = grouped && transaction.occurredAt !== lastDate ? (lastDate = transaction.occurredAt, <p className="date-heading" key={`${transaction.id}-date`}>{dateLabel(transaction.occurredAt)}</p>) : null; return <div key={transaction.id}>{heading}<button className="transaction-row" onClick={() => onSelect(transaction)}><span className={`row-icon ${transaction.type}`}>{transaction.type === 'income' ? '↑' : '↓'}</span><span><b>{transaction.title}</b><small>{transaction.merchant || transaction.paymentMethod || '未設定'}</small></span><strong className={transaction.type}>{transaction.type === 'income' ? '+' : '−'} {yen(transaction.cashPaidAmount)}</strong><i>›</i></button></div> })}</div>
}

function TransactionEditor({ categories, transaction, receipt, onCancel, onSave }: { categories: LedgerCategory[]; transaction?: LedgerTransaction; receipt?: { receiptId: string; extraction: ReceiptExtraction }; onCancel: () => void; onSave: (input: LedgerTransactionInput, revision?: number) => Promise<void> }) {
  const extraction = receipt?.extraction
  const [type, setType] = useState<'expense' | 'income'>(transaction?.type ?? 'expense')
  const [title, setTitle] = useState(transaction?.title ?? extraction?.merchant ?? '')
  const [merchant, setMerchant] = useState(transaction?.merchant ?? extraction?.merchant ?? '')
  const [occurredAt, setOccurredAt] = useState(transaction?.occurredAt ?? extraction?.purchasedAt ?? dateNow())
  const [paymentMethod, setPaymentMethod] = useState(transaction?.paymentMethod ?? '')
  const [memo, setMemo] = useState(transaction?.memo ?? '')
  const fallbackCategory = categories[0]?.id ?? ''
  const [items, setItems] = useState<EditorItem[]>(() => transaction?.items.map((item) => ({ id: item.id, name: item.name, originalAmount: item.originalAmount, discountAmount: item.itemDiscountAmount, categoryId: item.categoryId })) ?? extraction?.items.map((item) => ({ name: item.name, originalAmount: item.amount ?? 0, discountAmount: 0, categoryId: fallbackCategory })) ?? [{ name: '', originalAmount: 0, discountAmount: 0, categoryId: fallbackCategory }])
  const [receiptDiscountAmount, setReceiptDiscountAmount] = useState(transaction?.receiptDiscountAmount ?? 0)
  const [pointUsedAmount, setPointUsedAmount] = useState(transaction?.pointUsedAmount ?? 0)
  const [giftCertificateUsedAmount, setGiftCertificateUsedAmount] = useState(transaction?.giftCertificateUsedAmount ?? 0)
  const [inlineError, setInlineError] = useState<string>()
  const calculation = useMemo(() => { try { return calculateTransaction({ items, receiptDiscountAmount, pointUsedAmount, giftCertificateUsedAmount }) } catch (error) { return error instanceof MoneyCalculationError ? error : undefined } }, [items, receiptDiscountAmount, pointUsedAmount, giftCertificateUsedAmount])
  const totals = calculation instanceof Error ? undefined : calculation?.totals

  function updateItem(index: number, key: 'name' | 'categoryId' | 'originalAmount' | 'discountAmount', value: string) { setItems((previous) => previous.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: key === 'name' || key === 'categoryId' ? value : Math.max(0, Number(value) || 0) } : item)) }
  async function submit(event: FormEvent) { event.preventDefault(); if (calculation instanceof Error || !totals) { setInlineError(calculation instanceof Error ? calculation.message : '入力内容を確認してください。'); return }; if (!title.trim()) { setInlineError('タイトルを入力してください。'); return }; setInlineError(undefined); await onSave({ receiptId: receipt?.receiptId ?? transaction?.receiptId, type, occurredAt, title, merchant, memo, paymentMethod, receiptDiscountAmount, pointUsedAmount, giftCertificateUsedAmount, items }, transaction?.revision) }

  return <form className="entry-form screen-stack" onSubmit={submit}><div className="title-row"><button type="button" className="plain-button" onClick={onCancel}>‹</button><h1>{transaction ? '明細を編集' : receipt ? 'レシートを確認' : '明細を追加'}</h1></div>{receipt && <p className="form-note">OCR結果は下書きです。内容を確認・編集してから登録してください。</p>}<div className="segmented"><button type="button" className={type === 'expense' ? 'active expense' : ''} onClick={() => setType('expense')}>支出</button><button type="button" className={type === 'income' ? 'active income' : ''} onClick={() => setType('income')}>収入</button></div><label>タイトル<input value={title} onChange={(event) => setTitle(event.target.value)} required placeholder="例：スーパー" /></label><label>店舗名<input value={merchant} onChange={(event) => setMerchant(event.target.value)} placeholder="任意" /></label><div className="form-grid"><label>日付<input type="date" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} required /></label><label>支払い方法<input value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} placeholder="現金・カードなど" /></label></div><section className="line-items"><div className="section-heading"><h2>明細</h2><button type="button" onClick={() => setItems((previous) => [...previous, { name: '', originalAmount: 0, discountAmount: 0, categoryId: fallbackCategory }])}>＋ 追加</button></div>{items.map((item, index) => <div className="item-editor" key={item.id ?? index}><input aria-label={`品名 ${index + 1}`} value={item.name} onChange={(event) => updateItem(index, 'name', event.target.value)} placeholder="品名" /><input aria-label={`金額 ${index + 1}`} value={item.originalAmount || ''} type="number" min="0" inputMode="numeric" onChange={(event) => updateItem(index, 'originalAmount', event.target.value)} placeholder="金額" /><select aria-label={`カテゴリ ${index + 1}`} value={item.categoryId} onChange={(event) => updateItem(index, 'categoryId', event.target.value)}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><input aria-label={`値引き ${index + 1}`} value={item.discountAmount || ''} type="number" min="0" inputMode="numeric" onChange={(event) => updateItem(index, 'discountAmount', event.target.value)} placeholder="値引き" />{items.length > 1 && <button type="button" className="delete-line" onClick={() => setItems((previous) => previous.filter((_, itemIndex) => itemIndex !== index))}>削除</button>}</div>)}</section>{type === 'expense' && <section className="form-grid"><label>レシート値引き<input type="number" min="0" value={receiptDiscountAmount || ''} onChange={(event) => setReceiptDiscountAmount(Math.max(0, Number(event.target.value) || 0))} /></label><label>ポイント利用<input type="number" min="0" value={pointUsedAmount || ''} onChange={(event) => setPointUsedAmount(Math.max(0, Number(event.target.value) || 0))} /></label><label>商品券利用<input type="number" min="0" value={giftCertificateUsedAmount || ''} onChange={(event) => setGiftCertificateUsedAmount(Math.max(0, Number(event.target.value) || 0))} /></label></section>}<label>メモ<textarea value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="任意" /></label>{totals && <div className="total-box"><span>合計</span><strong>{yen(totals.cashPaidAmount)}</strong><small>値引き {yen(totals.discountAmount)} / 非現金 {yen(totals.nonCashAmount)}</small></div>}{inlineError && <p className="inline-error" role="alert">{inlineError}</p>}<button className="primary-action" type="submit">{transaction ? '変更を保存' : '明細を登録'}</button></form>
}

function ReceiptFlow({ onUseReceipt }: { onUseReceipt: (receipt: { receiptId: string; extraction: ReceiptExtraction }) => void }) {
  const [file, setFile] = useState<File>(); const [error, setError] = useState<string>(); const [reading, setReading] = useState(false); const generation = useRef(0)
  function choose(event: ChangeEvent<HTMLInputElement>) { generation.current += 1; setFile(event.target.files?.[0]); setError(undefined) }
  async function read() { if (!file) return; const current = generation.current + 1; generation.current = current; setReading(true); setError(undefined); try { const form = new FormData(); form.set('image', file); const response = await fetch('/api/ocr/receipt', { method: 'POST', body: form }); const payload = await response.json().catch(() => undefined) as OcrResponse | undefined; if (generation.current !== current) return; if (!response.ok || !payload?.receipt || !payload.receiptId) throw new Error(apiError(payload, 'OCRに失敗しました。')); onUseReceipt({ receiptId: payload.receiptId, extraction: payload.receipt }) } catch (cause) { if (generation.current === current) setError(cause instanceof Error ? cause.message : 'OCRに失敗しました。') } finally { if (generation.current === current) setReading(false) } }
  return <section className="receipt-flow screen-stack"><div className="title-row"><h1>レシートを撮影</h1></div><p>レシート画像を選択すると、内容を読み取って編集画面へ進みます。</p><label className="upload-drop"><span>▧</span><b>{file ? file.name : '画像を選択'}</b><small>PNG / JPEG / WebP、8 MB 以下</small><input type="file" accept="image/png,image/jpeg,image/webp" onChange={choose} disabled={reading} /></label>{error && <p className="inline-error" role="alert">{error}</p>}<button className="primary-action" disabled={!file || reading} onClick={() => void read()}>{reading ? '読み取り中…' : 'この写真で読み取る'}</button></section>
}

function AnalyticsScreen({ summary }: { summary?: LedgerSummary }) { const max = Math.max(...(summary?.categories.map((item) => item.cashPaidAmount) ?? [1]), 1); return <div className="screen-stack"><h1>分析</h1><div className="stat-strip"><span>収入<b>{yen(summary?.incomeCashPaidAmount ?? 0)}</b></span><span>支出<b>{yen(summary?.expenseCashPaidAmount ?? 0)}</b></span></div><section className="chart-card"><h2>カテゴリ別の支出</h2>{summary?.categories.length ? <div className="bar-chart">{summary.categories.map((category) => <div key={category.id}><span>{category.name}</span><i><b style={{ width: `${(category.cashPaidAmount / max) * 100}%`, backgroundColor: category.color }} /></i><strong>{yen(category.cashPaidAmount)}</strong></div>)}</div> : <EmptyState text="表示できる支出データがありません。" />}</section><section className="chart-card"><h2>日別の支出</h2>{summary?.trend.length ? <div className="trend-list">{summary.trend.map((point) => <span key={point.date}><small>{point.date.slice(5)}</small><b>{yen(point.cashPaidAmount)}</b></span>)}</div> : <EmptyState text="表示できる支出データがありません。" />}</section></div> }

function CategoriesScreen({ categories, onChanged, notify }: { categories: LedgerCategory[]; onChanged: () => Promise<void>; notify: (value: Notice) => void }) { const [name, setName] = useState(''); const [saving, setSaving] = useState(false); async function create(event: FormEvent) { event.preventDefault(); if (!name.trim()) return; setSaving(true); try { await request('/api/ledger/categories/', { method: 'POST', body: JSON.stringify({ name }) }); setName(''); await onChanged(); notify({ kind: 'success', text: 'カテゴリを追加しました。' }) } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : '追加できませんでした。' }) } finally { setSaving(false) } } async function remove(category: LedgerCategory) { if (!window.confirm(`「${category.name}」を削除しますか？`)) return; try { await request(`/api/ledger/categories/${encodeURIComponent(category.id)}`, { method: 'DELETE' }); await onChanged(); notify({ kind: 'success', text: 'カテゴリを削除しました。' }) } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : '削除できませんでした。' }) } } return <div className="screen-stack"><h1>カテゴリ管理</h1><form className="inline-form" onSubmit={create}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="カテゴリ名" maxLength={40} /><button disabled={saving}>追加</button></form><div className="settings-list">{categories.map((category) => <div key={category.id}><span className="category-dot" style={{ backgroundColor: category.color }} /><b>{category.name}</b>{!category.isDefault && <button onClick={() => void remove(category)}>削除</button>}</div>)}</div></div> }

function MonthTargetScreen({ month }: { month: string }) { return <EndpointPanel title="予算・目標設定" description={`${month.replace('-', '年')}月の支出予算・収入目標を設定します。`} endpoint={`/api/planning/monthly-targets?month=${encodeURIComponent(month)}`} /> }
function AssetsScreen() { return <EndpointPanel title="総資産" description="銀行口座・現金・商品券の残高を管理します。" endpoint="/api/assets/accounts" /> }
function RecurringScreen({ categories }: { categories: LedgerCategory[] }) { return <EndpointPanel title="定期取引" description={`カテゴリ ${categories.length} 件を使って定期的な収支を登録できます。`} endpoint="/api/planning/recurring-rules" /> }
function EndpointPanel({ title, description, endpoint }: { title: string; description: string; endpoint: string }) { const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle'); const [data, setData] = useState<unknown>(); useEffect(() => { let active = true; setStatus('loading'); void request<unknown>(endpoint).then((result) => { if (active) { setData(result); setStatus('ready') } }).catch(() => { if (active) setStatus('unavailable') }); return () => { active = false } }, [endpoint]); return <div className="screen-stack"><h1>{title}</h1><p>{description}</p>{status === 'loading' && <Loading />}{status === 'unavailable' && <EmptyState text="この機能のデータを読み込めませんでした。設定を確認して再読み込みしてください。" />}{status === 'ready' && <pre className="data-preview">{JSON.stringify(data, null, 2)}</pre>}</div> }

function SettingsScreen({ userName, onPage, onSignOut }: { userName: string; onPage: (page: Page) => void; onSignOut: () => Promise<void> }) { const [signingOut, setSigningOut] = useState(false); async function signOut() { setSigningOut(true); await onSignOut() } return <div className="screen-stack"><h1>設定</h1><section className="profile-card"><span className="avatar">{userName.slice(0, 1)}</span><div><b>{userName}</b><small>プロフィール</small></div></section><div className="settings-list"><button onClick={() => onPage('categories')}>カテゴリ管理 <i>›</i></button><button onClick={() => onPage('budget')}>予算・目標設定 <i>›</i></button><button onClick={() => onPage('assets')}>資産・口座管理 <i>›</i></button><button onClick={() => onPage('recurring')}>定期取引 <i>›</i></button><button className="danger" onClick={() => void signOut()} disabled={signingOut}>{signingOut ? 'ログアウト中…' : 'ログアウト'} <i>›</i></button></div></div> }

function TransactionDetail({ transaction, categories, onClose, onEdit, onDelete }: { transaction: LedgerTransaction; categories: LedgerCategory[]; onClose: () => void; onEdit: () => void; onDelete: () => void }) { const categoriesById = new Map(categories.map((category) => [category.id, category])); return <div className="modal-backdrop" role="presentation"><section className="detail-modal" role="dialog" aria-modal="true" aria-label="明細詳細"><button className="modal-close" onClick={onClose} aria-label="閉じる">×</button><span className={`detail-icon ${transaction.type}`}>{transaction.type === 'income' ? '↑' : '↓'}</span><h2>{transaction.title}</h2><p>{dateLabel(transaction.occurredAt)}</p><strong className="detail-amount">{transaction.type === 'income' ? '+' : '−'} {yen(transaction.cashPaidAmount)}</strong><dl><div><dt>カテゴリ</dt><dd>{transaction.items.map((item) => categoriesById.get(item.categoryId)?.name ?? 'その他').join('・')}</dd></div><div><dt>支払い方法</dt><dd>{transaction.paymentMethod || '未設定'}</dd></div>{transaction.memo && <div><dt>メモ</dt><dd>{transaction.memo}</dd></div>}</dl><section><h3>明細</h3>{transaction.items.map((item) => <p className="detail-line" key={item.id}><span>{item.name}</span><b>{yen(item.paidAmount)}</b></p>)}</section><div className="modal-actions"><button onClick={onDelete} className="outline-danger">削除</button><button onClick={onEdit} className="primary-action">編集</button></div></section></div> }

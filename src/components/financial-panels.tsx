import { FormEvent, KeyboardEvent, ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { assetHistoryRange, subtractCalendarMonths, tokyoToday } from '../lib/jst-date'
import { invalidateViewCache, readViewCache, viewCacheKey, writeViewCache } from '../lib/view-cache'
import type { AssetAccount, AssetEntry, AssetSummary } from '../server/assets/types'
import type { LedgerCategory } from '../server/ledger/types'
import type { MonthlyTarget, RecurringRule, RecurringRunResult } from '../server/planning/service'

import './financial-panels.css'
import './financial-panels-loading.css'

export type FinanceNotice = { kind: 'success' | 'error'; text: string }
type PanelProps = { notify?: (notice: FinanceNotice) => void; onChanged?: () => Promise<void> | void; onBack?: () => void; cacheScope?: string }
type ApiError = { error?: { message?: unknown } }

export { assetHistoryRange, subtractCalendarMonths, tokyoToday }

export function transferAccountOptions(accounts: AssetAccount[], selectedSourceId: string) {
  const active = accounts.filter((account) => !account.isArchived)
  const sourceAccounts = active.filter((account) => account.type === 'bank' || account.type === 'cash')
  const sourceId = sourceAccounts.some((account) => account.id === selectedSourceId) ? selectedSourceId : (sourceAccounts[0]?.id ?? '')
  const destinationAccounts = sourceId ? active.filter((account) => account.id !== sourceId) : []
  return { sourceAccounts, destinationAccounts, sourceId }
}

export function transferSelection(accounts: AssetAccount[], previousSourceId: string, previousDestinationId: string) {
  const { sourceAccounts, destinationAccounts, sourceId } = transferAccountOptions(accounts, previousSourceId)
  const destinationId = destinationAccounts.some((account) => account.id === previousDestinationId) ? previousDestinationId : (destinationAccounts[0]?.id ?? '')
  return { sourceAccounts, destinationAccounts, sourceId, destinationId }
}

/** Keeps the Figma bank-settings list focused on bank accounts while retaining manual assets. */
export function bankSettingsAccounts(accounts: AssetAccount[]) {
  return {
    banks: accounts.filter((account) => account.type === 'bank'),
    otherAssets: accounts.filter((account) => account.type !== 'bank'),
  }
}

const yen = (amount: number) => `¥ ${new Intl.NumberFormat('ja-JP').format(amount)}`
const kindLabel = { bank: '銀行口座', cash: '現金', gift: '商品券' } as const
const bankKindLabel = { ordinary: '普通預金', checking: '当座預金', time: '定期預金' } as const
const entryLabel = { opening: '初期残高', adjustment: '手動調整', transfer: '振替', transaction: '明細連携' } as const

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  const body = await response.json().catch(() => undefined) as (T & ApiError) | undefined
  if (!response.ok) throw new Error(typeof body?.error?.message === 'string' ? body.error.message : '操作を完了できませんでした。通信状況を確認して再試行してください。')
  return body as T
}

type AssetRequest = (url: string, init?: RequestInit) => Promise<unknown>

/** The exact request used by the restore confirmation action. */
export async function restoreAssetAccount(accountId: string, request: AssetRequest = api) {
  await request(`/api/assets/accounts/${encodeURIComponent(accountId)}`, { method: 'PATCH', body: JSON.stringify({ isArchived: false }) })
}

/** Keep success-only UI cleanup on the same path as every asset mutation. */
export async function completeAssetMutation(work: () => Promise<void>, changed: () => Promise<void>, closeSuccessUi: () => void) {
  await work()
  await changed()
  closeSuccessUi()
}

function useNotice(notify?: PanelProps['notify']) {
  const [notice, setNotice] = useState<FinanceNotice>()
  const show = useCallback((next: FinanceNotice) => { setNotice(next); notify?.(next) }, [notify])
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(undefined), 4800); return () => window.clearTimeout(timer) }, [notice])
  return { notice, show }
}

function ErrorRetry({ error, retry }: { error?: string; retry: () => void }) {
  if (!error) return null
  return <div className="finance-error" role="alert"><span>{error}</span><button type="button" onClick={retry}>再読み込み</button></div>
}

function FinancePanelSkeleton({ label }: { label: string }) { return <section className="finance-screen finance-panel-skeleton" aria-label={label} aria-busy="true"><i /><i /><i /></section> }
function FinanceInlineSkeleton({ label }: { label: string }) { return <div className="finance-inline-skeleton" aria-label={label} aria-busy="true"><i /><i /></div> }
function Icon({ name, alt = '' }: { name: string; alt?: string }) { return <img className="finance-icon" src={`/icons/${name}.svg`} alt={alt} /> }
function BackIcon() { return <img className="finance-svg-icon" src="/icons/chevron-left.svg" alt="" /> }
function ChevronIcon() { return <img className="finance-svg-icon" src="/icons/chevron-right.svg" alt="" /> }
function BankIcon() { return <img className="finance-bank-symbol" src="/icons/bank.svg" alt="" /> }
function LockIcon() { return <img className="finance-lock-icon" src="/icons/lock.svg" alt="" /> }

function Dialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    const focusTimer = window.setTimeout(() => {
      const initial = dialog.querySelector<HTMLElement>('[data-finance-initial-focus], input:not([disabled]), select:not([disabled]), button:not([disabled])')
      initial?.focus()
    }, 0)
    return () => {
      window.clearTimeout(focusTimer)
      if (dialog.open) dialog.close()
      previousFocusRef.current?.focus()
    }
  }, [])

  const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])
  const trapFocus = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return
    const controls = focusable()
    if (!controls.length) return
    const first = controls[0]
    const last = controls[controls.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) { event.preventDefault(); first.focus() }
  }

  return <dialog ref={dialogRef} className="finance-dialog" aria-labelledby={titleId} onKeyDown={trapFocus} onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
    <div className="finance-dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="finance-close" disabled={busy} onClick={onClose} aria-label="閉じる">×</button></div>
    {children}
  </dialog>
}

function Confirmation({ title, text, confirmLabel, busy, onCancel, onConfirm }: { title: string; text: string; confirmLabel: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <Dialog title={title} busy={busy} onClose={onCancel}><p className="finance-dialog-copy">{text}</p><div className="finance-dialog-actions"><button type="button" data-finance-initial-focus className="finance-button finance-button-muted" disabled={busy} onClick={onCancel}>キャンセル</button><button type="button" className="finance-button finance-button-danger" disabled={busy} onClick={onConfirm}>{busy ? '処理中…' : confirmLabel}</button></div></Dialog>
}

function amount(value: string) { const parsed = Number(value.replaceAll(',', '').trim()); return Number.isSafeInteger(parsed) ? parsed : NaN }

export function AssetsScreen({ notify, onChanged, onBack, cacheScope }: PanelProps) {
  const { notice, show } = useNotice(notify)
  const cacheKey = viewCacheKey(cacheScope, 'assets', 'include-archived')
  const initialAssets = readViewCache<AssetSummary>(cacheKey)
  const [assets, setAssets] = useState<AssetSummary | undefined>(() => initialAssets)
  const [loading, setLoading] = useState(() => !initialAssets)
  const [error, setError] = useState<string>()
  const [panel, setPanel] = useState<'create' | 'bank-create' | 'transfer' | 'adjust' | 'entries' | 'details' | 'edit'>()
  const [selected, setSelected] = useState<AssetAccount>()
  const [entries, setEntries] = useState<AssetEntry[]>([])
  const [confirmArchive, setConfirmArchive] = useState<AssetAccount>()
  const [confirmRestore, setConfirmRestore] = useState<AssetAccount>()
  const [busy, setBusy] = useState(false)
  const retryRef = useRef<(() => Promise<void>) | undefined>(undefined)
  const load = useCallback(async () => {
    const cached = readViewCache<AssetSummary>(cacheKey)
    if (cached) { setAssets(cached); setLoading(false) } else setLoading(true)
    setError(undefined)
    try {
      const accountResponse = await api<{ assets: AssetSummary }>('/api/assets/accounts/?includeArchived=true')
      setAssets(accountResponse.assets)
      writeViewCache(cacheKey, accountResponse.assets)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '資産を読み込めませんでした。') } finally { setLoading(false) }
  }, [cacheKey])
  useEffect(() => { void load() }, [load])
  const changed = useCallback(async (message: string) => { invalidateViewCache(cacheScope); await load(); await onChanged?.(); show({ kind: 'success', text: message }) }, [cacheScope, load, onChanged, show])
  const closeSuccessUi = useCallback(() => { setPanel(undefined); setConfirmArchive(undefined); setConfirmRestore(undefined) }, [])
  const mutation = useCallback(async (work: () => Promise<void>, message: string) => {
    setBusy(true)
    try { await completeAssetMutation(work, () => changed(message), closeSuccessUi); retryRef.current = undefined }
    catch (cause) { const text = cause instanceof Error ? cause.message : '保存できませんでした。'; show({ kind: 'error', text }); retryRef.current = async () => mutation(work, message) }
    finally { setBusy(false) }
  }, [changed, closeSuccessUi, show])
  const entryRequestRef = useRef(0)
  const entryControllerRef = useRef<AbortController | undefined>(undefined)
  const selectedEntryIdRef = useRef<string | undefined>(undefined)
  const [entriesLoading, setEntriesLoading] = useState(false)
  useEffect(() => () => { entryRequestRef.current += 1; entryControllerRef.current?.abort() }, [])
  const closeEntries = () => {
    entryRequestRef.current += 1
    entryControllerRef.current?.abort()
    selectedEntryIdRef.current = undefined
    setEntriesLoading(false)
    setEntries([])
    setPanel(undefined)
  }
  const openEntries = async (account: AssetAccount) => {
    entryRequestRef.current += 1
    const requestId = entryRequestRef.current
    entryControllerRef.current?.abort()
    const controller = new AbortController()
    entryControllerRef.current = controller
    selectedEntryIdRef.current = account.id
    setSelected(account); setPanel('details'); setEntries([]); setEntriesLoading(true)
    try {
      const response = await api<{ entries: AssetEntry[] }>(`/api/assets/accounts/${encodeURIComponent(account.id)}/entries?limit=100`, { signal: controller.signal })
      if (requestId === entryRequestRef.current && selectedEntryIdRef.current === account.id) setEntries(response.entries)
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') return
      if (requestId === entryRequestRef.current && selectedEntryIdRef.current === account.id) show({ kind: 'error', text: cause instanceof Error ? cause.message : '履歴を読み込めませんでした。' })
    } finally {
      if (requestId === entryRequestRef.current && selectedEntryIdRef.current === account.id) setEntriesLoading(false)
    }
  }
  if (loading && !assets) return <FinancePanelSkeleton label="資産を読み込み中" />
  if (panel === 'bank-create') return <BankAccountRegistrationScreen busy={busy} onBack={() => setPanel(undefined)} onSubmit={(body) => { const idempotencyKey = crypto.randomUUID(); void mutation(() => api('/api/assets/accounts/', { method: 'POST', body: JSON.stringify({ ...body, idempotencyKey }) }), '銀行口座を追加しました。') }} />
  if (panel === 'details' && selected) return <><BankAccountDetailScreen account={selected} entries={entries} loading={entriesLoading} onBack={closeEntries} onAdjust={() => setPanel('adjust')} onEdit={() => setPanel('edit')} onRestore={() => setConfirmRestore(selected)} />{confirmRestore && <Confirmation title="口座を復元しますか？" text="口座を再び総資産に含め、調整や振替に使用できるようにします。" confirmLabel="復元する" busy={busy} onCancel={() => setConfirmRestore(undefined)} onConfirm={() => void mutation(() => restoreAssetAccount(confirmRestore.id), '口座を復元しました。')} />}</>
  const { banks: bankAccounts } = bankSettingsAccounts(assets?.accounts ?? [])
  return <section className="finance-screen finance-bank-screen"><header className="finance-bank-header"><button type="button" onClick={onBack} disabled={!onBack} aria-label="設定に戻る"><BackIcon /></button><h1>銀行口座設定</h1><span aria-hidden="true" /></header>
    <ErrorRetry error={error} retry={() => void load()} />
    {notice && <div className={`finance-toast finance-toast-${notice.kind}`} role="status">{notice.text}{retryRef.current && <button type="button" onClick={() => void retryRef.current?.()}>再試行</button>}</div>}
    <section className="finance-bank-intro"><span className="finance-bank-intro-icon"><BankIcon /></span><p><b>銀行口座を登録して残高を管理できます</b><small>銀行口座の追加に口座情報は必要ありません</small></p></section>
    <section className="finance-bank-list" aria-label="登録済みの銀行口座">{bankAccounts.length ? <ul className="finance-list">{bankAccounts.map((account) => <li key={account.id} className={account.isArchived ? 'finance-muted-row' : ''}><button type="button" className="finance-account-row" onClick={() => void openEntries(account)}><span><b>{account.name}</b><small>{bankKindLabel[account.bankKind ?? 'ordinary']}{account.isArchived ? '・アーカイブ済み' : ''}</small></span><strong>{yen(account.balanceAmount)}</strong><ChevronIcon /></button></li>)}</ul> : <div className="finance-empty finance-bank-empty"><p>登録済みの銀行口座はありません。</p></div>}</section>
    <button type="button" className="finance-bank-add" onClick={() => setPanel('bank-create')}>銀行口座を追加</button>
    {panel === 'create' && <AccountForm busy={busy} onClose={() => setPanel(undefined)} onSubmit={(body) => { const idempotencyKey = crypto.randomUUID(); void mutation(() => api('/api/assets/accounts/', { method: 'POST', body: JSON.stringify({ ...body, idempotencyKey }) }), '資産を追加しました。') }} />}
    {panel === 'edit' && selected && <AccountForm account={selected} busy={busy} onClose={() => setPanel(undefined)} onArchive={() => { setPanel(undefined); setConfirmArchive(selected) }} onRestore={() => { setPanel(undefined); setConfirmRestore(selected) }} onSubmit={(body) => void mutation(() => api(`/api/assets/accounts/${encodeURIComponent(selected.id)}`, { method: 'PATCH', body: JSON.stringify(body) }), '口座設定を更新しました。')} />}
    {panel === 'adjust' && selected && <AdjustmentForm account={selected} busy={busy} onClose={() => setPanel(undefined)} onSubmit={(body) => { const idempotencyKey = crypto.randomUUID(); void mutation(() => api(`/api/assets/accounts/${encodeURIComponent(selected.id)}/adjustments`, { method: 'POST', body: JSON.stringify({ ...body, idempotencyKey }) }), '残高を調整しました。') }} />}
    {panel === 'transfer' && assets && <TransferForm accounts={assets.accounts.filter((account) => !account.isArchived)} busy={busy} onClose={() => setPanel(undefined)} onSubmit={(body) => { const idempotencyKey = crypto.randomUUID(); void mutation(() => api('/api/assets/transfers', { method: 'POST', body: JSON.stringify({ ...body, idempotencyKey }) }), '振替を記録しました。') }} />}
    {confirmArchive && <Confirmation title="口座をアーカイブしますか？" text="残高と履歴は保持されますが、新しい調整や振替には使えなくなります。" confirmLabel="アーカイブする" busy={busy} onCancel={() => setConfirmArchive(undefined)} onConfirm={() => void mutation(() => api(`/api/assets/accounts/${encodeURIComponent(confirmArchive.id)}`, { method: 'PATCH', body: JSON.stringify({ isArchived: true }) }), '口座をアーカイブしました。')} />}
    {confirmRestore && <Confirmation title="口座を復元しますか？" text="口座を再び総資産に含め、調整や振替に使用できるようにします。" confirmLabel="復元する" busy={busy} onCancel={() => setConfirmRestore(undefined)} onConfirm={() => void mutation(() => restoreAssetAccount(confirmRestore.id), '口座を復元しました。')} />}
  </section>
}

function AccountForm({ account, busy, onClose, onArchive, onRestore, onSubmit }: { account?: AssetAccount; busy: boolean; onClose: () => void; onArchive?: () => void; onRestore?: () => void; onSubmit: (body: { type: AssetAccount['type']; name: string; initialBalanceAmount?: number }) => void }) {
  const [name, setName] = useState(account?.name ?? ''); const [type, setType] = useState<AssetAccount['type']>(account?.type ?? 'bank'); const [initial, setInitial] = useState(account ? '' : '0'); const [formError, setFormError] = useState('')
  const submit = (event: FormEvent) => { event.preventDefault(); const initialBalanceAmount = amount(initial); if (!name.trim()) return setFormError('口座名を入力してください。'); if (!account && !Number.isSafeInteger(initialBalanceAmount)) return setFormError('初期残高は整数円で入力してください。'); onSubmit({ type, name: name.trim(), ...(account ? {} : { initialBalanceAmount }) }) }
  return <Dialog title={account ? '口座を編集' : '資産を追加'} busy={busy} onClose={onClose}><form className="finance-form" onSubmit={submit}>{formError && <p className="finance-form-error">{formError}</p>}<label>種類<select value={type} disabled={Boolean(account)} onChange={(event) => setType(event.target.value as AssetAccount['type'])}><option value="bank">銀行口座</option><option value="cash">現金</option><option value="gift">商品券</option></select></label><label>名前<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder={type === 'bank' ? '例）ゆうちょ銀行' : type === 'cash' ? '例）財布' : '例）商品券'} /></label>{!account && <label>初期残高（円）<input inputMode="numeric" value={initial} onChange={(event) => setInitial(event.target.value)} /></label>}<p className="finance-form-help">銀行連携は行いません。残高はこのアプリ内で管理されます。</p><div className="finance-dialog-actions">{account?.isArchived ? <button type="button" className="finance-button finance-button-muted" disabled={busy} onClick={onRestore}>復元する</button> : onArchive && <button type="button" className="finance-text-danger" disabled={busy} onClick={onArchive}>アーカイブ</button>}<button type="submit" className="finance-button" disabled={busy}>{busy ? '保存中…' : account ? '保存する' : '追加する'}</button></div></form></Dialog>
}

function BankAccountRegistrationScreen({ busy, onBack, onSubmit }: { busy: boolean; onBack: () => void; onSubmit: (body: { type: 'bank'; name: string; bankKind: 'ordinary' | 'checking' | 'time'; bankMemo: string }) => void }) {
  const [name, setName] = useState('')
  const [accountKind, setAccountKind] = useState<'ordinary' | 'checking' | 'time'>('ordinary')
  const [memo, setMemo] = useState('')
  const [formError, setFormError] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return setFormError('銀行名を入力してください。')
    if (memo.trim().length > 500) return setFormError('メモは 500 文字以下で入力してください。')
    onSubmit({ type: 'bank', name: name.trim(), bankKind: accountKind, bankMemo: memo })
  }
  return <section className="finance-screen finance-bank-registration" aria-label="銀行口座登録">
    <header className="finance-bank-header"><button type="button" onClick={onBack} aria-label="銀行口座設定に戻る"><BackIcon /></button><h1>銀行口座登録</h1><span aria-hidden="true" /></header>
    <form className="finance-form finance-bank-form" onSubmit={submit}>
      {formError && <p className="finance-form-error">{formError}</p>}
      <label>銀行名<input value={name} maxLength={80} placeholder="例）なんちゃら銀行" onChange={(event) => setName(event.target.value)} /></label>
      <label>種類<select value={accountKind} onChange={(event) => setAccountKind(event.target.value as 'ordinary' | 'checking' | 'time')}><option value="ordinary">普通預金</option><option value="checking">当座預金</option><option value="time">定期預金</option></select></label>
      <label>メモ（任意）<textarea value={memo} maxLength={500} placeholder="メモを入力" onChange={(event) => setMemo(event.target.value)} /></label>
      <p className="finance-bank-security"><LockIcon /><span>登録した銀行情報は、安全に保存されます。</span></p>
      <button type="submit" className="finance-bank-add" disabled={busy}>{busy ? '追加中…' : '銀行口座を追加'}</button>
    </form>
  </section>
}

function BankAccountDetailScreen({ account, entries, loading, onBack, onAdjust, onEdit, onRestore }: { account: AssetAccount; entries: AssetEntry[]; loading: boolean; onBack: () => void; onAdjust: () => void; onEdit: () => void; onRestore: () => void }) {
  return <section className="finance-screen finance-bank-detail" aria-label={`${account.name}の詳細`}><header className="finance-bank-header"><button type="button" onClick={onBack} aria-label="銀行口座設定に戻る"><BackIcon /></button><h1>{account.name}</h1><span aria-hidden="true" /></header><section className="finance-bank-detail-summary"><small>{bankKindLabel[account.bankKind ?? 'ordinary']}</small><strong>{yen(account.balanceAmount)}</strong>{account.bankMemo && <p>{account.bankMemo}</p>}</section><section className="finance-bank-detail-actions">{account.isArchived ? <button type="button" className="finance-button" onClick={onRestore}>復元する</button> : <><button type="button" className="finance-button finance-button-muted" onClick={onAdjust}>残高を調整</button><button type="button" className="finance-button" onClick={onEdit}>編集</button></>}</section><section className="finance-bank-entry-history"><h2>履歴</h2><div className="finance-entry-list">{loading ? <FinanceInlineSkeleton label="履歴を読み込み中" /> : entries.length ? entries.map((entry) => <div key={entry.id}><span><b>{entryLabel[entry.kind]}</b><small>{entry.occurredAt}{entry.memo ? `・${entry.memo}` : ''}</small></span><strong className={entry.amount < 0 ? 'finance-negative' : ''}>{entry.amount > 0 ? '+' : ''}{yen(entry.amount)}</strong></div>) : <p className="finance-empty-inline">履歴はまだありません。</p>}</div></section></section>
}

function AdjustmentForm({ account, busy, onClose, onSubmit }: { account: AssetAccount; busy: boolean; onClose: () => void; onSubmit: (body: { amount: number; occurredAt: string; memo: string }) => void }) {
  const [value, setValue] = useState(''); const [occurredAt, setOccurredAt] = useState(tokyoToday()); const [memo, setMemo] = useState(''); const [error, setError] = useState('')
  const submit = (event: FormEvent) => { event.preventDefault(); const parsed = amount(value); if (!Number.isSafeInteger(parsed) || parsed === 0) return setError('増減額は 0 以外の整数円で入力してください。'); onSubmit({ amount: parsed, occurredAt, memo }) }
  return <Dialog title={`${account.name} の残高を調整`} busy={busy} onClose={onClose}><form className="finance-form" onSubmit={submit}>{error && <p className="finance-form-error">{error}</p>}<p className="finance-form-help">現在の残高: <b>{yen(account.balanceAmount)}</b>。増額は正数、減額は負数で入力します。</p><label>増減額（円）<input autoFocus inputMode="numeric" value={value} placeholder="例）-500" onChange={(event) => setValue(event.target.value)} /></label><label>日付<input type="date" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label><label>メモ（任意）<input value={memo} maxLength={1000} onChange={(event) => setMemo(event.target.value)} /></label><button type="submit" className="finance-button" disabled={busy}>{busy ? '保存中…' : '調整を保存'}</button></form></Dialog>
}

function TransferForm({ accounts, busy, onClose, onSubmit }: { accounts: AssetAccount[]; busy: boolean; onClose: () => void; onSubmit: (body: { fromAccountId: string; toAccountId: string; amount: number; occurredAt: string; memo: string }) => void }) {
  const [fromAccountId, setFrom] = useState(''); const [toAccountId, setTo] = useState(''); const [value, setValue] = useState(''); const [occurredAt, setOccurredAt] = useState(tokyoToday()); const [memo, setMemo] = useState(''); const [error, setError] = useState('')
  const selection = useMemo(() => transferSelection(accounts, fromAccountId, toAccountId), [accounts, fromAccountId, toAccountId])
  useEffect(() => {
    if (selection.sourceId !== fromAccountId) setFrom(selection.sourceId)
    if (selection.destinationId !== toAccountId) setTo(selection.destinationId)
  }, [fromAccountId, selection.destinationId, selection.sourceId, toAccountId])
  const disabled = busy || !selection.sourceAccounts.length || !selection.destinationAccounts.length
  const submit = (event: FormEvent) => { event.preventDefault(); const parsed = amount(value); if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) return setError('振替元と振替先に異なる口座を選択してください。'); if (!Number.isSafeInteger(parsed) || parsed <= 0) return setError('金額は 1 円以上の整数で入力してください。'); onSubmit({ fromAccountId, toAccountId, amount: parsed, occurredAt, memo }) }
  return <Dialog title="振替・商品券の購入" busy={busy} onClose={onClose}><form className="finance-form" onSubmit={submit}>{error && <p className="finance-form-error">{error}</p>}<p className="finance-form-help">商品券の購入は支出明細ではなく、支払元から商品券への振替として記録します。</p>{!selection.sourceAccounts.length ? <p className="finance-form-error">振替元になる銀行口座か現金を追加してください。商品券だけでは振替できません。</p> : !selection.destinationAccounts.length ? <p className="finance-form-error">振替先となる別の口座を追加してください。</p> : <><label>振替元<select value={fromAccountId} disabled={disabled} onChange={(event) => setFrom(event.target.value)}>{selection.sourceAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}（{yen(account.balanceAmount)}）</option>)}</select></label><label>振替先<select value={toAccountId} disabled={disabled} onChange={(event) => setTo(event.target.value)}>{selection.destinationAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}（{kindLabel[account.type]}）</option>)}</select></label></>}<label>金額（円）<input disabled={disabled} inputMode="numeric" value={value} onChange={(event) => setValue(event.target.value)} /></label><label>日付<input disabled={disabled} type="date" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label><label>メモ（任意）<input disabled={disabled} value={memo} onChange={(event) => setMemo(event.target.value)} /></label><button type="submit" className="finance-button" disabled={disabled}>{busy ? '保存中…' : '振替を記録'}</button></form></Dialog>
}

export function MonthTargetScreen({ month, notify, onChanged, cacheScope }: PanelProps & { month: string }) {
  const cacheKey = viewCacheKey(cacheScope, 'monthly-target', month)
  const initialTargetCache = readViewCache<{ target: MonthlyTarget | undefined }>(cacheKey)
  const { notice, show } = useNotice(notify); const [target, setTarget] = useState<MonthlyTarget | undefined>(() => initialTargetCache?.target); const [loading, setLoading] = useState(() => !initialTargetCache); const [error, setError] = useState<string>(); const [editing, setEditing] = useState(false); const [busy, setBusy] = useState(false); const [confirmDelete, setConfirmDelete] = useState(false); const retryRef = useRef<(() => Promise<void>) | undefined>(undefined)
  const load = useCallback(async () => { const cached = readViewCache<{ target: MonthlyTarget | undefined }>(cacheKey); if (cached) { setTarget(cached.target); setLoading(false) } else setLoading(true); setError(undefined); try { const next = (await api<{ targets: MonthlyTarget[] }>(`/api/planning/monthly-targets/?month=${encodeURIComponent(month)}`)).targets[0]; setTarget(next); writeViewCache(cacheKey, { target: next }) } catch (cause) { setError(cause instanceof Error ? cause.message : '予算・目標を読み込めませんでした。') } finally { setLoading(false) } }, [cacheKey, month])
  useEffect(() => { void load() }, [load])
  const mutate = async (work: () => Promise<void>, message: string) => { setBusy(true); try { await work(); retryRef.current = undefined; invalidateViewCache(cacheScope); await load(); await onChanged?.(); show({ kind: 'success', text: message }); setEditing(false); setConfirmDelete(false) } catch (cause) { show({ kind: 'error', text: cause instanceof Error ? cause.message : '保存できませんでした。' }); retryRef.current = () => mutate(work, message) } finally { setBusy(false) } }
  if (loading && !target) return <FinancePanelSkeleton label="予算・目標を読み込み中" />
  return <section className="finance-screen"><header className="finance-title-row"><div><p className="finance-kicker">{month.replace('-', '年')}月</p><h1>予算・目標設定</h1></div>{target && <button className="finance-icon-button" type="button" onClick={() => setEditing(true)}>✎<small>編集</small></button>}</header><ErrorRetry error={error} retry={() => void load()} />{notice && <div className={`finance-toast finance-toast-${notice.kind}`} role="status">{notice.text}{retryRef.current && <button type="button" onClick={() => void retryRef.current?.()}>再試行</button>}</div>}{target && !editing ? <TargetSummary target={target} onEdit={() => setEditing(true)} onDelete={() => setConfirmDelete(true)} /> : <TargetForm target={target} busy={busy} onSubmit={(payload) => void mutate(() => target ? api(`/api/planning/monthly-targets/${encodeURIComponent(target.id)}`, { method: 'PATCH', body: JSON.stringify(payload) }) : api('/api/planning/monthly-targets/', { method: 'POST', body: JSON.stringify({ month, ...payload }) }), target ? '予算・目標を更新しました。' : '予算・目標を設定しました。')} />}{confirmDelete && target && <Confirmation title="この月の設定を削除しますか？" text="予算・目標だけを削除します。登録済みの収支明細は削除されません。" confirmLabel="設定を削除" busy={busy} onCancel={() => setConfirmDelete(false)} onConfirm={() => void mutate(() => api(`/api/planning/monthly-targets/${encodeURIComponent(target.id)}`, { method: 'DELETE' }), '予算・目標を削除しました。')} />}</section>
}

function TargetSummary({ target, onEdit, onDelete }: { target: MonthlyTarget; onEdit: () => void; onDelete: () => void }) { const rows = [{ label: '月の予算（支出）', tone: 'expense', target: target.expenseTargetAmount, actual: target.expenseActualAmount, progress: target.expenseProgress }, { label: '月の目標（収入）', tone: 'income', target: target.incomeTargetAmount, actual: target.incomeActualAmount, progress: target.incomeProgress }] as const; return <><div className="finance-target-list">{rows.map((row) => <article className="finance-target" key={row.tone}><div><h2>{row.label}</h2><strong>{yen(row.target)}</strong><p>実績 {yen(row.actual)}</p></div><div className={`finance-progress finance-progress-${row.tone}`}><i style={{ width: `${Math.min(100, Math.round((row.progress ?? 0) * 100))}%` }} /><span>{row.progress == null ? '目標額を入力してください' : `${Math.round(row.progress * 100)}%`}</span></div></article>)}</div><p className="finance-form-help">設定した予算・目標はホームと分析で実績と比較できます。</p><div className="finance-actions"><button type="button" className="finance-button" onClick={onEdit}>金額を編集</button><button type="button" className="finance-text-danger" onClick={onDelete}>この月の設定を削除</button></div></> }
function TargetForm({ target, busy, onSubmit }: { target?: MonthlyTarget; busy: boolean; onSubmit: (body: { expenseTargetAmount: number; incomeTargetAmount: number }) => void }) { const [expense, setExpense] = useState(target ? String(target.expenseTargetAmount) : ''); const [income, setIncome] = useState(target ? String(target.incomeTargetAmount) : ''); const [error, setError] = useState(''); const submit = (event: FormEvent) => { event.preventDefault(); const expenseTargetAmount = amount(expense), incomeTargetAmount = amount(income); if (!Number.isSafeInteger(expenseTargetAmount) || expenseTargetAmount < 0 || !Number.isSafeInteger(incomeTargetAmount) || incomeTargetAmount < 0) return setError('支出予算と収入目標は 0 以上の整数円で入力してください。'); onSubmit({ expenseTargetAmount, incomeTargetAmount }) }; return <form className="finance-form finance-card" onSubmit={submit}><h2>{target ? '金額を編集' : '今月の予算・目標を設定'}</h2>{error && <p className="finance-form-error">{error}</p>}<label>月の予算（支出）<input inputMode="numeric" value={expense} placeholder="例）100000" onChange={(event) => setExpense(event.target.value)} /></label><label>月の目標（収入）<input inputMode="numeric" value={income} placeholder="例）300000" onChange={(event) => setIncome(event.target.value)} /></label><button type="submit" className="finance-button" disabled={busy}>{busy ? '保存中…' : '保存する'}</button></form> }

export function RecurringScreen({ notify, onChanged, cacheScope }: PanelProps) {
  const cacheKey = viewCacheKey(cacheScope, 'recurring', 'active')
  const initialRecurringCache = readViewCache<{ rules: RecurringRule[]; categories: LedgerCategory[]; accounts: AssetAccount[] }>(cacheKey)
  const { notice, show } = useNotice(notify); const [rules, setRules] = useState<RecurringRule[]>(() => initialRecurringCache?.rules ?? []); const [categories, setCategories] = useState<LedgerCategory[]>(() => initialRecurringCache?.categories ?? []); const [accounts, setAccounts] = useState<AssetAccount[]>(() => initialRecurringCache?.accounts ?? []); const [loading, setLoading] = useState(() => !initialRecurringCache); const [error, setError] = useState<string>(); const [editing, setEditing] = useState<RecurringRule | 'new'>(); const [confirmStop, setConfirmStop] = useState<RecurringRule>(); const [runResult, setRunResult] = useState<RecurringRunResult>(); const [busy, setBusy] = useState(false); const retryRef = useRef<(() => Promise<void>) | undefined>(undefined)
  const load = useCallback(async () => { const cached = readViewCache<{ rules: RecurringRule[]; categories: LedgerCategory[]; accounts: AssetAccount[] }>(cacheKey); if (cached) { setRules(cached.rules); setCategories(cached.categories); setAccounts(cached.accounts); setLoading(false) } else setLoading(true); setError(undefined); try { const [ruleResponse, categoryResponse, assetResponse] = await Promise.all([api<{ rules: RecurringRule[] }>('/api/planning/recurring-rules/'), api<{ categories: LedgerCategory[] }>('/api/ledger/categories/'), api<{ assets: AssetSummary }>('/api/assets/accounts/?includeArchived=false')]); const nextAccounts = assetResponse.assets.accounts.filter((account) => account.type !== 'gift'); setRules(ruleResponse.rules); setCategories(categoryResponse.categories); setAccounts(nextAccounts); writeViewCache(cacheKey, { rules: ruleResponse.rules, categories: categoryResponse.categories, accounts: nextAccounts }) } catch (cause) { setError(cause instanceof Error ? cause.message : '定期支出を読み込めませんでした。') } finally { setLoading(false) } }, [cacheKey])
  useEffect(() => { void load() }, [load])
  const mutate = async (work: () => Promise<void>, message: string) => { setBusy(true); try { await work(); retryRef.current = undefined; invalidateViewCache(cacheScope); await load(); await onChanged?.(); show({ kind: 'success', text: message }); setEditing(undefined); setConfirmStop(undefined) } catch (cause) { show({ kind: 'error', text: cause instanceof Error ? cause.message : '保存できませんでした。' }); retryRef.current = () => mutate(work, message) } finally { setBusy(false) } }
  const catchUp = () => void mutate(async () => { const response = await api<{ result: RecurringRunResult }>('/api/planning/recurring-rules/run', { method: 'POST' }); const result = response.result; setRunResult(result); if (result.failed) throw new Error(`${result.failed} 件の作成に失敗しました。内容を確認して再試行してください。`) }, '定期支出の確認を完了しました。')
  if (loading && !rules.length && !categories.length && !accounts.length) return <FinancePanelSkeleton label="定期支出を読み込み中" />
  return <section className="finance-screen"><header className="finance-title-row"><div><p className="finance-kicker">定期支出</p><h1>毎月の支払い</h1></div><button type="button" className="finance-icon-button" onClick={() => setEditing('new')}>＋<small>追加</small></button></header><ErrorRetry error={error} retry={() => void load()} />{notice && <div className={`finance-toast finance-toast-${notice.kind}`} role="status">{notice.text}{retryRef.current && <button type="button" onClick={() => void retryRef.current?.()}>再試行</button>}</div>}<div className="finance-card finance-run-card"><div><h2>未登録月を確認</h2><p>開始日から今日までの未作成分を、同じルールで安全に作成します。</p></div><button type="button" className="finance-button finance-button-secondary" disabled={busy} onClick={catchUp}>{busy ? '確認中…' : '今すぐ確認'}</button></div>{runResult && <div className="finance-run-result" role="status"><b>確認結果</b><span>作成 {runResult.created} 件 / 重複スキップ {runResult.skipped} 件 / 失敗 {runResult.failed} 件{runResult.hasMore ? ' / 続きがあります' : ''}</span></div>}<section className="finance-card">{rules.length ? <ul className="finance-list">{rules.map((rule) => <li key={rule.id} className={!rule.active ? 'finance-muted-row' : ''}><button type="button" className="finance-rule-row" onClick={() => setEditing(rule)}><span className="finance-category-icon"><Icon name={rule.title.includes('電') ? 'category-utility' : rule.title.includes('サブ') ? 'category-subscription' : 'category-other'} /></span><span><b>{rule.title}</b><small>毎月{rule.paymentDay}日・{rule.active ? '有効' : '停止中'}{rule.lastGeneratedMonth ? `・最終 ${rule.lastGeneratedMonth}` : ''}</small></span><strong>{yen(rule.amount)}</strong></button><div className="finance-row-actions"><button type="button" onClick={() => setEditing(rule)}>{rule.active ? '編集' : '確認・再開'}</button>{rule.active ? <button type="button" className="finance-text-danger" onClick={() => setConfirmStop(rule)}>停止</button> : <button type="button" onClick={() => void mutate(() => api(`/api/planning/recurring-rules/${encodeURIComponent(rule.id)}`, { method: 'PATCH', body: JSON.stringify({ active: true }) }), '定期支出を再開しました。')}>再開</button>}</div></li>)}</ul> : <div className="finance-empty"><Icon name="category-subscription" /><p>サブスクや家賃など、毎月の支払いを登録できます。</p><button type="button" className="finance-button" onClick={() => setEditing('new')}>定期支出を追加</button></div>}</section>{editing && <RecurringForm rule={editing === 'new' ? undefined : editing} categories={categories} accounts={accounts} busy={busy} onClose={() => setEditing(undefined)} onSubmit={(body) => void mutate(() => editing === 'new' ? api('/api/planning/recurring-rules/', { method: 'POST', body: JSON.stringify(body) }) : api(`/api/planning/recurring-rules/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: JSON.stringify(body) }), editing === 'new' ? '定期支出を追加しました。' : '定期支出を更新しました。')} />}{confirmStop && <Confirmation title="定期支出を停止しますか？" text="作成済みの明細と履歴は残ります。あとから再開できます。" confirmLabel="停止する" busy={busy} onCancel={() => setConfirmStop(undefined)} onConfirm={() => void mutate(() => api(`/api/planning/recurring-rules/${encodeURIComponent(confirmStop.id)}`, { method: 'DELETE' }), '定期支出を停止しました。')} />}</section>
}

function RecurringForm({ rule, categories, accounts, busy, onClose, onSubmit }: { rule?: RecurringRule; categories: LedgerCategory[]; accounts: AssetAccount[]; busy: boolean; onClose: () => void; onSubmit: (body: Record<string, unknown>) => void }) {
  const [title, setTitle] = useState(rule?.title ?? ''); const [value, setValue] = useState(rule ? String(rule.amount) : ''); const [categoryId, setCategory] = useState(rule?.categoryId ?? categories.find((category) => category.name === 'サブスク')?.id ?? categories[0]?.id ?? ''); const [paymentMethod, setPayment] = useState(rule?.paymentMethod ?? 'カード'); const [accountId, setAccount] = useState(rule?.accountId ?? ''); const [paymentDay, setPaymentDay] = useState(rule ? String(rule.paymentDay) : '1'); const [startDate, setStartDate] = useState(rule?.startDate ?? tokyoToday()); const [endDate, setEndDate] = useState(rule?.endDate ?? ''); const [error, setError] = useState('')
  const submit = (event: FormEvent) => { event.preventDefault(); const parsedAmount = amount(value), parsedDay = Number(paymentDay); if (!title.trim() || !categoryId) return setError('項目名とカテゴリを選択してください。'); if (!Number.isSafeInteger(parsedAmount) || parsedAmount <= 0) return setError('金額は 1 円以上の整数で入力してください。'); if (!Number.isInteger(parsedDay) || parsedDay < 1 || parsedDay > 31) return setError('支払日は 1 から 31 の範囲で指定してください。'); onSubmit({ title: title.trim(), amount: parsedAmount, categoryId, paymentMethod, accountId: accountId || null, paymentDay: parsedDay, startDate, endDate: endDate || null, active: true }) }
  return <Dialog title={rule ? '定期支出を編集' : '定期支出を追加'} busy={busy} onClose={onClose}><form className="finance-form" onSubmit={submit}>{error && <p className="finance-form-error">{error}</p>}<label>項目名<input value={title} placeholder="例）Netflix" maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label><label>金額（円）<input inputMode="numeric" value={value} onChange={(event) => setValue(event.target.value)} /></label><label>カテゴリ<select value={categoryId} onChange={(event) => setCategory(event.target.value)}>{categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label><label>支払い方法<input value={paymentMethod} maxLength={50} onChange={(event) => setPayment(event.target.value)} placeholder="例）カード" /></label><label>支払い口座（任意）<select value={accountId} onChange={(event) => setAccount(event.target.value)}><option value="">口座を紐付けない</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><div className="finance-form-grid"><label>支払日<select value={paymentDay} onChange={(event) => setPaymentDay(event.target.value)}>{Array.from({ length: 31 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}日</option>)}</select></label><label>開始日<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label></div><label>終了日（任意）<input type="date" value={endDate} min={startDate} onChange={(event) => setEndDate(event.target.value)} /></label><button type="submit" className="finance-button" disabled={busy}>{busy ? '保存中…' : rule ? '更新する' : '追加する'}</button></form></Dialog>
}

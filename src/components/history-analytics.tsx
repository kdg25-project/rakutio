import {
  FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  LedgerCategory,
  LedgerSummary,
  LedgerTransaction,
  LedgerTransactionType,
} from "../server/ledger/types";
import type { AssetAccount, AssetSummary } from "../server/assets/types";

import "./history-analytics.css";

type ApiError = { error?: { message?: unknown } };
type TransactionResponse = {
  transactions: LedgerTransaction[];
  nextCursor: string | null;
};
type SummaryResponse = { summary: LedgerSummary };
type Notice = { message: string; retry: () => void };

type HistoryFilter = {
  type: "" | LedgerTransactionType;
  categoryId: string;
  merchant: string;
  from: string;
  to: string;
  minAmount: string;
  maxAmount: string;
};

type Drilldown = "income" | "expense" | "category" | "utility" | "fixed";
type Period = "month" | "year" | "custom";
type AnalyticsView = "cashflow" | "assets";
type AnalyticsRange = {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
};
type AnalyticsPoint = {
  date?: string;
  month?: string;
  incomeAmount?: number;
  expenseAmount?: number;
  netAmount?: number;
  fixedExpenseAmount?: number;
  electricity?: number;
  gas?: number;
  water?: number;
  other?: number;
  paidAmount?: number;
};
type AnalyticsResponse = {
  range: AnalyticsRange;
  totals: {
    incomeAmount: number;
    expenseAmount: number;
    netAmount: number;
    fixedExpenseAmount?: number;
  };
  previousTotals: {
    incomeAmount: number;
    expenseAmount: number;
    netAmount: number;
    fixedExpenseAmount?: number;
  };
  categories: Array<{
    categoryId: string;
    name: string;
    color: string;
    icon: string;
    paidAmount: number;
  }>;
  trend: { daily: AnalyticsPoint[]; monthly: AnalyticsPoint[] };
  utility: {
    totals: { electricity: number; gas: number; water: number; other: number };
    daily: AnalyticsPoint[];
    monthly: AnalyticsPoint[];
  };
  fixed: {
    paidAmount: number;
    daily: AnalyticsPoint[];
    monthly: AnalyticsPoint[];
  };
};
type AnalyticsApiResponse = { analytics: AnalyticsResponse };
type AssetHistoryPoint = { date: string; balanceAmount: number };
type AssetHistoryResponse = {
  history: AssetHistoryPoint[];
  openingBalanceAmount: number;
  closingBalanceAmount: number;
};
type AssetSummaryResponse = { assets: AssetSummary };
type MonthlyTarget = {
  expenseTargetAmount: number;
  incomeTargetAmount: number;
  expenseActualAmount: number;
  incomeActualAmount: number;
  expenseProgress: number | null;
  incomeProgress: number | null;
};
type MonthlyTargetResponse = { targets: MonthlyTarget[] };

const emptyFilter: HistoryFilter = {
  type: "",
  categoryId: "",
  merchant: "",
  from: "",
  to: "",
  minAmount: "",
  maxAmount: "",
};
const yen = (value: number) =>
  `¥ ${new Intl.NumberFormat("ja-JP").format(value)}`;
const monthLabel = (value: string) =>
  `${value.slice(0, 4)}年${Number(value.slice(5, 7))}月`;
const categoryIcon = (category?: LedgerCategory) => {
  if (!category) return "/icons/category-other.svg";
  const known = new Map([
    ["食費", "category-food"],
    ["日用品", "category-daily"],
    ["交通費", "category-transit"],
    ["光熱費", "category-utility"],
    ["サブスク", "category-subscription"],
  ]);
  return `/icons/${known.get(category.name) ?? "category-other"}.svg`;
};
const assetIcon = (type: AssetAccount["type"]) =>
  `/icons/${
    type === "bank"
      ? "analytics"
      : type === "cash"
        ? "home"
        : "category-subscription"
  }.svg`;
const assetTypeLabel = (type: AssetAccount["type"]) =>
  ({ bank: "銀行口座", cash: "現金", gift: "商品券" })[type];

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${value}T00:00:00`));
}

async function api<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const body = (await response.json().catch(() => undefined)) as
    (T & ApiError) | undefined;
  if (!response.ok)
    throw new Error(
      typeof body?.error?.message === "string"
        ? body.error.message
        : "データを読み込めませんでした。通信状況を確認して再試行してください。",
    );
  return body as T;
}

function buildTransactionUrl(
  month: string,
  filter: HistoryFilter,
  cursor?: string,
) {
  const query = new URLSearchParams({ month, limit: "30" });
  if (filter.type) query.set("type", filter.type);
  if (filter.categoryId) query.set("categoryId", filter.categoryId);
  if (filter.merchant.trim()) query.set("merchant", filter.merchant.trim());
  if (filter.from) query.set("from", filter.from);
  if (filter.to) query.set("to", filter.to);
  if (filter.minAmount.trim()) query.set("minAmount", filter.minAmount.trim());
  if (filter.maxAmount.trim()) query.set("maxAmount", filter.maxAmount.trim());
  if (cursor) query.set("cursor", cursor);
  return `/api/ledger/transactions/?${query}`;
}

function buildRangeTransactionUrl(
  from: string,
  to: string,
  type?: LedgerTransactionType,
  categoryId?: string,
  cursor?: string,
) {
  const query = new URLSearchParams({ from, to, limit: "100" });
  if (type) query.set("type", type);
  if (categoryId) query.set("categoryId", categoryId);
  if (cursor) query.set("cursor", cursor);
  return `/api/ledger/transactions/?${query}`;
}

/** Follows every opaque cursor so a drilldown never silently omits later records. */
export async function fetchAllTransactions(
  from: string,
  to: string,
  type?: LedgerTransactionType,
  categoryId?: string,
  signal?: AbortSignal,
  onPage?: (count: number) => void,
) {
  const transactions: LedgerTransaction[] = [];
  let cursor: string | null = null;
  do {
    const response: TransactionResponse = await api<TransactionResponse>(
      buildRangeTransactionUrl(from, to, type, categoryId, cursor ?? undefined),
      signal,
    );
    transactions.push(...response.transactions);
    onPage?.(transactions.length);
    cursor = response.nextCursor;
  } while (cursor);
  return transactions;
}

export function sumMatchingItemPaidAmount(
  transaction: LedgerTransaction,
  categoryIds: ReadonlySet<string>,
) {
  return transaction.items.reduce(
    (total, item) =>
      categoryIds.has(item.categoryId) ? total + item.paidAmount : total,
    0,
  );
}

export function isUtilityItem(
  item: LedgerTransaction["items"][number],
  utilityCategoryIds: ReadonlySet<string>,
) {
  return item.utilityKind !== null || utilityCategoryIds.has(item.categoryId);
}

export function nextTabIndex(current: number, key: string, count: number) {
  if (count < 1) return 0;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  return current;
}

function Loading({ label = "読み込み中…" }: { label?: string }) {
  return (
    <p className="ha-loading" aria-live="polite">
      <i />
      {label}
    </p>
  );
}

function ErrorNotice({ notice }: { notice?: Notice }) {
  if (!notice) return null;
  return (
    <div className="ha-error" role="alert">
      <span>{notice.message}</span>
      <button type="button" onClick={notice.retry}>
        再試行
      </button>
    </div>
  );
}

function CategoryIcon({ category }: { category?: LedgerCategory }) {
  return (
    <span
      className="ha-category-icon"
      style={{ backgroundColor: category?.color ?? "#e8e8e4" }}
    >
      <img src={categoryIcon(category)} alt="" />
    </span>
  );
}

function TransactionList({
  transactions,
  categories,
  onSelect,
  grouped = false,
  matchingAmount,
}: {
  transactions: LedgerTransaction[];
  categories: LedgerCategory[];
  onSelect: (transaction: LedgerTransaction) => void;
  grouped?: boolean;
  matchingAmount?: (transaction: LedgerTransaction) => number;
}) {
  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  );
  let lastDate = "";
  return (
    <div className="ha-transaction-list">
      {transactions.map((transaction) => {
        const firstItem = transaction.items[0];
        const category = firstItem
          ? categoryById.get(firstItem.categoryId)
          : undefined;
        const heading =
          grouped && transaction.occurredAt !== lastDate
            ? ((lastDate = transaction.occurredAt),
              (
                <p className="ha-date-heading" key={`${transaction.id}-date`}>
                  {dateLabel(transaction.occurredAt)}
                </p>
              ))
            : null;
        const matched = matchingAmount?.(transaction);
        return (
          <div key={transaction.id}>
            {heading}
            <button
              type="button"
              className="ha-transaction-row"
              onClick={() => onSelect(transaction)}
            >
              <CategoryIcon category={category} />
              <span className="ha-row-text">
                <b>{transaction.title}</b>
                <small>
                  {[
                    transaction.merchant,
                    transaction.paymentMethod,
                    transaction.items.length > 1
                      ? `${transaction.items.length}品目`
                      : firstItem?.name,
                  ]
                    .filter(Boolean)
                    .join("・") || "詳細を確認"}
                  {matched != null
                    ? `・取引合計 ${yen(transaction.cashPaidAmount)}`
                    : ""}
                </small>
              </span>
              <strong className={transaction.type}>
                {matched == null
                  ? `${transaction.type === "income" ? "+" : "−"} ${yen(transaction.cashPaidAmount)}`
                  : yen(matched)}
                {matched != null && <small>該当額</small>}
              </strong>
              <span className="ha-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function HistoryScreen({
  month,
  setMonth,
  categories,
  onSelect,
  onError,
}: {
  month: string;
  setMonth: (value: string) => void;
  categories: LedgerCategory[];
  onSelect: (transaction: LedgerTransaction) => void;
  onError?: (message: string) => void;
}) {
  const [draft, setDraft] = useState<HistoryFilter>(emptyFilter);
  const [filter, setFilter] = useState<HistoryFilter>(emptyFilter);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [summary, setSummary] = useState<LedgerSummary>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const requestId = useRef(0);
  const activeController = useRef<AbortController | undefined>(undefined);

  const load = useCallback(
    async (cursor?: string) => {
      const currentId = ++requestId.current;
      activeController.current?.abort();
      const controller = new AbortController();
      activeController.current = controller;
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setNotice(undefined);
      try {
        const [transactionResponse, summaryResponse] = await Promise.all([
          api<TransactionResponse>(
            buildTransactionUrl(month, filter, cursor),
            controller.signal,
          ),
          cursor
            ? Promise.resolve<SummaryResponse | undefined>(undefined)
            : api<SummaryResponse>(
                `/api/ledger/summary?month=${encodeURIComponent(month)}`,
                controller.signal,
              ),
        ]);
        if (currentId !== requestId.current) return;
        setTransactions((previous) =>
          cursor
            ? [...previous, ...transactionResponse.transactions]
            : transactionResponse.transactions,
        );
        setNextCursor(transactionResponse.nextCursor);
        if (summaryResponse) setSummary(summaryResponse.summary);
      } catch (cause) {
        if (controller.signal.aborted || currentId !== requestId.current)
          return;
        const message =
          cause instanceof Error
            ? cause.message
            : "履歴を読み込めませんでした。";
        const retry = () => {
          void load(cursor);
        };
        setNotice({ message, retry });
        onError?.(message);
      } finally {
        if (currentId === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [filter, month, onError],
  );

  useEffect(() => {
    void load();
    return () => activeController.current?.abort();
  }, [load]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    setFilter({ ...draft, merchant: draft.merchant.trim() });
  };
  const clear = () => {
    setDraft(emptyFilter);
    setFilter(emptyFilter);
  };
  const expense = summary?.expenseCashPaidAmount ?? 0;
  const income = summary?.incomeCashPaidAmount ?? 0;

  return (
    <section className="ha-screen" aria-label="履歴">
      <header className="ha-title-row">
        <h1>履歴</h1>
        <button
          type="button"
          className="ha-filter-button"
          aria-expanded={filtersOpen}
          aria-controls="history-filters"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          絞り込み
        </button>
      </header>
      <div className="ha-history-tabs" role="group" aria-label="取引種別">
        <button
          type="button"
          className={!filter.type ? "active" : ""}
          onClick={() => {
            const next = { ...draft, type: "" as const };
            setDraft(next);
            setFilter(next);
          }}
        >
          すべて
        </button>
        <button
          type="button"
          className={filter.type === "income" ? "active" : ""}
          onClick={() => {
            const next = { ...draft, type: "income" as const };
            setDraft(next);
            setFilter(next);
          }}
        >
          収入
        </button>
        <button
          type="button"
          className={filter.type === "expense" ? "active" : ""}
          onClick={() => {
            const next = { ...draft, type: "expense" as const };
            setDraft(next);
            setFilter(next);
          }}
        >
          支出
        </button>
      </div>
      <form
        id="history-filters"
        className="ha-filter-panel"
        data-open={filtersOpen || undefined}
        onSubmit={apply}
      >
        <label>
          月
          <input
            aria-label="表示月"
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
          />
        </label>
        <label>
          カテゴリ
          <select
            value={draft.categoryId}
            onChange={(event) =>
              setDraft((previous) => ({
                ...previous,
                categoryId: event.target.value,
              }))
            }
          >
            <option value="">すべて</option>
            {categories.map((category) => (
              <option value={category.id} key={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          店舗名
          <input
            value={draft.merchant}
            maxLength={200}
            placeholder="例：スーパー"
            onChange={(event) =>
              setDraft((previous) => ({
                ...previous,
                merchant: event.target.value,
              }))
            }
          />
        </label>
        <div className="ha-filter-grid">
          <label>
            開始日
            <input
              type="date"
              value={draft.from}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  from: event.target.value,
                }))
              }
            />
          </label>
          <label>
            終了日
            <input
              type="date"
              value={draft.to}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  to: event.target.value,
                }))
              }
            />
          </label>
        </div>
        <div className="ha-filter-grid">
          <label>
            下限額
            <input
              inputMode="numeric"
              value={draft.minAmount}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  minAmount: event.target.value,
                }))
              }
            />
          </label>
          <label>
            上限額
            <input
              inputMode="numeric"
              value={draft.maxAmount}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  maxAmount: event.target.value,
                }))
              }
            />
          </label>
        </div>
        <div className="ha-filter-actions">
          <button type="button" onClick={clear}>
            クリア
          </button>
          <button type="submit">適用する</button>
        </div>
      </form>
      <div className="ha-month-row">
        <button
          type="button"
          aria-label="前の月"
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          ‹
        </button>
        <strong>{monthLabel(month)}</strong>
        <button
          type="button"
          aria-label="次の月"
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          ›
        </button>
      </div>
      <div className="ha-summary-strip">
        <span>
          収入<b>{yen(income)}</b>
        </span>
        <span>
          支出<b>{yen(expense)}</b>
        </span>
        <span>
          収支
          <b className={income - expense < 0 ? "expense" : "income"}>
            {income - expense >= 0 ? "+" : "−"}{" "}
            {yen(Math.abs(income - expense))}
          </b>
        </span>
      </div>
      <ErrorNotice notice={notice} />
      {loading && !transactions.length ? (
        <Loading label="履歴を読み込んでいます…" />
      ) : transactions.length ? (
        <>
          <TransactionList
            transactions={transactions}
            categories={categories}
            onSelect={onSelect}
            grouped
          />
          {loading && <Loading />}
          {nextCursor && (
            <button
              type="button"
              className="ha-more"
              disabled={loadingMore}
              onClick={() => void load(nextCursor)}
            >
              {loadingMore ? "読み込み中…" : "さらに表示"}
            </button>
          )}
        </>
      ) : (
        <div className="ha-empty">
          <img src="/icons/history.svg" alt="" />
          <p>
            {filter.type ||
            filter.categoryId ||
            filter.merchant ||
            filter.from ||
            filter.to ||
            filter.minAmount ||
            filter.maxAmount
              ? "条件に一致する明細はありません。"
              : "この月の明細はまだありません。"}
          </p>
          <small>絞り込み条件を変えるか、新しい明細を登録してください。</small>
        </div>
      )}
    </section>
  );
}

function AnalysisPeriodControls({
  idPrefix,
  period,
  setPeriod,
  month,
  setMonth,
  customFrom,
  setCustomFrom,
  customTo,
  setCustomTo,
}: {
  idPrefix: string;
  period: Period;
  setPeriod: (value: Period) => void;
  month: string;
  setMonth: (value: string) => void;
  customFrom: string;
  setCustomFrom: (value: string) => void;
  customTo: string;
  setCustomTo: (value: string) => void;
}) {
  const periods: Period[] = ["month", "year", "custom"];
  const labels: Record<Period, string> = {
    month: "月",
    year: "年",
    custom: "カスタム",
  };
  const selectPeriod = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const next = nextTabIndex(index, event.key, periods.length);
    if (next === index) return;
    event.preventDefault();
    setPeriod(periods[next]!);
    document.getElementById(`${idPrefix}-period-${periods[next]}`)?.focus();
  };
  return (
    <>
      <div className="ha-period-tabs" role="tablist" aria-label="集計期間">
        {periods.map((value, index) => (
          <button
            type="button"
            key={value}
            id={`${idPrefix}-period-${value}`}
            role="tab"
            aria-selected={period === value}
            aria-controls={`${idPrefix}-period-panel`}
            tabIndex={period === value ? 0 : -1}
            className={period === value ? "active" : ""}
            onClick={() => setPeriod(value)}
            onKeyDown={(event) => selectPeriod(event, index)}
          >
            {labels[value]}
          </button>
        ))}
      </div>
      <div
        id={`${idPrefix}-period-panel`}
        role="tabpanel"
        aria-labelledby={`${idPrefix}-period-${period}`}
      >
        {period === "custom" ? (
          <div className="ha-custom-range">
            <label>
              開始日
              <input
                type="date"
                value={customFrom}
                onChange={(event) => setCustomFrom(event.target.value)}
              />
            </label>
            <label>
              終了日
              <input
                type="date"
                value={customTo}
                min={customFrom}
                onChange={(event) => setCustomTo(event.target.value)}
              />
            </label>
          </div>
        ) : (
          <div className="ha-month-row">
            <button
              type="button"
              aria-label={period === "year" ? "前年" : "前の月"}
              onClick={() =>
                setMonth(shiftMonth(month, period === "year" ? -12 : -1))
              }
            >
              ‹
            </button>
            <strong>
              {period === "year" ? `${month.slice(0, 4)}年` : monthLabel(month)}
            </strong>
            <button
              type="button"
              aria-label={period === "year" ? "翌年" : "次の月"}
              onClick={() =>
                setMonth(shiftMonth(month, period === "year" ? 12 : 1))
              }
            >
              ›
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export function AnalyticsScreen({
  month,
  setMonth,
  summary: _summary,
  categories,
  onSelect,
}: {
  month: string;
  setMonth: (value: string) => void;
  summary?: LedgerSummary;
  categories: LedgerCategory[];
  onSelect?: (transaction: LedgerTransaction) => void;
}) {
  const [view, setView] = useState<AnalyticsView>("cashflow");
  const [period, setPeriod] = useState<Period>("month");
  const [customFrom, setCustomFrom] = useState(`${month}-01`);
  const [customTo, setCustomTo] = useState(lastDateOfMonth(month));
  const [analytics, setAnalytics] = useState<AnalyticsResponse>();
  const [assetHistory, setAssetHistory] = useState<AssetHistoryResponse>();
  const [assetAccounts, setAssetAccounts] = useState<AssetAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice>();
  const [categoryPicker, setCategoryPicker] = useState(false);
  const [detail, setDetail] = useState<{
    kind: Drilldown;
    category?: AnalyticsResponse["categories"][number];
  }>();
  const [detailTransactions, setDetailTransactions] = useState<
    LedgerTransaction[]
  >([]);
  const [detailAnalytics, setDetailAnalytics] = useState<AnalyticsResponse>();
  const [detailPreviousAnalytics, setDetailPreviousAnalytics] =
    useState<AnalyticsResponse>();
  const [detailHistoryAnalytics, setDetailHistoryAnalytics] =
    useState<AnalyticsResponse>();
  const [detailTarget, setDetailTarget] = useState<MonthlyTarget>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailProgress, setDetailProgress] = useState(0);
  const [detailNotice, setDetailNotice] = useState<Notice>();
  const mainRequest = useRef(0);
  const detailRequest = useRef(0);
  const detailRange = useRef("");

  const range = useMemo(
    () => periodRange(period, month, customFrom, customTo),
    [customFrom, customTo, month, period],
  );
  const analyticsUrl = useCallback(
    (nextRange: Pick<AnalyticsRange, "from" | "to">, categoryId?: string) => {
      const query = new URLSearchParams({
        from: nextRange.from,
        to: nextRange.to,
      });
      if (categoryId) query.set("categoryId", categoryId);
      return `/api/ledger/analytics?${query}`;
    },
    [],
  );

  const load = useCallback(async () => {
    const current = ++mainRequest.current;
    setLoading(true);
    setNotice(undefined);
    try {
      if (view === "assets") {
        const [response, accountResponse] = await Promise.all([
          api<AssetHistoryResponse>(
            `/api/assets/history?${new URLSearchParams({ from: range.from, to: range.to })}`,
          ),
          api<AssetSummaryResponse>(
            "/api/assets/accounts/?includeArchived=false",
          ),
        ]);
        if (current !== mainRequest.current) return;
        setAssetHistory(response);
        setAssetAccounts(accountResponse.assets.accounts);
      } else {
        const response = await api<AnalyticsApiResponse>(analyticsUrl(range));
        if (current !== mainRequest.current) return;
        setAnalytics(response.analytics);
      }
    } catch (cause) {
      if (current !== mainRequest.current) return;
      const message =
        cause instanceof Error
          ? cause.message
          : "分析データを読み込めませんでした。";
      setNotice({
        message,
        retry: () => {
          void load();
        },
      });
    } finally {
      if (current === mainRequest.current) setLoading(false);
    }
  }, [analyticsUrl, range, view]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setCustomFrom(`${month}-01`);
    setCustomTo(lastDateOfMonth(month));
  }, [month]);
  useEffect(() => {
    setCategoryPicker(false);
  }, [range.from, range.to]);

  const categoriesWithSpend =
    analytics?.categories.filter((category) => category.paidAmount > 0) ?? [];
  const categoryTotal = categoriesWithSpend.reduce(
    (total, category) => total + category.paidAmount,
    0,
  );
  const conicStops = useMemo(
    () => gradientStops(categoriesWithSpend, categoryTotal),
    [categoriesWithSpend, categoryTotal],
  );
  const monthPoints = analytics?.trend.monthly ?? [];
  const chartMaximum = Math.max(
    1,
    ...monthPoints.flatMap((point) => [
      point.incomeAmount ?? 0,
      point.expenseAmount ?? 0,
    ]),
  );
  const latestAsset = assetHistory?.closingBalanceAmount;

  const openDetail = (
    kind: Drilldown,
    category?: AnalyticsResponse["categories"][number],
  ) => {
    setCategoryPicker(false);
    detailRange.current = `${range.from}:${range.to}`;
    setDetail({ kind, category });
    setDetailTransactions([]);
    setDetailAnalytics(undefined);
    setDetailPreviousAnalytics(undefined);
    setDetailHistoryAnalytics(undefined);
    setDetailTarget(undefined);
    setDetailProgress(0);
    setDetailNotice(undefined);
    const current = ++detailRequest.current;
    const categoryId = category?.categoryId;
    const matchingIds = new Set(
      kind === "category" && categoryId
        ? [categoryId]
        : kind === "utility"
          ? categories
              .filter((item) => item.name === "光熱費")
              .map((item) => item.id)
          : kind === "fixed"
            ? categories
                .filter((item) =>
                  ["住居費", "通信費", "サブスク", "保険"].includes(item.name),
                )
                .map((item) => item.id)
            : [],
    );
    const transactionType = kind === "income" ? "income" : "expense";
    setDetailLoading(true);
    void api<AnalyticsApiResponse>(analyticsUrl(range, categoryId))
      .then(async (detailResponse) => {
        const [previousResponse, historyResponse, targetResponse, rows] =
          await Promise.all([
            api<AnalyticsApiResponse>(
              analyticsUrl(
                {
                  from: detailResponse.analytics.range.previousFrom,
                  to: detailResponse.analytics.range.previousTo,
                },
                categoryId,
              ),
            ),
            api<AnalyticsApiResponse>(
              analyticsUrl(sixMonthRange(range.to), categoryId),
            ),
            period === "month" && (kind === "income" || kind === "expense")
              ? api<MonthlyTargetResponse>(
                  `/api/planning/monthly-targets/?month=${encodeURIComponent(month)}`,
                )
              : Promise.resolve<MonthlyTargetResponse | undefined>(undefined),
            fetchAllTransactions(
              range.from,
              range.to,
              transactionType,
              categoryId,
              undefined,
              (count) => {
                if (current === detailRequest.current) setDetailProgress(count);
              },
            ),
          ]);
        if (current !== detailRequest.current) return;
        const filtered =
          matchingIds.size || kind === "utility"
            ? rows.filter((transaction) =>
                transaction.items.some((item) =>
                  kind === "utility"
                    ? isUtilityItem(item, matchingIds)
                    : matchingIds.has(item.categoryId),
                ),
              )
            : rows;
        setDetailAnalytics(detailResponse.analytics);
        setDetailPreviousAnalytics(previousResponse.analytics);
        setDetailHistoryAnalytics(historyResponse.analytics);
        setDetailTarget(targetResponse?.targets[0]);
        setDetailTransactions(filtered);
      })
      .catch((cause) => {
        if (current !== detailRequest.current) return;
        const message =
          cause instanceof Error
            ? cause.message
            : "明細を読み込めませんでした。";
        setDetailNotice({ message, retry: () => openDetail(kind, category) });
      })
      .finally(() => {
        if (current === detailRequest.current) setDetailLoading(false);
      });
  };

  useEffect(() => {
    if (!detail) return;
    const currentRange = `${range.from}:${range.to}`;
    if (detailRange.current === currentRange) return;
    openDetail(detail.kind, detail.category);
    // `openDetail` resets the async state for the newly selected period.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to]);

  if (detail) {
    return (
      <AnalyticsDetail
        kind={detail.kind}
        category={detail.category}
        response={detailAnalytics}
        previousResponse={detailPreviousAnalytics}
        historyResponse={detailHistoryAnalytics}
        transactions={detailTransactions}
        categories={categories}
        loading={detailLoading}
        progress={detailProgress}
        notice={detailNotice}
        target={detailTarget}
        period={period}
        setPeriod={setPeriod}
        month={month}
        setMonth={setMonth}
        customFrom={customFrom}
        setCustomFrom={setCustomFrom}
        customTo={customTo}
        setCustomTo={setCustomTo}
        onClose={() => {
          detailRequest.current += 1;
          setDetail(undefined);
        }}
        onSelect={onSelect}
      />
    );
  }

  return (
    <section className="ha-screen" aria-label="分析">
      <header className="ha-title-row">
        <h1>分析</h1>
      </header>
      <div className="ha-analysis-tabs" role="tablist" aria-label="分析表示">
        <button
          type="button"
          id="analysis-view-cashflow"
          role="tab"
          className={view === "cashflow" ? "active" : ""}
          aria-selected={view === "cashflow"}
          aria-controls="analysis-view-panel"
          tabIndex={view === "cashflow" ? 0 : -1}
          onClick={() => setView("cashflow")}
          onKeyDown={(event) => {
            const next = nextTabIndex(0, event.key, 2);
            if (next === 0) return;
            event.preventDefault();
            setView("assets");
            document.getElementById("analysis-view-assets")?.focus();
          }}
        >
          収支
        </button>
        <button
          type="button"
          id="analysis-view-assets"
          role="tab"
          className={view === "assets" ? "active" : ""}
          aria-selected={view === "assets"}
          aria-controls="analysis-view-panel"
          tabIndex={view === "assets" ? 0 : -1}
          onClick={() => setView("assets")}
          onKeyDown={(event) => {
            const next = nextTabIndex(1, event.key, 2);
            if (next === 1) return;
            event.preventDefault();
            setView("cashflow");
            document.getElementById("analysis-view-cashflow")?.focus();
          }}
        >
          総資産
        </button>
      </div>
      <AnalysisPeriodControls
        idPrefix="analysis"
        period={period}
        setPeriod={setPeriod}
        month={month}
        setMonth={setMonth}
        customFrom={customFrom}
        setCustomFrom={setCustomFrom}
        customTo={customTo}
        setCustomTo={setCustomTo}
      />
      <ErrorNotice notice={notice} />
      <div
        id="analysis-view-panel"
        role="tabpanel"
        aria-labelledby={`analysis-view-${view}`}
      >
        {loading ? (
          <Loading label="分析データを読み込んでいます…" />
        ) : view === "assets" ? (
          <AssetAnalysis
            history={assetHistory?.history ?? []}
            latest={latestAsset}
            asOf={range.to}
            accounts={assetAccounts}
          />
        ) : analytics ? (
          <>
            <div className="ha-income-expense">
              <button type="button" onClick={() => openDetail("income")}>
                <span className="income">↑</span>
                <small>収入</small>
                <b>{yen(analytics.totals.incomeAmount)}</b>
                <i>›</i>
              </button>
              <button type="button" onClick={() => openDetail("expense")}>
                <span className="expense">↓</span>
                <small>支出</small>
                <b>{yen(analytics.totals.expenseAmount)}</b>
                <i>›</i>
              </button>
            </div>
            <p className="ha-comparison">
              前期間比:{" "}
              <b
                className={
                  analytics.totals.netAmount -
                    analytics.previousTotals.netAmount <
                  0
                    ? "expense"
                    : "income"
                }
              >
                {analytics.totals.netAmount -
                  analytics.previousTotals.netAmount >=
                0
                  ? "+"
                  : "−"}{" "}
                {yen(
                  Math.abs(
                    analytics.totals.netAmount -
                      analytics.previousTotals.netAmount,
                  ),
                )}
              </b>
            </p>
            <section className="ha-card">
              <div className="ha-card-head">
                <h2>収支の推移</h2>
                <span>
                  {period === "month"
                    ? "この月"
                    : `${range.from} 〜 ${range.to}`}
                </span>
              </div>
              <IncomeExpenseChart points={monthPoints} maximum={chartMaximum} />
            </section>
            <section className="ha-card">
              <div className="ha-card-head">
                <h2>カテゴリ別の支出</h2>
                <button
                  type="button"
                  onClick={() => setCategoryPicker(true)}
                  disabled={!categoriesWithSpend.length}
                >
                  もっと見る ›
                </button>
              </div>
              {categoriesWithSpend.length ? (
                <div className="ha-category-chart">
                  <div
                    className="ha-donut"
                    style={{ background: `conic-gradient(${conicStops})` }}
                  >
                    <div>
                      <small>支出合計</small>
                      <b>{yen(analytics.totals.expenseAmount)}</b>
                    </div>
                  </div>
                  <CategoryRows
                    categories={categoriesWithSpend.slice(0, 7)}
                    total={categoryTotal}
                    onOpen={(category) => openDetail("category", category)}
                  />
                </div>
              ) : (
                <Empty text="カテゴリ別の支出はまだありません。" />
              )}
            </section>
            <section className="ha-split-analysis">
              <button type="button" onClick={() => openDetail("utility")}>
                <small>光熱費</small>
                <b>{yen(sumUtility(analytics.utility.totals))}</b>
                <span>内訳を見る ›</span>
              </button>
              <button type="button" onClick={() => openDetail("fixed")}>
                <small>固定費</small>
                <b>{yen(analytics.fixed.paidAmount)}</b>
                <span>内訳を見る ›</span>
              </button>
            </section>
            <section className="ha-card">
              <div className="ha-card-head">
                <h2>日別の支出</h2>
                <span>
                  {range.from} 〜 {range.to}
                </span>
              </div>
              <DailyChart points={analytics.trend.daily} />
            </section>
          </>
        ) : (
          <Empty text="表示できる分析データがありません。" />
        )}
      </div>
      {categoryPicker && (
        <CategoryPicker
          categories={categoriesWithSpend}
          onClose={() => setCategoryPicker(false)}
          onSelect={(category) => openDetail("category", category)}
        />
      )}
    </section>
  );
}

function IncomeExpenseChart({
  points,
  maximum,
}: {
  points: AnalyticsPoint[];
  maximum: number;
}) {
  return points.length ? (
    <div className="ha-income-chart" aria-label="収支の推移">
      <div className="ha-chart-lines">
        <i />
        <i />
        <i />
      </div>
      <svg
        className="ha-chart-net-line"
        viewBox="0 0 300 104"
        aria-hidden="true"
      >
        <polyline
          points={linePoints(
            points.map(
              (point) =>
                point.netAmount ??
                (point.incomeAmount ?? 0) - (point.expenseAmount ?? 0),
            ),
            300,
            86,
            9,
          )}
        />
        {lineMarkers(
          points.map(
            (point) =>
              point.netAmount ??
              (point.incomeAmount ?? 0) - (point.expenseAmount ?? 0),
          ),
          300,
          86,
          9,
        ).map((point) => (
          <circle key={point.key} cx={point.x} cy={point.y} r="3" />
        ))}
      </svg>
      {points.map((point) => (
        <div className="ha-month-bars" key={point.month ?? point.date}>
          <div>
            <i
              className="income"
              style={{
                height: `${barHeight(point.incomeAmount ?? 0, maximum)}%`,
              }}
            />
            <i
              className="expense"
              style={{
                height: `${barHeight(point.expenseAmount ?? 0, maximum)}%`,
              }}
            />
          </div>
          <span>
            {point.month
              ? `${Number(point.month.slice(5))}月`
              : point.date?.slice(5)}
          </span>
        </div>
      ))}
    </div>
  ) : (
    <Empty text="表示できる収支データがありません。" />
  );
}

function CategoryRows({
  categories,
  total,
  onOpen,
}: {
  categories: AnalyticsResponse["categories"];
  total: number;
  onOpen: (category: AnalyticsResponse["categories"][number]) => void;
}) {
  return (
    <ul>
      {categories.map((category) => (
        <li key={category.categoryId}>
          <button type="button" onClick={() => onOpen(category)}>
            <span style={{ backgroundColor: category.color }} />
            <b>{category.name}</b>
            <small>
              {Math.round((category.paidAmount / Math.max(1, total)) * 100)}%
            </small>
            <strong>{yen(category.paidAmount)}</strong>
          </button>
        </li>
      ))}
    </ul>
  );
}

function DailyChart({ points }: { points: AnalyticsPoint[] }) {
  const maximum = Math.max(
    1,
    ...points.map((point) => point.expenseAmount ?? 0),
  );
  return points.length ? (
    <div className="ha-daily-chart">
      {points.map((point) => (
        <div key={point.date}>
          <i
            style={{
              height: `${barHeight(point.expenseAmount ?? 0, maximum)}%`,
            }}
            title={`${point.date}: ${yen(point.expenseAmount ?? 0)}`}
          />
          <span>{Number(point.date?.slice(8))}</span>
        </div>
      ))}
    </div>
  ) : (
    <Empty text="この期間の日別支出はまだありません。" />
  );
}

function AssetAnalysis({
  history,
  latest,
  asOf,
  accounts,
}: {
  history: AssetHistoryPoint[];
  latest?: number;
  asOf: string;
  accounts: AssetAccount[];
}) {
  return (
    <>
      <section className="ha-asset-total">
        <small>期間末の総資産</small>
        <b>{latest == null ? "—" : yen(latest)}</b>
        <span>
          {latest == null ? "この期間の残高記録はありません" : `${asOf} 時点`}
        </span>
      </section>
      <section className="ha-card">
        <div className="ha-card-head">
          <h2>資産の推移</h2>
          <span>実際の残高履歴</span>
        </div>
        {history.length ? (
          <LineHistoryChart points={history} />
        ) : (
          <Empty text="この期間の残高履歴はまだありません。" />
        )}
      </section>
      <section className="ha-card ha-asset-breakdown">
        <div className="ha-card-head">
          <h2>資産の内訳</h2>
          <span>現在の残高</span>
        </div>
        {accounts.length ? (
          <>
            <p className="ha-asset-current-note">
              口座ごとの期間末残高は API
              で取得していないため、ここでは現在の残高を表示します。
            </p>
            <ul>
              {accounts.map((account) => (
                <li key={account.id}>
                  <span className={`ha-asset-account-icon ${account.type}`}>
                    <img src={assetIcon(account.type)} alt="" />
                  </span>
                  <b>{account.name}</b>
                  <small>{assetTypeLabel(account.type)}</small>
                  <strong>{yen(account.balanceAmount)}</strong>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Empty text="表示できる口座はまだありません。" />
        )}
      </section>
    </>
  );
}

function LineHistoryChart({ points }: { points: AssetHistoryPoint[] }) {
  const values = points.map((point) => point.balanceAmount);
  const markers = lineMarkers(values, 300, 102, 10);
  return (
    <div className="ha-line-history" aria-label="資産の推移">
      <svg viewBox="0 0 300 120" preserveAspectRatio="none">
        <defs>
          <linearGradient id="ha-asset-fill" x1="0" x2="0" y1="0" y2="1">
            <stop stopColor="#8ea594" stopOpacity=".52" />
            <stop offset="1" stopColor="#8ea594" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon
          points={`${linePoints(values, 300, 102, 10)} 300,112 0,112`}
          fill="url(#ha-asset-fill)"
        />
        <polyline points={linePoints(values, 300, 102, 10)} />
        {markers.map((point) => (
          <circle key={point.key} cx={point.x} cy={point.y} r="3" />
        ))}
      </svg>
      <div>
        {points.map((point) => (
          <span key={point.date}>{point.date.slice(5)}</span>
        ))}
      </div>
    </div>
  );
}

function SingleValueChart({
  points,
  tone = "#b8944b",
}: {
  points: AnalyticsPoint[];
  tone?: string;
}) {
  const maximum = Math.max(
    1,
    ...points.map((point) => point.expenseAmount ?? point.paidAmount ?? 0),
  );
  return points.length ? (
    <div className="ha-single-chart">
      {points.map((point) => (
        <div key={point.month ?? point.date}>
          <i
            style={{
              height: `${barHeight(point.expenseAmount ?? point.paidAmount ?? 0, maximum)}%`,
              backgroundColor: tone,
            }}
          />
          <span>
            {point.month
              ? `${Number(point.month.slice(5))}月`
              : point.date?.slice(5)}
          </span>
        </div>
      ))}
    </div>
  ) : (
    <Empty text="表示できる推移データがありません。" />
  );
}

function UtilityTrendChart({ points }: { points: AnalyticsPoint[] }) {
  const maximum = Math.max(1, ...points.map((point) => sumUtility(point)));
  const parts: Array<
    [
      keyof Pick<AnalyticsPoint, "electricity" | "gas" | "water" | "other">,
      string,
      string,
    ]
  > = [
    ["electricity", "電気", "#7d9ab5"],
    ["gas", "ガス", "#aeb7c1"],
    ["water", "水道", "#d7d9d7"],
    ["other", "その他", "#e8dfd7"],
  ];
  return points.length ? (
    <>
      <div className="ha-utility-chart">
        {points.map((point) => (
          <div key={point.month ?? point.date}>
            <span>
              {parts.map(([key, label, color]) => (
                <i
                  key={key}
                  aria-label={label}
                  style={{
                    height: `${((point[key] ?? 0) / maximum) * 100}%`,
                    backgroundColor: color,
                  }}
                />
              ))}
            </span>
            <small>
              {point.month
                ? `${Number(point.month.slice(5))}月`
                : point.date?.slice(5)}
            </small>
          </div>
        ))}
      </div>
      <p className="ha-chart-legend">
        {parts.map(([, label, color]) => (
          <span key={label}>
            <i style={{ backgroundColor: color }} />
            {label}
          </span>
        ))}
      </p>
    </>
  ) : (
    <Empty text="表示できる光熱費の推移はありません。" />
  );
}

function useDialogFocusTrap(onClose: () => void) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        element.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) {
        event.preventDefault();
        element.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return ref;
}

function CategoryPicker({
  categories,
  onClose,
  onSelect,
}: {
  categories: AnalyticsResponse["categories"];
  onClose: () => void;
  onSelect: (category: AnalyticsResponse["categories"][number]) => void;
}) {
  const dialogRef = useDialogFocusTrap(onClose);
  return (
    <div
      className="ha-dialog-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="ha-dialog"
        role="dialog"
        ref={dialogRef}
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="ha-category-picker"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id="ha-category-picker">カテゴリを選択</h2>
          <button type="button" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <CategoryRows
          categories={categories}
          total={categories.reduce(
            (total, category) => total + category.paidAmount,
            0,
          )}
          onOpen={onSelect}
        />
      </section>
    </div>
  );
}

function AnalyticsDetail({
  kind,
  category,
  response,
  previousResponse,
  historyResponse,
  transactions,
  categories,
  loading,
  progress,
  notice,
  target,
  period,
  setPeriod,
  month,
  setMonth,
  customFrom,
  setCustomFrom,
  customTo,
  setCustomTo,
  onClose,
  onSelect,
}: {
  kind: Drilldown;
  category?: AnalyticsResponse["categories"][number];
  response?: AnalyticsResponse;
  previousResponse?: AnalyticsResponse;
  historyResponse?: AnalyticsResponse;
  transactions: LedgerTransaction[];
  categories: LedgerCategory[];
  loading: boolean;
  progress: number;
  notice?: Notice;
  target?: MonthlyTarget;
  period: Period;
  setPeriod: (value: Period) => void;
  month: string;
  setMonth: (value: string) => void;
  customFrom: string;
  setCustomFrom: (value: string) => void;
  customTo: string;
  setCustomTo: (value: string) => void;
  onClose: () => void;
  onSelect?: (transaction: LedgerTransaction) => void;
}) {
  const categoryIds = new Set(
    kind === "category" && category
      ? [category.categoryId]
      : kind === "utility"
        ? categories
            .filter((item) => item.name === "光熱費")
            .map((item) => item.id)
        : kind === "fixed"
          ? categories
              .filter((item) =>
                ["住居費", "通信費", "サブスク", "保険"].includes(item.name),
              )
              .map((item) => item.id)
          : [],
  );
  const matching =
    categoryIds.size || kind === "utility"
      ? (transaction: LedgerTransaction) =>
          kind === "utility"
            ? transaction.items.reduce(
                (total, item) =>
                  isUtilityItem(item, categoryIds)
                    ? total + item.paidAmount
                    : total,
                0,
              )
            : sumMatchingItemPaidAmount(transaction, categoryIds)
      : undefined;
  const title =
    kind === "category"
      ? `${category?.name ?? "カテゴリ"}の詳細`
      : {
          income: "収入の内訳",
          expense: "支出の内訳",
          utility: "光熱費の詳細",
          fixed: "固定費の詳細",
        }[kind];
  const amount = response
    ? kind === "income"
      ? response.totals.incomeAmount
      : kind === "expense"
        ? response.totals.expenseAmount
        : kind === "category"
          ? response.totals.expenseAmount
          : kind === "utility"
            ? sumUtility(response.utility.totals)
            : response.fixed.paidAmount
    : 0;
  const previous = previousResponse
    ? kind === "income"
      ? previousResponse.totals.incomeAmount
      : kind === "expense" || kind === "category"
        ? previousResponse.totals.expenseAmount
        : kind === "utility"
          ? sumUtility(previousResponse.utility.totals)
          : previousResponse.fixed.paidAmount
    : 0;
  const points = historyResponse
    ? kind === "utility"
      ? historyResponse.utility.monthly.map((point) => ({
          ...point,
          expenseAmount: sumUtility(point),
        }))
      : kind === "fixed"
        ? historyResponse.fixed.monthly.map((point) => ({
            ...point,
            expenseAmount: point.paidAmount ?? 0,
          }))
        : historyResponse.trend.monthly
    : [];
  const utilityPoints = historyResponse?.utility.monthly ?? [];
  const headline =
    kind === "income"
      ? "収入"
      : kind === "expense"
        ? "支出"
        : kind === "category" || kind === "utility"
          ? "カテゴリ別の支出"
          : "固定費";
  const targetAmount =
    kind === "income"
      ? target?.incomeTargetAmount
      : target?.expenseTargetAmount;
  const targetProgress =
    kind === "income" ? target?.incomeProgress : target?.expenseProgress;
  const showsTarget =
    period === "month" && (kind === "income" || kind === "expense");
  return (
    <section className="ha-screen ha-detail-page" aria-label={title}>
      <header className="ha-detail-page-header">
        <button type="button" onClick={onClose} aria-label="分析に戻る">
          ‹
        </button>
        <h1>{headline}</h1>
        <span aria-hidden="true" />
      </header>
      <AnalysisPeriodControls
        idPrefix="analysis-detail"
        period={period}
        setPeriod={setPeriod}
        month={month}
        setMonth={setMonth}
        customFrom={customFrom}
        setCustomFrom={setCustomFrom}
        customTo={customTo}
        setCustomTo={setCustomTo}
      />
      <ErrorNotice notice={notice} />
      {loading ? (
        <Loading
          label={
            progress
              ? `${progress} 件の明細を確認しています…`
              : "明細を読み込んでいます…"
          }
        />
      ) : response ? (
        <>
          <section className="ha-detail-total">
            <small>
              {period === "month" ? monthLabel(month) : "選択した期間"}の
              {kind === "income" ? "収入" : "実支払額"}
            </small>
            <b>{yen(amount)}</b>
            <span>
              前期間 {yen(previous)} / 差額 {amount - previous >= 0 ? "+" : "−"}{" "}
              {yen(Math.abs(amount - previous))}
            </span>
          </section>
          {showsTarget && (
            <TargetProgress
              amount={amount}
              targetAmount={targetAmount}
              progress={targetProgress}
              label={kind === "income" ? "収入目標" : "支出目標"}
            />
          )}
          {(kind === "income" || kind === "expense") && (
            <section className="ha-card">
              <div className="ha-card-head">
                <h2>{kind === "income" ? "収入" : "支出"}の推移</h2>
                <span>実績</span>
              </div>
              <SingleValueChart
                points={points.map((point) => ({
                  ...point,
                  expenseAmount:
                    kind === "income"
                      ? (point.incomeAmount ?? 0)
                      : (point.expenseAmount ?? 0),
                }))}
                tone={kind === "income" ? "#829b8c" : "#c4878d"}
              />
            </section>
          )}
          {kind === "utility" && (
            <UtilityBreakdown totals={response.utility.totals} />
          )}
          {kind === "category" && (
            <section className="ha-card">
              <div className="ha-card-head">
                <h2>{category?.name}の推移</h2>
                <span>実支払額</span>
              </div>
              <SingleValueChart points={points} />
            </section>
          )}
          {kind === "utility" && (
            <section className="ha-card">
              <div className="ha-card-head">
                <h2>光熱費の推移</h2>
                <span>実支払額</span>
              </div>
              <UtilityTrendChart points={utilityPoints} />
            </section>
          )}
          {kind === "fixed" && (
            <section className="ha-card">
              <div className="ha-card-head">
                <h2>固定費の推移</h2>
                <span>実支払額</span>
              </div>
              <SingleValueChart points={points} tone="#82988c" />
            </section>
          )}
          <h2 className="ha-detail-list-title">
            明細 {transactions.length} 件
          </h2>
          {transactions.length && onSelect ? (
            <TransactionList
              transactions={transactions}
              categories={categories}
              onSelect={(transaction) => {
                onSelect(transaction);
                onClose();
              }}
              grouped
              matchingAmount={matching}
            />
          ) : (
            <Empty text="表示できる明細はありません。" />
          )}
        </>
      ) : (
        <Empty text="分析データを読み込めませんでした。" />
      )}
    </section>
  );
}

function TargetProgress({
  amount,
  targetAmount,
  progress,
  label,
}: {
  amount: number;
  targetAmount?: number;
  progress?: number | null;
  label: string;
}) {
  if (!targetAmount) {
    return <p className="ha-target-note">この月の{label}は未設定です。</p>;
  }
  const percentage = Math.max(
    0,
    Math.min(100, progress ?? (amount / targetAmount) * 100),
  );
  return (
    <section className="ha-target-progress" aria-label={label}>
      <div>
        <span>{label}</span>
        <b>{yen(targetAmount)}</b>
        <small>{Math.round(percentage)}%</small>
      </div>
      <i>
        <span style={{ width: `${percentage}%` }} />
      </i>
    </section>
  );
}

function UtilityBreakdown({
  totals,
}: {
  totals: AnalyticsResponse["utility"]["totals"];
}) {
  return (
    <section className="ha-utility-breakdown">
      <h3>内訳</h3>
      {(
        [
          ["電気", totals.electricity],
          ["ガス", totals.gas],
          ["水道", totals.water],
          ["その他", totals.other],
        ] as const
      ).map(([name, amount]) => (
        <div key={name}>
          <span>{name}</span>
          <b>{yen(amount)}</b>
        </div>
      ))}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="ha-empty">
      <img src="/icons/analytics.svg" alt="" />
      <p>{text}</p>
    </div>
  );
}

function shiftMonth(value: string, amount: number) {
  const [year, month] = value.split("-").map(Number);
  const date = new Date(year, month - 1 + amount, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function lastDateOfMonth(value: string) {
  const [year, month] = value.split("-").map(Number);
  return `${value}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
}

function periodRange(
  period: Period,
  month: string,
  customFrom: string,
  customTo: string,
) {
  if (period === "custom") return { from: customFrom, to: customTo };
  if (period === "year")
    return {
      from: `${month.slice(0, 4)}-01-01`,
      to: `${month.slice(0, 4)}-12-31`,
    };
  return { from: `${month}-01`, to: lastDateOfMonth(month) };
}

function sixMonthRange(end: string) {
  const endMonth = end.slice(0, 7);
  return { from: `${shiftMonth(endMonth, -5)}-01`, to: end };
}

function gradientStops(
  categories: AnalyticsResponse["categories"],
  total: number,
) {
  let start = 0;
  return categories
    .map((category) => {
      const end = start + (category.paidAmount / Math.max(1, total)) * 100;
      const result = `${category.color} ${start}% ${end}%`;
      start = end;
      return result;
    })
    .join(", ");
}

function barHeight(value: number, maximum: number) {
  return value ? Math.max(5, (value / Math.max(1, maximum)) * 100) : 0;
}

export function lineMarkers(
  values: number[],
  width: number,
  height: number,
  padding: number,
) {
  const low = Math.min(...values, 0);
  const high = Math.max(...values, 0);
  const span = Math.max(1, high - low);
  return values.map((value, index) => ({
    key: `${index}-${value}`,
    x:
      values.length === 1
        ? width / 2
        : padding + (index / (values.length - 1)) * (width - padding * 2),
    y: padding + ((high - value) / span) * (height - padding * 2),
  }));
}

export function linePoints(
  values: number[],
  width: number,
  height: number,
  padding: number,
) {
  return lineMarkers(values, width, height, padding)
    .map((point) => `${point.x},${point.y}`)
    .join(" ");
}

function sumUtility(values: {
  electricity?: number;
  gas?: number;
  water?: number;
  other?: number;
}) {
  return (
    (values.electricity ?? 0) +
    (values.gas ?? 0) +
    (values.water ?? 0) +
    (values.other ?? 0)
  );
}

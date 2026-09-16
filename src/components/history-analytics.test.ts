import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LedgerTransaction } from "../server/ledger/types";
import {
  fetchAllTransactions,
  isUtilityItem,
  lineMarkers,
  linePoints,
  mainAnalyticsTrendRange,
  monthComparison,
  monthlyTrendLabels,
  monthlyAssetPoints,
  nextTabIndex,
  sumMatchingItemPaidAmount,
} from "./history-analytics";

const transaction = (
  id: string,
  paidAmounts: Array<{ categoryId: string; paidAmount: number }>,
): LedgerTransaction => ({
  id,
  receiptId: null,
  accountId: null,
  giftAccountId: null,
  type: "expense",
  occurredAt: "2026-09-15",
  title: "まとめ買い",
  merchant: "店舗",
  memo: "",
  paymentMethod: "cash",
  grossAmount: paidAmounts.reduce((total, item) => total + item.paidAmount, 0),
  itemDiscountAmount: 0,
  receiptDiscountAmount: 0,
  discountAmount: 0,
  netAmount: paidAmounts.reduce((total, item) => total + item.paidAmount, 0),
  pointUsedAmount: 0,
  giftCertificateUsedAmount: 0,
  nonCashAmount: 0,
  cashPaidAmount: paidAmounts.reduce(
    (total, item) => total + item.paidAmount,
    0,
  ),
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  items: paidAmounts.map((item, index) => ({
    id: `${id}-${index}`,
    categoryId: item.categoryId,
    name: "品目",
    originalAmount: item.paidAmount,
    itemDiscountAmount: 0,
    allocatedReceiptDiscountAmount: 0,
    finalAmount: item.paidAmount,
    allocatedPointAmount: 0,
    allocatedGiftCertificateAmount: 0,
    paidAmount: item.paidAmount,
    utilityKind: null,
    sortOrder: index,
  })),
});

afterEach(() => vi.unstubAllGlobals());

describe("history and analytics helpers", () => {
  it("sums matching item paid amounts instead of the full mixed-category transaction total", () => {
    const mixed = transaction("mixed", [
      { categoryId: "utility", paidAmount: 400 },
      { categoryId: "food", paidAmount: 600 },
    ]);
    expect(mixed.cashPaidAmount).toBe(1_000);
    expect(sumMatchingItemPaidAmount(mixed, new Set(["utility"]))).toBe(400);
  });

  it("keeps an explicitly tagged utility item after its category changes", () => {
    const item = transaction("utility", [
      { categoryId: "other", paidAmount: 700 },
    ]).items[0]!;
    item.utilityKind = "electricity";
    expect(isUtilityItem(item, new Set(["utility"]))).toBe(true);
  });

  it("places a real chart line across the first and last values", () => {
    const markers = lineMarkers([100, 200, 300], 300, 100, 10);
    expect(markers[0]).toMatchObject({ key: "0-100", x: 10 });
    expect(markers[0]?.y).toBeCloseTo(63.3333);
    expect(markers[1]?.x).toBe(150);
    expect(markers[2]).toMatchObject({ key: "2-300", x: 290, y: 10 });
    expect(linePoints([100, 200, 300], 300, 100, 10)).toContain("10,63.333");
  });

  it("moves analysis tabs with arrows and supports Home and End", () => {
    expect(nextTabIndex(0, "ArrowRight", 3)).toBe(1);
    expect(nextTabIndex(0, "ArrowLeft", 3)).toBe(2);
    expect(nextTabIndex(1, "Home", 3)).toBe(0);
    expect(nextTabIndex(1, "End", 3)).toBe(2);
    expect(nextTabIndex(1, "Enter", 3)).toBe(1);
  });

  it("derives six Japanese-month chart points from the opening balance and real movements", () => {
    expect(
      monthlyAssetPoints("2026-09", 100, [
        { date: "2026-04-20", balanceAmount: 130 },
        { date: "2026-06-03", balanceAmount: 90 },
        { date: "2026-09-15", balanceAmount: 140 },
      ]),
    ).toEqual([
      { date: "2026-04-01", balanceAmount: 130 },
      { date: "2026-05-01", balanceAmount: 130 },
      { date: "2026-06-01", balanceAmount: 90 },
      { date: "2026-07-01", balanceAmount: 90 },
      { date: "2026-08-01", balanceAmount: 90 },
      { date: "2026-09-01", balanceAmount: 140 },
    ]);
  });

  it("formats the Figma monthly comparison as a signed percentage", () => {
    expect(monthComparison(999_999, 982_654)).toMatchObject({
      change: 17_345,
      percentage: 1.8,
      label: "+1.8%",
    });
    expect(monthComparison(80_000, 100_000).label).toBe("−20%");
  });

  it("pins the Figma chevrons to their component-scale dimensions", async () => {
    const [source, css] = await Promise.all([
      readFile(
        resolve(process.cwd(), "src/components/history-analytics.tsx"),
        "utf8",
      ),
      readFile(
        resolve(process.cwd(), "src/components/history-analytics.css"),
        "utf8",
      ),
    ]);

    expect(source).toContain('className="ha-summary-chevron"');
    expect(source).toContain('className="ha-row-chevron"');
    expect(source).toContain('src="/icons/filter.svg"');
    expect(css).toContain(".ha-summary-chevron {\n  align-self: center;");
    expect(css).toContain("  height: 8px;\n  width: 4px;");
    expect(css).toContain(".ha-row-chevron {\n  flex: 0 0 6px;");
    expect(css).toContain("  height: 12px;\n  width: 6px;");
  });

  it("uses static skeletons instead of spinner UI while a navigated screen loads", async () => {
    const source = await readFile(
      resolve(process.cwd(), "src/components/history-analytics.tsx"),
      "utf8",
    );

    expect(source).toContain("<HistorySkeleton />");
    expect(source).toContain("<AnalyticsSkeleton />");
    expect(source).toContain("<HistoryRefreshSkeleton />");
    expect(source).not.toContain("function Loading(");
  });

  it("keeps the selected month totals separate from the six-month main trend request and labels", async () => {
    expect(mainAnalyticsTrendRange("2026-09")).toEqual({ from: "2026-04-01", to: "2026-09-30" });
    expect(monthlyTrendLabels([
      { month: "2026-04" }, { month: "2026-05" }, { month: "2026-06" },
      { month: "2026-07" }, { month: "2026-08" }, { month: "2026-09" },
    ])).toEqual(["4月", "5月", "6月", "7月", "8月", "9月"]);
    const source = await readFile(resolve(process.cwd(), "src/components/history-analytics.tsx"), "utf8");
    expect(source).toContain("api<AnalyticsApiResponse>(analyticsUrl(trendRange))");
  });

  it("follows every transaction cursor instead of stopping after the first 100 results", async () => {
    const first = transaction("first", [
      { categoryId: "utility", paidAmount: 100 },
    ]);
    const second = transaction("second", [
      { categoryId: "utility", paidAmount: 200 },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ transactions: [first], nextCursor: "next-page" }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ transactions: [second], nextCursor: null }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchAllTransactions("2026-09-01", "2026-09-30", "expense"),
    ).resolves.toEqual([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=next-page");
  });
});

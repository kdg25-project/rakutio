import { afterEach, describe, expect, it, vi } from "vitest";

import type { LedgerTransaction } from "../server/ledger/types";
import {
  fetchAllTransactions,
  isUtilityItem,
  lineMarkers,
  linePoints,
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

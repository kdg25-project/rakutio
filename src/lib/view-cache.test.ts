import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearViewCacheForTest,
  invalidateViewCache,
  readViewCache,
  viewCacheKey,
  writeViewCache,
} from "./view-cache";

afterEach(() => {
  clearViewCacheForTest();
  vi.useRealTimers();
});

describe("view cache", () => {
  it("returns a cached payload immediately for the same user and query", () => {
    const key = viewCacheKey("user-a", "history", "2026-09");
    writeViewCache(key, { total: 1234 });

    expect(readViewCache<{ total: number }>(key)).toEqual({ total: 1234 });
  });

  it("does not cache data when the authenticated scope is absent", () => {
    const key = viewCacheKey(undefined, "history", "2026-09");
    writeViewCache(key, { total: 1234 });

    expect(key).toBeUndefined();
    expect(readViewCache(key)).toBeUndefined();
  });

  it("expires stale data and invalidates all related screens after a mutation", () => {
    vi.useFakeTimers();
    const history = viewCacheKey("user-a", "history", "2026-09");
    const assets = viewCacheKey("user-a", "assets", "all");
    const otherUser = viewCacheKey("user-b", "history", "2026-09");
    writeViewCache(history, "history", 1_000);
    writeViewCache(assets, "assets");
    writeViewCache(otherUser, "other");

    vi.advanceTimersByTime(1_001);
    expect(readViewCache(history)).toBeUndefined();
    invalidateViewCache("user-a");
    expect(readViewCache(assets)).toBeUndefined();
    expect(readViewCache(otherUser)).toBe("other");
  });
});

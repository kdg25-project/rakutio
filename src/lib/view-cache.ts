/**
 * Small client-side view cache for data-backed screens.
 *
 * Callers must supply the authenticated user id as `scope`.  Without it, this
 * module deliberately does not cache: showing the previous user's finances
 * during a quick sign-out/sign-in transition is worse than one loading state.
 */
type Entry<T> = { value: T; expiresAt: number };

const entries = new Map<string, Entry<unknown>>();

export function viewCacheKey(
  scope: string | undefined,
  screen: string,
  query: string,
) {
  return scope ? `${scope}:${screen}:${query}` : undefined;
}

export function readViewCache<T>(key: string | undefined): T | undefined {
  if (!key) return undefined;
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function writeViewCache<T>(
  key: string | undefined,
  value: T,
  maxAgeMs = 30_000,
) {
  if (!key) return;
  entries.set(key, { value, expiresAt: Date.now() + maxAgeMs });
}

/** Clear every cached screen for one user after a successful mutation. */
export function invalidateViewCache(scope: string | undefined) {
  if (!scope) return;
  const prefix = `${scope}:`;
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}

/** Test-only helper; it is intentionally not used by application code. */
export function clearViewCacheForTest() {
  entries.clear();
}

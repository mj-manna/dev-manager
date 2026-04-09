/**
 * Small in-memory TTL cache for panel data (reduces duplicate API work during silent refresh).
 * Cleared from Settings → Cache.
 */

type Entry = { expiresAt: number; value: unknown }

const store = new Map<string, Entry>()
const DEFAULT_TTL_MS = 12_000
const MAX_ENTRIES = 256

export function memoryCacheGet<T>(key: string): T | undefined {
  const e = store.get(key)
  if (!e) return undefined
  if (Date.now() > e.expiresAt) {
    store.delete(key)
    return undefined
  }
  return e.value as T
}

export function memoryCacheSet(key: string, value: unknown, ttlMs: number = DEFAULT_TTL_MS): void {
  while (store.size >= MAX_ENTRIES) {
    const first = store.keys().next().value
    if (first === undefined) break
    store.delete(first)
  }
  store.set(key, { expiresAt: Date.now() + ttlMs, value })
}

/** Clear all entries, or those whose key starts with `prefix` (e.g. `dm:panel:`). */
export function memoryCacheInvalidate(prefix?: string): void {
  if (prefix == null || prefix === '') {
    store.clear()
    return
  }
  for (const k of [...store.keys()]) {
    if (k.startsWith(prefix)) store.delete(k)
  }
}

export function memoryCacheStats(): { size: number; keys: string[] } {
  const now = Date.now()
  for (const [k, e] of [...store.entries()]) {
    if (now > e.expiresAt) store.delete(k)
  }
  return { size: store.size, keys: [...store.keys()] }
}

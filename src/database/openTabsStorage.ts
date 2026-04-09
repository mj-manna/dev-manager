const SESSION_KEY = 'dev-manager-db-conn-tabs-v2'
const LEGACY_SESSION_KEY = 'dev-manager-db-conn-tabs-v1'

/** Stable instance id for bookmark-style URLs without a random `inst`. */
export function defaultInstanceKey(connectionId: string): string {
  return `default:${connectionId}`
}

export type OpenConnTab = { kind: 'redis' | 'postgresql'; id: string; inst: string }

function parseStoredTabs(raw: string): OpenConnTab[] {
  const arr = JSON.parse(raw) as unknown
  if (!Array.isArray(arr)) return []
  return arr
    .map((x): OpenConnTab | null => {
      if (!x || typeof x !== 'object') return null
      const o = x as Record<string, unknown>
      const kind = o.kind
      const id = o.id
      if (kind !== 'redis' && kind !== 'postgresql') return null
      if (typeof id !== 'string' || id === '') return null
      const inst = o.inst
      if (typeof inst === 'string' && inst !== '') {
        return { kind, id, inst }
      }
      return { kind, id, inst: defaultInstanceKey(id) }
    })
    .filter((x): x is OpenConnTab => x != null)
}

function tryMigrateFromV1(): OpenConnTab[] | null {
  try {
    const raw = sessionStorage.getItem(LEGACY_SESSION_KEY)
    if (!raw) return null
    const tabs = parseStoredTabs(raw)
    sessionStorage.removeItem(LEGACY_SESSION_KEY)
    return tabs.length > 0 ? tabs : null
  } catch {
    return null
  }
}

export function loadOpenConnTabs(): OpenConnTab[] {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) {
      const migrated = tryMigrateFromV1()
      if (migrated) {
        saveOpenConnTabs(migrated)
        return migrated
      }
      return []
    }
    return parseStoredTabs(raw)
  } catch {
    return []
  }
}

export function saveOpenConnTabs(tabs: OpenConnTab[]): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(tabs))
  } catch {
    /* private mode / quota */
  }
}

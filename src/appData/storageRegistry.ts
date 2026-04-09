/**
 * All browser localStorage keys owned by this app — used for export / import / wipe.
 * Keep in sync when adding new persisted UI state.
 */

export const DEV_MANAGER_EXPORT_MARKER = 'devManagerExport' as const
export const DEV_MANAGER_EXPORT_VERSION = 1

export type ManagedStorageEntry = { key: string; label: string }

export const MANAGED_LOCAL_STORAGE: readonly ManagedStorageEntry[] = [
  { key: 'dev-manager-terminal-groups-v2', label: 'Deployments (terminal groups)' },
  { key: 'dev-manager-terminal-groups-active-v1', label: 'Deployments (active profile id)' },
  { key: 'dev-manager-terminal-groups-v1', label: 'Deployments (legacy v1, if present)' },
  { key: 'dev-manager-db-connections-v1', label: 'Database connections' },
  { key: 'dev-manager-theme', label: 'Theme preference' },
  { key: 'dev-manager-pg-admin-fields-v1', label: 'PostgreSQL admin form fields' },
  { key: 'dev-manager-postgres-page-size', label: 'PostgreSQL browser page size' },
  { key: 'dev-manager-terminal-jobs-v1', label: 'Terminal job history (after refresh)' },
  { key: 'dev-manager-deployments-running-slots-v1', label: 'Deployments (running slot ids, restore after refresh)' },
] as const

export const MANAGED_KEY_SET = new Set(MANAGED_LOCAL_STORAGE.map((e) => e.key))

export type DevManagerExportBundle = {
  [DEV_MANAGER_EXPORT_MARKER]: true
  version: number
  exportedAt: string
  localStorage: Record<string, string | null>
}

export function collectLocalStorageExport(): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  try {
    for (const { key } of MANAGED_LOCAL_STORAGE) {
      const v = localStorage.getItem(key)
      if (v != null && v !== '') out[key] = v
    }
  } catch {
    /* private mode */
  }
  return out
}

export function buildExportBundle(): DevManagerExportBundle {
  return {
    [DEV_MANAGER_EXPORT_MARKER]: true,
    version: DEV_MANAGER_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    localStorage: collectLocalStorageExport(),
  }
}

export function parseImportBundle(raw: string): DevManagerExportBundle | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { error: 'File is not valid JSON.' }
  }
  if (!parsed || typeof parsed !== 'object') return { error: 'Invalid export file.' }
  const o = parsed as Record<string, unknown>
  if (o[DEV_MANAGER_EXPORT_MARKER] !== true) {
    return { error: 'Not a Dev Manager export file (missing marker).' }
  }
  if (typeof o.version !== 'number' || o.version < 1) {
    return { error: 'Unsupported export version.' }
  }
  const ls = o.localStorage
  if (!ls || typeof ls !== 'object') return { error: 'Export has no localStorage data.' }
  const localStorage: Record<string, string | null> = {}
  for (const [k, v] of Object.entries(ls as Record<string, unknown>)) {
    if (!MANAGED_KEY_SET.has(k)) continue
    if (v === null) {
      localStorage[k] = null
    } else if (typeof v === 'string') {
      localStorage[k] = v
    }
  }
  return {
    [DEV_MANAGER_EXPORT_MARKER]: true,
    version: o.version as number,
    exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : '',
    localStorage,
  }
}

export function applyImportBundle(bundle: DevManagerExportBundle, mode: 'merge' | 'replace'): void {
  if (mode === 'replace') {
    for (const { key } of MANAGED_LOCAL_STORAGE) {
      try {
        localStorage.removeItem(key)
      } catch {
        /* ignore */
      }
    }
  }
  for (const [key, value] of Object.entries(bundle.localStorage)) {
    if (!MANAGED_KEY_SET.has(key)) continue
    try {
      if (value === null || value === '') localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    } catch {
      /* quota */
    }
  }
}

export function clearAllManagedLocalStorage(): void {
  for (const { key } of MANAGED_LOCAL_STORAGE) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  }
}

export const STORAGE_CHANGED_EVENT = 'dev-manager-storage-changed'

export function notifyAppStorageChanged(): void {
  window.dispatchEvent(new Event(STORAGE_CHANGED_EVENT))
}

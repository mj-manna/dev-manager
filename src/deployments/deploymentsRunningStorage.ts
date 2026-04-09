import { notifyAppStorageChanged } from '../appData/storageRegistry'

/** Slot IDs that had an active dev command; survives full page reload (tabs are recreated). */
export const DEPLOYMENTS_RUNNING_SLOTS_KEY = 'dev-manager-deployments-running-slots-v1'

export function loadPersistedRunningSlotIds(): string[] {
  try {
    const raw = localStorage.getItem(DEPLOYMENTS_RUNNING_SLOTS_KEY)
    if (!raw) return []
    const p = JSON.parse(raw) as unknown
    if (!Array.isArray(p)) return []
    return p.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  } catch {
    return []
  }
}

export function savePersistedRunningSlotIds(ids: readonly string[]): void {
  try {
    const unique = [...new Set(ids.filter((x) => x.trim()))]
    localStorage.setItem(DEPLOYMENTS_RUNNING_SLOTS_KEY, JSON.stringify(unique))
    notifyAppStorageChanged()
  } catch {
    /* quota */
  }
}

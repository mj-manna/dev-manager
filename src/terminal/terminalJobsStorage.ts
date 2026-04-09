import { notifyAppStorageChanged } from '../appData/storageRegistry'

/** Persisted across full page reload; terminal tabs/sessions are not (they are cleared on load). */
export const TERMINAL_JOBS_STORAGE_KEY = 'dev-manager-terminal-jobs-v1'

type StoredJobStatus = 'running' | 'success' | 'failed' | 'stopped'

/** Serializable job row (matches `TerminalJob` in TerminalContext). */
export type StoredJob = {
  id: string
  category: 'run' | 'task'
  label: string
  detail?: string
  tabId: string
  /** When set, a full reload can keep status "running" until the tab is recreated from Deployments restore. */
  projectSlotId?: string
  status: StoredJobStatus
  startedAt: number
  finishedAt?: number
  exitCode?: number | null
}

function isStoredJob(x: unknown): x is StoredJob {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.label !== 'string' || typeof o.tabId !== 'string') return false
  if (o.category !== 'run' && o.category !== 'task') return false
  if (o.status !== 'running' && o.status !== 'success' && o.status !== 'failed' && o.status !== 'stopped') {
    return false
  }
  if (typeof o.startedAt !== 'number' || !Number.isFinite(o.startedAt)) return false
  if (o.projectSlotId !== undefined && typeof o.projectSlotId !== 'string') return false
  return true
}

const INTERRUPTED_REFRESH = 'Interrupted (page refresh)'

/** Jobs with no deployment slot cannot survive reload — mark stopped. */
export function markRunningJobInterruptedOnReload(j: StoredJob, now: number): StoredJob {
  if (j.status !== 'running') return j
  return {
    ...j,
    status: 'stopped',
    finishedAt: now,
    exitCode: null,
    detail: j.detail?.trim() ? `${j.detail} · ${INTERRUPTED_REFRESH}` : INTERRUPTED_REFRESH,
  }
}

function finalizeRunningAfterReload(j: StoredJob, now: number): StoredJob {
  if (j.status !== 'running') return j
  if (typeof j.projectSlotId === 'string' && j.projectSlotId.trim()) return j
  return markRunningJobInterruptedOnReload(j, now)
}

export function loadPersistedTerminalJobs(max: number): StoredJob[] {
  try {
    const raw = localStorage.getItem(TERMINAL_JOBS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const now = Date.now()
    const out: StoredJob[] = []
    for (const item of parsed) {
      if (!isStoredJob(item)) continue
      out.push(finalizeRunningAfterReload(item, now))
    }
    return out.slice(0, max)
  } catch {
    return []
  }
}

export function persistTerminalJobs(jobs: readonly StoredJob[], max: number): void {
  try {
    localStorage.setItem(TERMINAL_JOBS_STORAGE_KEY, JSON.stringify(jobs.slice(0, max)))
    notifyAppStorageChanged()
  } catch {
    /* quota / private mode */
  }
}

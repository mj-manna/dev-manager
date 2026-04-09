import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { jobToastDescription, toast } from '../toast/toastBus'
import {
  loadPersistedTerminalJobs,
  markRunningJobInterruptedOnReload,
  persistTerminalJobs,
  type StoredJob,
} from './terminalJobsStorage'

export type TerminalExitPayload = {
  exitCode: number | null
  signal?: number | null
}

export type TerminalTab = {
  id: string
  label: string
  /** Empty string → server default (usually $HOME). */
  cwd: string
  pendingCommand: string | null
  /** Deployments project row id when this tab was started from the panel. */
  projectSlotId?: string
}

export type TerminalJobCategory = 'run' | 'task'

export type TerminalJobStatus = 'running' | 'success' | 'failed' | 'stopped'

export type TerminalJob = {
  id: string
  category: TerminalJobCategory
  label: string
  detail?: string
  tabId: string
  /** Present for Deployments runs — survives reload and reconnects to the recreated tab. */
  projectSlotId?: string
  status: TerminalJobStatus
  startedAt: number
  finishedAt?: number
  exitCode?: number | null
}

export type RunInTerminalOptions = {
  cwd?: string
  label?: string
  projectSlotId?: string
  /** When set, job appears in the header jobs menu (Runs vs Tasks). */
  jobCategory?: TerminalJobCategory
  /** Shown as subtitle in the jobs menu; defaults to the command. */
  jobDetail?: string
}

export type AddTerminalTabOptions = {
  label: string
  cwd: string
  command?: string
  projectSlotId?: string
  jobCategory?: TerminalJobCategory
  jobDetail?: string
}

const MAX_TERMINAL_JOBS = 80

function newTabId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `t-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function newTerminalJobId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? `job-${crypto.randomUUID()}`
    : `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function upsertRunningJobForTab(
  prev: TerminalJob[],
  tabId: string,
  category: TerminalJobCategory,
  label: string,
  detail: string | undefined,
  projectSlotId: string | undefined,
): TerminalJob[] {
  const sid = projectSlotId?.trim()
  if (sid) {
    const i = prev.findIndex(
      (j) => j.status === 'running' && j.category === category && j.projectSlotId === sid,
    )
    if (i >= 0) {
      return prev.map((j, idx) =>
        idx === i
          ? {
              ...j,
              tabId,
              label: label.trim() || j.label,
              ...(detail !== undefined ? { detail } : {}),
            }
          : j,
      )
    }
  }
  const row: TerminalJob = {
    id: newTerminalJobId(),
    category,
    label,
    detail,
    tabId,
    status: 'running',
    startedAt: Date.now(),
    ...(sid ? { projectSlotId: sid } : {}),
  }
  return [row, ...prev].slice(0, MAX_TERMINAL_JOBS)
}

type TerminalContextValue = {
  open: boolean
  heightPx: number
  setHeightPx: (n: number) => void
  tabs: TerminalTab[]
  activeTabId: string | null
  selectTerminalTab: (id: string) => void
  /** Select tab and expand the terminal drawer (sessions keep running while hidden). */
  focusTerminalTab: (id: string) => void
  addTerminalTab: (opts: AddTerminalTabOptions) => string
  removeTerminalTab: (id: string) => void
  clearTabPendingCommand: (id: string) => void
  /** Ensures one shell tab exists (e.g. when opening the panel). */
  ensureAtLeastOneTab: () => void
  showTerminal: () => void
  hideTerminal: () => void
  toggleTerminal: () => void
  /** Returns the new tab id when a dedicated tab is created (labeled / cwd run). */
  runInTerminal: (command: string, opts?: RunInTerminalOptions) => string | undefined
  lastExit: TerminalExitPayload | null
  clearLastExit: () => void
  lastReadyBanner: string | null
  setLastReadyBanner: (msg: string | null) => void
  /** Second arg ties shell exit to a tab (for deployments start/stop). */
  reportShellExit: (p: TerminalExitPayload, tabId?: string) => void
  /**
   * When a command finishes inside a live PTY (install, script, etc.), the shell does not exit.
   * TerminalPane detects a marker in output and calls this to flip the newest running job for the tab.
   */
  completeLatestRunningJobForTab: (tabId: string, exitCode: number | null) => void
  tabExitEvent: { tabId: string; payload: TerminalExitPayload } | null
  clearTabExitEvent: () => void
  terminalJobs: TerminalJob[]
  dismissTerminalJob: (jobId: string) => void
  /** Deployments panel: slot id → terminal tab id (cleared when tab closes or shell/job ends). */
  deploymentSlotTabMap: Record<string, string>
  linkDeploymentSlotToTab: (slotId: string, tabId: string) => void
}

const TerminalContext = createContext<TerminalContextValue | null>(null)

export function TerminalProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [heightPx, setHeightPx] = useState(300)
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [deploymentSlotTabMap, setDeploymentSlotTabMap] = useState<Record<string, string>>({})
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [lastExit, setLastExit] = useState<TerminalExitPayload | null>(null)
  const [tabExitEvent, setTabExitEvent] = useState<{ tabId: string; payload: TerminalExitPayload } | null>(
    null,
  )
  const [lastReadyBanner, setLastReadyBanner] = useState<string | null>(null)
  const [terminalJobs, setTerminalJobs] = useState<TerminalJob[]>(() =>
    loadPersistedTerminalJobs(MAX_TERMINAL_JOBS) as TerminalJob[],
  )
  const activeTabIdRef = useRef<string | null>(null)
  const tabsRef = useRef<TerminalTab[]>([])

  useEffect(() => {
    persistTerminalJobs(terminalJobs as StoredJob[], MAX_TERMINAL_JOBS)
  }, [terminalJobs])

  const selectTerminalTab = useCallback((id: string) => {
    setActiveTabId(id)
  }, [])

  const focusTerminalTab = useCallback((id: string) => {
    if (!tabsRef.current.some((x) => x.id === id)) return
    setActiveTabId(id)
    setOpen(true)
  }, [])

  const clearTabPendingCommand = useCallback((id: string) => {
    setTabs((t) => t.map((tab) => (tab.id === id ? { ...tab, pendingCommand: null } : tab)))
  }, [])

  const dismissTerminalJob = useCallback((jobId: string) => {
    setTerminalJobs((prev) => prev.filter((j) => j.id !== jobId))
  }, [])

  const unlinkDeploymentSlotsForTabId = useCallback((tabId: string) => {
    setDeploymentSlotTabMap((m) => {
      let changed = false
      const next = { ...m }
      for (const k of Object.keys(next)) {
        if (next[k] === tabId) {
          delete next[k]
          changed = true
        }
      }
      return changed ? next : m
    })
  }, [])

  const linkDeploymentSlotToTab = useCallback((slotId: string, tabId: string) => {
    setDeploymentSlotTabMap((m) => ({ ...m, [slotId]: tabId }))
  }, [])

  const addTerminalTab = useCallback((opts: AddTerminalTabOptions) => {
    const id = newTabId()
    setTabs((t) => [
      ...t,
      {
        id,
        label: opts.label,
        cwd: opts.cwd,
        pendingCommand: opts.command ?? null,
        projectSlotId: opts.projectSlotId,
      },
    ])
    setActiveTabId(id)
    setOpen(true)
    setLastExit(null)
    const jc = opts.jobCategory
    if (jc) {
      setTerminalJobs((prev) =>
        upsertRunningJobForTab(
          prev,
          id,
          jc,
          opts.label,
          opts.jobDetail ?? opts.command,
          opts.projectSlotId,
        ),
      )
    }
    return id
  }, [])

  const removeTerminalTab = useCallback((id: string) => {
    unlinkDeploymentSlotsForTabId(id)
    setTerminalJobs((prev) => {
      const running = prev.filter((j) => j.tabId === id && j.status === 'running')
      if (running.length > 0) {
        queueMicrotask(() => {
          if (running.length === 1) {
            toast.info('Task stopped', { description: running[0]!.label })
          } else {
            toast.info(`${running.length} tasks stopped`, { description: 'Terminal tab closed' })
          }
        })
      }
      return prev.map((j) =>
        j.tabId === id && j.status === 'running'
          ? { ...j, status: 'stopped', finishedAt: Date.now(), exitCode: null }
          : j,
      )
    })
    setTabs((t) => t.filter((x) => x.id !== id))
  }, [unlinkDeploymentSlotsForTabId])

  const ensureAtLeastOneTab = useCallback(() => {
    setTabs((t) =>
      t.length > 0
        ? t
        : [{ id: newTabId(), label: 'Shell', cwd: '', pendingCommand: null }],
    )
  }, [])

  const showTerminal = useCallback(() => setOpen(true), [])
  const hideTerminal = useCallback(() => setOpen(false), [])
  const toggleTerminal = useCallback(() => setOpen((o) => !o), [])
  const clearLastExit = useCallback(() => setLastExit(null), [])
  const completeLatestRunningJobForTab = useCallback((tabId: string, exitCode: number | null) => {
    unlinkDeploymentSlotsForTabId(tabId)
    const p: TerminalExitPayload = { exitCode, signal: null }
    setLastExit(p)
    setTabExitEvent({ tabId, payload: p })
    setTerminalJobs((prev) => {
      const running = prev.filter((j) => j.tabId === tabId && j.status === 'running')
      if (running.length === 0) return prev
      const target = running.reduce((a, b) => (a.startedAt >= b.startedAt ? a : b))
      const ok = exitCode === 0
      queueMicrotask(() => {
        const desc = jobToastDescription(target.detail, exitCode)
        if (ok) toast.success(target.label, { description: desc })
        else toast.error(target.label, { description: desc })
      })
      return prev.map((j) =>
        j.id === target.id
          ? {
              ...j,
              status: ok ? 'success' : 'failed',
              finishedAt: Date.now(),
              exitCode,
            }
          : j,
      )
    })
  }, [unlinkDeploymentSlotsForTabId])

  const reportShellExit = useCallback((p: TerminalExitPayload, tabId?: string) => {
    setLastExit(p)
    if (tabId) {
      unlinkDeploymentSlotsForTabId(tabId)
      setTabExitEvent({ tabId, payload: p })
      setTerminalJobs((prev) => {
        const running = prev.filter((j) => j.tabId === tabId && j.status === 'running')
        if (running.length > 0) {
          queueMicrotask(() => {
            const lost = p.exitCode === null && p.signal == null
            if (running.length === 1) {
              const j = running[0]!
              if (lost) {
                toast.warning('Shell session ended', { description: j.label })
              } else if (p.exitCode === 0) {
                toast.success(j.label, { description: jobToastDescription(j.detail, p.exitCode) })
              } else {
                toast.error(j.label, { description: jobToastDescription(j.detail, p.exitCode) })
              }
            } else if (lost) {
              toast.warning('Shell disconnected', {
                description: `${running.length} running tasks were on this tab`,
              })
            } else if (p.exitCode === 0) {
              toast.info('Shell session ended', {
                description: `${running.length} tasks completed (exit 0)`,
              })
            } else {
              toast.error('Shell session ended', {
                description: `${running.length} tasks · exit ${p.exitCode ?? '—'}`,
              })
            }
          })
        }
        return prev.map((j) => {
          if (j.tabId !== tabId || j.status !== 'running') return j
          const code = p.exitCode
          const ok = code === 0
          return {
            ...j,
            status: ok ? 'success' : 'failed',
            finishedAt: Date.now(),
            exitCode: code,
          }
        })
      })
    }
  }, [unlinkDeploymentSlotsForTabId])

  const clearTabExitEvent = useCallback(() => setTabExitEvent(null), [])

  const runInTerminal = useCallback((command: string, opts?: RunInTerminalOptions): string | undefined => {
    setLastExit(null)
    setOpen(true)
    const hasTarget = opts != null && (opts.cwd !== undefined || opts.label !== undefined)
    if (hasTarget) {
      const id = newTabId()
      const label =
        opts?.label?.trim() ||
        (opts?.cwd && opts.cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop()) ||
        'Task'
      setTabs((t) => [
        ...t,
        {
          id,
          label,
          cwd: opts?.cwd ?? '',
          pendingCommand: command,
          projectSlotId: opts?.projectSlotId,
        },
      ])
      setActiveTabId(id)
      const jc = opts?.jobCategory
      if (jc) {
        setTerminalJobs((prev) =>
          upsertRunningJobForTab(
            prev,
            id,
            jc,
            label,
            opts.jobDetail ?? command,
            opts?.projectSlotId,
          ),
        )
      }
      return id
    }
    setTabs((t) => {
      if (t.length === 0) {
        return [{ id: newTabId(), label: 'Shell', cwd: '', pendingCommand: command }]
      }
      const aid = activeTabIdRef.current
      const target = aid && t.some((x) => x.id === aid) ? aid : t[0].id
      setActiveTabId(target)
      return t.map((tab) => (tab.id === target ? { ...tab, pendingCommand: command } : tab))
    })
    return undefined
  }, [])

  const resolvedActiveTabId = useMemo(() => {
    if (tabs.length === 0) return null
    if (activeTabId && tabs.some((x) => x.id === activeTabId)) return activeTabId
    return tabs[0].id
  }, [tabs, activeTabId])

  useEffect(() => {
    activeTabIdRef.current = resolvedActiveTabId
  }, [resolvedActiveTabId])

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  /** Deployment jobs tied to a slot keep "running" across reload; stop them if no tab exists (slot removed / restore failed). */
  useEffect(() => {
    const tabIds = new Set(tabs.map((t) => t.id))
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reconcile slot-linked jobs when tabs change
    setTerminalJobs((prev) => {
      let changed = false
      const next = prev.map((j) => {
        if (j.status !== 'running' || !j.projectSlotId?.trim()) return j
        if (tabIds.has(j.tabId)) return j
        changed = true
        return markRunningJobInterruptedOnReload(j, Date.now()) as TerminalJob
      })
      return changed ? next : prev
    })
  }, [tabs])

  const value = useMemo(
    () => ({
      open,
      heightPx,
      setHeightPx,
      tabs,
      activeTabId: resolvedActiveTabId,
      selectTerminalTab,
      focusTerminalTab,
      addTerminalTab,
      removeTerminalTab,
      clearTabPendingCommand,
      ensureAtLeastOneTab,
      showTerminal,
      hideTerminal,
      toggleTerminal,
      runInTerminal,
      lastExit,
      clearLastExit,
      lastReadyBanner,
      setLastReadyBanner,
      reportShellExit,
      completeLatestRunningJobForTab,
      tabExitEvent,
      clearTabExitEvent,
      terminalJobs,
      dismissTerminalJob,
      deploymentSlotTabMap,
      linkDeploymentSlotToTab,
    }),
    [
      open,
      heightPx,
      tabs,
      resolvedActiveTabId,
      selectTerminalTab,
      focusTerminalTab,
      addTerminalTab,
      removeTerminalTab,
      clearTabPendingCommand,
      ensureAtLeastOneTab,
      showTerminal,
      hideTerminal,
      toggleTerminal,
      runInTerminal,
      lastExit,
      clearLastExit,
      lastReadyBanner,
      reportShellExit,
      completeLatestRunningJobForTab,
      tabExitEvent,
      clearTabExitEvent,
      terminalJobs,
      dismissTerminalJob,
      deploymentSlotTabMap,
      linkDeploymentSlotToTab,
    ],
  )

  return (
    <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components -- useTerminal must live next to Provider
export function useTerminal() {
  const ctx = useContext(TerminalContext)
  if (!ctx) throw new Error('useTerminal must be used within TerminalProvider')
  return ctx
}

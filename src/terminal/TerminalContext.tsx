import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

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

export type RunInTerminalOptions = {
  cwd?: string
  label?: string
  projectSlotId?: string
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
  addTerminalTab: (opts: { label: string; cwd: string; command?: string; projectSlotId?: string }) => string
  removeTerminalTab: (id: string) => void
  clearTabPendingCommand: (id: string) => void
  /** Ensures one shell tab exists (e.g. when opening the panel). */
  ensureAtLeastOneTab: () => void
  showTerminal: () => void
  hideTerminal: () => void
  toggleTerminal: () => void
  runInTerminal: (command: string, opts?: RunInTerminalOptions) => void
  lastExit: TerminalExitPayload | null
  clearLastExit: () => void
  lastReadyBanner: string | null
  setLastReadyBanner: (msg: string | null) => void
  /** Second arg ties shell exit to a tab (for deployments start/stop). */
  reportShellExit: (p: TerminalExitPayload, tabId?: string) => void
  tabExitEvent: { tabId: string; payload: TerminalExitPayload } | null
  clearTabExitEvent: () => void
}

const TerminalContext = createContext<TerminalContextValue | null>(null)

function newTabId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `t-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function TerminalProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [heightPx, setHeightPx] = useState(300)
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [lastExit, setLastExit] = useState<TerminalExitPayload | null>(null)
  const [tabExitEvent, setTabExitEvent] = useState<{ tabId: string; payload: TerminalExitPayload } | null>(
    null,
  )
  const [lastReadyBanner, setLastReadyBanner] = useState<string | null>(null)
  const activeTabIdRef = useRef<string | null>(null)
  const tabsRef = useRef<TerminalTab[]>([])

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

  const addTerminalTab = useCallback(
    (opts: { label: string; cwd: string; command?: string; projectSlotId?: string }) => {
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
      return id
    },
    [],
  )

  const removeTerminalTab = useCallback((id: string) => {
    setTabs((t) => t.filter((x) => x.id !== id))
  }, [])

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
  const reportShellExit = useCallback((p: TerminalExitPayload, tabId?: string) => {
    setLastExit(p)
    if (tabId) setTabExitEvent({ tabId, payload: p })
  }, [])

  const clearTabExitEvent = useCallback(() => setTabExitEvent(null), [])

  const runInTerminal = useCallback((command: string, opts?: RunInTerminalOptions) => {
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
      return
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
      tabExitEvent,
      clearTabExitEvent,
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
      tabExitEvent,
      clearTabExitEvent,
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

import { startTransition, useCallback, useEffect, useMemo, useState } from 'react'
import { STORAGE_CHANGED_EVENT } from '../appData/storageRegistry'
import {
  PROJECT_ENVIRONMENTS,
  createEmptyGroup,
  createEmptySlot,
  loadActiveGroupId,
  loadTerminalGroups,
  saveActiveGroupId,
  saveTerminalGroups,
  type ProjectEnvironment,
  type TerminalGroup,
  type TerminalGroupSlot,
} from '../deployments/terminalGroupsStorage'
import { useTerminal } from '../terminal/TerminalContext'
import { ConfirmDangerModal } from './ConfirmDangerModal'
type DeployLogEntry = {
  id: string
  at: number
  message: string
  /** Terminal tab id when the action created a session you can focus. */
  tabId?: string
}

function newLogId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `l-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function slotRunnable(s: TerminalGroupSlot) {
  return Boolean(s.label.trim() && s.cwd.trim() && s.command.trim())
}

function buildCommand(slot: TerminalGroupSlot) {
  const cmd = slot.command.trim() || 'pnpm dev'
  const port = slot.portNote?.trim()
  if (port && /^[0-9]+$/.test(port) && !/\bPORT=/.test(cmd) && !/--port\b/.test(cmd)) {
    return `PORT=${port} ${cmd}`
  }
  return cmd
}

const SLOT_DRAG_MIME = 'application/x-dev-manager-slot-index'

/** Turn optional domain / URL into a full href for window.open. */
function resolveSiteHref(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return s
  const hostPart = (s.split(/[/\s?#]/)[0] ?? '').toLowerCase()
  const isLocalStyle =
    hostPart === 'localhost' ||
    hostPart.startsWith('localhost:') ||
    hostPart === '127.0.0.1' ||
    hostPart.startsWith('127.0.0.1:') ||
    hostPart.endsWith('.local') ||
    hostPart.includes('.local:') ||
    hostPart.endsWith('.test') ||
    hostPart.includes('.test:') ||
    hostPart.endsWith('.localhost') ||
    hostPart.includes('.localhost:')
  const scheme = isLocalStyle ? 'http' : 'https'
  return `${scheme}://${s.replace(/^\/+/, '')}`
}

function openSiteInNewTab(raw: string) {
  const href = resolveSiteHref(raw)
  if (href) window.open(href, '_blank', 'noopener,noreferrer')
}

function envPillClass(env: ProjectEnvironment): string {
  switch (env) {
    case 'production':
      return 'env-pill env-pill--production'
    case 'staging':
      return 'env-pill env-pill--staging'
    case 'preview':
      return 'env-pill env-pill--preview'
    default:
      return 'env-pill env-pill--staging'
  }
}

export function DeploymentsPanel() {
  const {
    open,
    showTerminal,
    focusTerminalTab,
    addTerminalTab,
    removeTerminalTab,
    tabs,
    tabExitEvent,
    clearTabExitEvent,
  } = useTerminal()

  const [groups, setGroups] = useState<TerminalGroup[]>(() => loadTerminalGroups())
  const [activeGroupId, setActiveGroupId] = useState<string | null>(() => {
    const saved = loadActiveGroupId()
    const initial = loadTerminalGroups()
    if (saved && initial.some((g) => g.id === saved)) return saved
    return initial[0]?.id ?? null
  })

  /** project slot id → terminal tab id (may include closed tabs until pruned by exit handler) */
  const [projectTabMap, setProjectTabMap] = useState<Record<string, string>>({})

  const runningMap = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [pid, tid] of Object.entries(projectTabMap)) {
      if (tabs.some((t) => t.id === tid)) out[pid] = tid
    }
    return out
  }, [projectTabMap, tabs])

  const tabIdsKey = useMemo(
    () =>
      [...tabs]
        .map((t) => t.id)
        .sort()
        .join('\0'),
    [tabs],
  )

  /** Drop stale slot→tab links when tabs are removed (e.g. closed) without a WS exit event. */
  useEffect(() => {
    const idSet = new Set(tabIdsKey ? tabIdsKey.split('\0') : [])
    setProjectTabMap((m) => {
      let changed = false
      const next = { ...m }
      for (const k of Object.keys(next)) {
        if (!idSet.has(next[k])) {
          delete next[k]
          changed = true
        }
      }
      return changed ? next : m
    })
  }, [tabIdsKey])

  const [deployView, setDeployView] = useState<'projects' | 'activity'>('projects')
  const [deployLog, setDeployLog] = useState<DeployLogEntry[]>([])

  const pushDeployLog = useCallback((message: string, tabId?: string) => {
    setDeployLog((prev) =>
      [{ id: newLogId(), at: Date.now(), message, tabId }, ...prev].slice(0, 150),
    )
  }, [])

  const [addModalOpen, setAddModalOpen] = useState(false)
  const [editSlotId, setEditSlotId] = useState<string | null>(null)
  const [deleteSlotId, setDeleteSlotId] = useState<string | null>(null)
  const [deleteProfileId, setDeleteProfileId] = useState<string | null>(null)

  const [formName, setFormName] = useState('')
  const [formPath, setFormPath] = useState('')
  const [formCommand, setFormCommand] = useState('pnpm dev')
  const [formEnv, setFormEnv] = useState<ProjectEnvironment>('development')
  const [formPort, setFormPort] = useState('')
  const [formSiteUrl, setFormSiteUrl] = useState('')

  const [dragSlotIndex, setDragSlotIndex] = useState<number | null>(null)

  useEffect(() => {
    saveTerminalGroups(groups)
  }, [groups])

  useEffect(() => {
    const sync = () => {
      const nextGroups = loadTerminalGroups()
      setGroups(nextGroups)
      const saved = loadActiveGroupId()
      if (saved && nextGroups.some((g) => g.id === saved)) setActiveGroupId(saved)
      else setActiveGroupId(nextGroups[0]?.id ?? null)
    }
    window.addEventListener(STORAGE_CHANGED_EVENT, sync)
    return () => window.removeEventListener(STORAGE_CHANGED_EVENT, sync)
  }, [])

  const effectiveGroupId = useMemo(() => {
    if (groups.length === 0) return null
    if (activeGroupId && groups.some((g) => g.id === activeGroupId)) return activeGroupId
    return groups[0].id
  }, [groups, activeGroupId])

  useEffect(() => {
    if (effectiveGroupId) saveActiveGroupId(effectiveGroupId)
  }, [effectiveGroupId])

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === effectiveGroupId) ?? groups[0] ?? null,
    [groups, effectiveGroupId],
  )

  const pendingProfileDelete = useMemo(
    () => (deleteProfileId ? groups.find((g) => g.id === deleteProfileId) : undefined),
    [deleteProfileId, groups],
  )

  const totalProjects = useMemo(() => groups.reduce((n, g) => n + g.slots.length, 0), [groups])
  const runningCount = useMemo(() => Object.keys(runningMap).length, [runningMap])

  const stats = useMemo(() => {
    const here = activeGroup?.slots.length ?? 0
    return [
      {
        label: 'Terminal groups',
        value: String(groups.length),
        change: `${totalProjects} projects`,
        trend: 'up' as const,
      },
      {
        label: 'This profile',
        value: activeGroup?.name ?? '—',
        change: `${here} project${here === 1 ? '' : 's'}`,
        trend: 'up' as const,
      },
      {
        label: 'Running now',
        value: String(runningCount),
        change: runningCount ? 'active' : 'idle',
        trend: runningCount ? ('up' as const) : ('down' as const),
      },
      {
        label: 'Integrated shell',
        value: open ? 'Open' : 'Hidden',
        change: open ? 'Live' : 'Tap header',
        trend: 'up' as const,
      },
    ]
  }, [groups.length, totalProjects, activeGroup, runningCount, open])

  useEffect(() => {
    if (!tabExitEvent) return
    const { tabId } = tabExitEvent
    startTransition(() => {
      setProjectTabMap((m) => {
        const next = { ...m }
        for (const k of Object.keys(next)) {
          if (next[k] === tabId) delete next[k]
        }
        return next
      })
      clearTabExitEvent()
    })
  }, [tabExitEvent, clearTabExitEvent])

  const patchGroup = useCallback((groupId: string, fn: (g: TerminalGroup) => TerminalGroup) => {
    setGroups((gs) => gs.map((g) => (g.id === groupId ? fn(g) : g)))
  }, [])

  const moveSlot = useCallback(
    (groupId: string, from: number, to: number) => {
      if (from === to || from < 0 || to < 0) return
      patchGroup(groupId, (g) => {
        if (from >= g.slots.length || to >= g.slots.length) return g
        const slots = [...g.slots]
        const [item] = slots.splice(from, 1)
        slots.splice(to, 0, item)
        return { ...g, slots }
      })
    },
    [patchGroup],
  )

  const addGroup = useCallback(() => {
    const g = createEmptyGroup(`Group ${groups.length + 1}`)
    setGroups((gs) => [...gs, g])
    setActiveGroupId(g.id)
  }, [groups.length])

  const removeGroup = useCallback((id: string) => {
    setGroups((gs) => {
      const next = gs.filter((g) => g.id !== id)
      return next.length === 0 ? [createEmptyGroup('Default')] : next
    })
  }, [])

  const resetForm = useCallback(() => {
    setFormName('')
    setFormPath('')
    setFormCommand('pnpm dev')
    setFormEnv('development')
    setFormPort('')
    setFormSiteUrl('')
  }, [])

  const openAddModal = useCallback(() => {
    resetForm()
    setAddModalOpen(true)
  }, [resetForm])

  const populateFormFromSlot = useCallback((s: TerminalGroupSlot) => {
    setFormName(s.label)
    setFormPath(s.cwd)
    setFormCommand(s.command || 'pnpm dev')
    setFormEnv(s.environment)
    setFormPort(s.portNote ?? '')
    setFormSiteUrl(s.siteUrl ?? '')
  }, [])

  const slotFromForm = useCallback(
    (id: string): TerminalGroupSlot => ({
      id,
      label: formName.trim(),
      cwd: formPath.trim(),
      command: formCommand.trim() || 'pnpm dev',
      portNote: formPort.trim(),
      siteUrl: formSiteUrl.trim(),
      environment: formEnv,
    }),
    [formName, formPath, formCommand, formPort, formSiteUrl, formEnv],
  )

  const createProject = useCallback(() => {
    if (!activeGroup) return
    if (!formName.trim() || !formPath.trim() || !formCommand.trim()) return
    const blank = createEmptySlot()
    const slot = slotFromForm(blank.id)
    patchGroup(activeGroup.id, (g) => ({ ...g, slots: [...g.slots, slot] }))
    setAddModalOpen(false)
    resetForm()
  }, [activeGroup, formName, formPath, formCommand, patchGroup, resetForm, slotFromForm])

  const saveEdit = useCallback(() => {
    if (!activeGroup || !editSlotId) return
    if (!formName.trim() || !formPath.trim() || !formCommand.trim()) return
    const next = slotFromForm(editSlotId)
    const wasRunning = Boolean(runningMap[editSlotId])
    const oldTabId = runningMap[editSlotId]

    patchGroup(activeGroup.id, (g) => ({
      ...g,
      slots: g.slots.map((s) => (s.id === editSlotId ? next : s)),
    }))

    setEditSlotId(null)
    resetForm()

    if (wasRunning && oldTabId) {
      removeTerminalTab(oldTabId)
      setProjectTabMap((m) => {
        const x = { ...m }
        delete x[editSlotId]
        return x
      })
      window.setTimeout(() => {
        const cmd = buildCommand(next)
        const tabId = addTerminalTab({
          label: next.label || 'Project',
          cwd: next.cwd,
          command: cmd,
          projectSlotId: next.id,
        })
        setProjectTabMap((m) => ({ ...m, [next.id]: tabId }))
        pushDeployLog(`Saved & restarted “${next.label.trim() || 'project'}”`, tabId)
        showTerminal()
      }, 200)
    }
  }, [
    activeGroup,
    editSlotId,
    formName,
    formPath,
    formCommand,
    patchGroup,
    resetForm,
    runningMap,
    removeTerminalTab,
    addTerminalTab,
    showTerminal,
    slotFromForm,
    pushDeployLog,
  ])

  const startProject = useCallback(
    (slot: TerminalGroupSlot) => {
      if (!slotRunnable(slot) || runningMap[slot.id]) return
      const tabId = addTerminalTab({
        label: slot.label.trim() || 'Project',
        cwd: slot.cwd.trim(),
        command: buildCommand(slot),
        projectSlotId: slot.id,
      })
      setProjectTabMap((m) => ({ ...m, [slot.id]: tabId }))
      pushDeployLog(`Started “${slot.label.trim() || 'project'}”`, tabId)
      showTerminal()
    },
    [runningMap, addTerminalTab, showTerminal, pushDeployLog],
  )

  const stopProject = useCallback(
    (slot: TerminalGroupSlot) => {
      const tid = runningMap[slot.id]
      if (!tid) return
      pushDeployLog(`Stopped “${slot.label.trim() || 'project'}” (terminal tab closed)`)
      removeTerminalTab(tid)
      setProjectTabMap((m) => {
        const x = { ...m }
        delete x[slot.id]
        return x
      })
    },
    [runningMap, removeTerminalTab, pushDeployLog],
  )

  const restartProject = useCallback(
    (slot: TerminalGroupSlot) => {
      const tid = runningMap[slot.id]
      if (tid) removeTerminalTab(tid)
      setProjectTabMap((m) => {
        const x = { ...m }
        delete x[slot.id]
        return x
      })
      window.setTimeout(() => {
        if (!slotRunnable(slot)) return
        const tabId = addTerminalTab({
          label: slot.label.trim() || 'Project',
          cwd: slot.cwd.trim(),
          command: buildCommand(slot),
          projectSlotId: slot.id,
        })
        setProjectTabMap((m) => ({ ...m, [slot.id]: tabId }))
        pushDeployLog(`Restarted “${slot.label.trim() || 'project'}”`, tabId)
        showTerminal()
      }, 200)
    },
    [runningMap, removeTerminalTab, addTerminalTab, showTerminal, pushDeployLog],
  )

  const confirmRemoveProfile = useCallback(() => {
    if (!deleteProfileId) return
    const g = groups.find((x) => x.id === deleteProfileId)
    if (g) {
      for (const slot of g.slots) {
        if (runningMap[slot.id]) stopProject(slot)
      }
      pushDeployLog(`Removed profile “${g.name.trim() || 'profile'}”`)
    }
    removeGroup(deleteProfileId)
    setDeleteProfileId(null)
  }, [deleteProfileId, groups, runningMap, removeGroup, stopProject, pushDeployLog])

  const confirmDelete = useCallback(() => {
    if (!activeGroup || !deleteSlotId) return
    const slot = activeGroup.slots.find((s) => s.id === deleteSlotId)
    if (slot && runningMap[slot.id]) stopProject(slot)
    if (slot) {
      pushDeployLog(`Removed “${slot.label.trim() || 'project'}” from this profile`)
    }
    patchGroup(activeGroup.id, (g) => ({
      ...g,
      slots: g.slots.filter((s) => s.id !== deleteSlotId),
    }))
    setDeleteSlotId(null)
  }, [activeGroup, deleteSlotId, runningMap, patchGroup, stopProject, pushDeployLog])

  const projectFormFields = (
    <>
      <label className="deployments-modal__field">
        <span>Project name</span>
        <input
          type="text"
          className="deployments-modal__input"
          value={formName}
          onChange={(e) => setFormName(e.target.value)}
          placeholder="My app"
          autoComplete="off"
        />
      </label>
      <label className="deployments-modal__field">
        <span>Path</span>
        <input
          type="text"
          className="deployments-modal__input"
          value={formPath}
          onChange={(e) => setFormPath(e.target.value)}
          placeholder="/home/you/projects/my-app"
          autoComplete="off"
        />
      </label>
      <label className="deployments-modal__field">
        <span>Command</span>
        <input
          type="text"
          className="deployments-modal__input deployments-modal__input--mono"
          value={formCommand}
          onChange={(e) => setFormCommand(e.target.value)}
          placeholder="pnpm dev"
          autoComplete="off"
        />
      </label>
      <label className="deployments-modal__field">
        <span>Environment</span>
        <select
          className="deployments-modal__input"
          value={formEnv}
          onChange={(e) => setFormEnv(e.target.value as ProjectEnvironment)}
        >
          {PROJECT_ENVIRONMENTS.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </label>
      <label className="deployments-modal__field">
        <span>Port (optional)</span>
        <input
          type="text"
          className="deployments-modal__input deployments-modal__input--narrow"
          value={formPort}
          onChange={(e) => setFormPort(e.target.value)}
          placeholder="5173"
          autoComplete="off"
        />
      </label>
      <label className="deployments-modal__field">
        <span>Site URL (optional)</span>
        <input
          type="text"
          className="deployments-modal__input deployments-modal__input--mono"
          value={formSiteUrl}
          onChange={(e) => setFormSiteUrl(e.target.value)}
          placeholder="localhost:5173 or https://myapp.test"
          autoComplete="off"
        />
      </label>
    </>
  )

  if (!activeGroup) {
    return (
      <section className="panel deployments-panel">
        <p className="deployments-panel__empty">Loading…</p>
      </section>
    )
  }

  return (
    <>
      <section className="admin__stats" aria-label="Deployments metrics">
        {stats.map((s) => (
          <article key={s.label} className="stat-card">
            <div className="stat-card__label">{s.label}</div>
            <div className="stat-card__row">
              <span className="stat-card__value deployments-panel__stat-value">{s.value}</span>
              <span className={`stat-card__change stat-card__change--${s.trend}`}>{s.change}</span>
            </div>
          </article>
        ))}
      </section>

      <section className="panel deployments-panel">
        <div className="panel__head">
          <div>
            <h2>Projects</h2>
            <p className="deployments-panel__lede">
              Add projects to this profile, then start or stop them in the integrated terminal. Create does not run the
              command until you choose Start.
            </p>
          </div>
          <div className="deployments-panel__head-actions">
            <button type="button" className="btn btn--ghost" onClick={showTerminal}>
              Show terminal
            </button>
            <button type="button" className="btn btn--primary" onClick={openAddModal}>
              Add project
            </button>
            <button type="button" className="btn btn--secondary" onClick={addGroup}>
              New group
            </button>
          </div>
        </div>

        <div className="deployments-panel__view-tabs" role="tablist" aria-label="Deployments views">
          <button
            type="button"
            role="tab"
            className="deployments-panel__view-tab"
            aria-selected={deployView === 'projects'}
            onClick={() => setDeployView('projects')}
          >
            Projects
          </button>
          <button
            type="button"
            role="tab"
            className="deployments-panel__view-tab"
            aria-selected={deployView === 'activity'}
            onClick={() => setDeployView('activity')}
          >
            Activity log
          </button>
        </div>

        {deployView === 'activity' ? (
          <div className="deployments-panel__activity">
            {deployLog.length === 0 ? (
              <p className="deployments-panel__activity-empty">
                Start, stop, or restart a project to see entries here. Use <strong>Open terminal</strong> to jump to a
                tab that is still running.
              </p>
            ) : (
              deployLog.map((entry) => {
                const tabAlive = entry.tabId && tabs.some((t) => t.id === entry.tabId)
                return (
                  <div key={entry.id} className="deployments-panel__activity-row">
                    <span className="deployments-panel__activity-time">
                      {new Date(entry.at).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </span>
                    <span className="deployments-panel__activity-msg">{entry.message}</span>
                    {tabAlive ? (
                      <button
                        type="button"
                        className="btn btn--secondary btn--xs"
                        onClick={() => focusTerminalTab(entry.tabId!)}
                      >
                        Open terminal
                      </button>
                    ) : null}
                  </div>
                )
              })
            )}
          </div>
        ) : null}

        {deployView === 'projects' ? (
          <>
        <div className="deployments-panel__filters">
          <label className="deployments-panel__field">
            <span>Active profile</span>
            <select
              className="deployments-panel__select"
              value={effectiveGroupId ?? activeGroup.id}
              onChange={(e) => setActiveGroupId(e.target.value)}
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label className="deployments-panel__field deployments-panel__field--grow">
            <span>Profile name</span>
            <input
              type="text"
              className="deployments-panel__text-input"
              value={activeGroup.name}
              onChange={(e) => patchGroup(activeGroup.id, (g) => ({ ...g, name: e.target.value }))}
            />
          </label>
          <button
            type="button"
            className="btn btn--ghost btn--xs deployments-panel__filters-action"
            onClick={() => setDeleteProfileId(activeGroup.id)}
          >
            Delete profile
          </button>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col" className="deployments-panel__th-drag">
                  <span className="visually-hidden">Reorder</span>
                </th>
                <th scope="col">Name</th>
                <th scope="col">Environment</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {activeGroup.slots.length === 0 ? (
                <tr>
                  <td colSpan={5} className="data-table__muted">
                    No projects yet. Use <strong>Add project</strong> to save one in this profile.
                  </td>
                </tr>
              ) : (
                activeGroup.slots.map((slot, index) => {
                  const running = Boolean(runningMap[slot.id])
                  const runnable = slotRunnable(slot)
                  const siteHref = resolveSiteHref(slot.siteUrl ?? '')
                  return (
                    <tr
                      key={slot.id}
                      className={dragSlotIndex === index ? 'deployments-panel__row--dragging' : undefined}
                      onDragOver={(e) => {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        const raw = e.dataTransfer.getData(SLOT_DRAG_MIME)
                        const from = parseInt(raw, 10)
                        if (Number.isNaN(from)) return
                        moveSlot(activeGroup.id, from, index)
                        setDragSlotIndex(null)
                      }}
                    >
                      <td className="deployments-panel__drag-cell">
                        <span
                          className="deployments-panel__drag-handle"
                          draggable
                          role="button"
                          tabIndex={0}
                          aria-label={`Drag to reorder ${slot.label.trim() || 'project'}`}
                          title="Drag to reorder"
                          onDragStart={(e) => {
                            e.dataTransfer.setData(SLOT_DRAG_MIME, String(index))
                            e.dataTransfer.effectAllowed = 'move'
                            setDragSlotIndex(index)
                          }}
                          onDragEnd={() => setDragSlotIndex(null)}
                        >
                          ⋮⋮
                        </span>
                      </td>
                      <td>
                        <span className="data-table__name">{slot.label.trim() || '—'}</span>
                        <div className="deployments-panel__row-sub data-table__muted">{slot.cwd || '—'}</div>
                        <div className="deployments-panel__row-sub data-table__muted deployments-panel__row-cmd">
                          {slot.command || '—'}
                        </div>
                      </td>
                      <td>
                        <span className={envPillClass(slot.environment)}>{slot.environment}</span>
                      </td>
                      <td>
                        {running ? (
                          <span className="status status--healthy">Running</span>
                        ) : runnable ? (
                          <span className="status status--building">Stopped</span>
                        ) : (
                          <span className="status status--failed">Incomplete</span>
                        )}
                      </td>
                      <td>
                        <div className="deployments-panel__row-actions">
                          {siteHref && running ? (
                            <button
                              type="button"
                              className="btn btn--secondary btn--xs"
                              onClick={() => openSiteInNewTab(slot.siteUrl ?? '')}
                            >
                              Open site
                            </button>
                          ) : null}
                          {running ? (
                            <>
                              <button
                                type="button"
                                className="btn btn--ghost btn--xs"
                                onClick={() => {
                                  const tid = runningMap[slot.id]
                                  if (tid) focusTerminalTab(tid)
                                }}
                              >
                                Terminal
                              </button>
                              <button
                                type="button"
                                className="btn btn--ghost btn--xs"
                                onClick={() => stopProject(slot)}
                              >
                                Stop
                              </button>
                              <button
                                type="button"
                                className="btn btn--secondary btn--xs"
                                onClick={() => restartProject(slot)}
                              >
                                Restart
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn btn--primary btn--xs"
                              onClick={() => startProject(slot)}
                              disabled={!runnable}
                              title={!runnable ? 'Set name, path, and command via Edit' : undefined}
                            >
                              Start
                            </button>
                          )}
                          {!running ? (
                            <>
                              <button
                                type="button"
                                className="btn btn--ghost btn--xs"
                                onClick={() => {
                                  populateFormFromSlot(slot)
                                  setEditSlotId(slot.id)
                                }}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="btn btn--danger btn--xs"
                                onClick={() => setDeleteSlotId(slot.id)}
                              >
                                Delete
                              </button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="deployments-panel__foot">
          <p className="deployments-panel__hint">
            <strong>Stop</strong> closes the terminal tab for that project (ends the dev process); stop first to{' '}
            <strong>Edit</strong> or <strong>Delete</strong>. <strong>Hide</strong> on the terminal panel only tucks it
            away — the shell keeps running until you close the tab or stop the project. Refreshing the page disconnects
            the shell (browser limitation). Optional port: digits only →{' '}
            <code className="host-editor__inline-code">PORT=&lt;n&gt;</code> prefix on Unix. With a site URL set,{' '}
            <strong>Open site</strong> appears while the project is running;
            drag <strong>⋮⋮</strong> to reorder projects (saved with this profile). Start runs{' '}
            <code className="host-editor__inline-code">cd</code> into the project path first, then your command.
          </p>
        </div>
          </>
        ) : null}
      </section>

      {addModalOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setAddModalOpen(false)}
          onKeyDown={(e) => e.key === 'Escape' && setAddModalOpen(false)}
        >
          <div
            className="modal deployments-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="deploy-add-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal__head">
              <h2 id="deploy-add-title">Add project</h2>
              <button type="button" className="modal__close" aria-label="Close" onClick={() => setAddModalOpen(false)}>
                ×
              </button>
            </div>
            <div className="modal__body deployments-modal__body">{projectFormFields}</div>
            <div className="modal__foot modal__foot--split">
              <button type="button" className="btn btn--ghost" onClick={() => setAddModalOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={createProject}
                disabled={!formName.trim() || !formPath.trim() || !formCommand.trim()}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {editSlotId && activeGroup.slots.some((s) => s.id === editSlotId) ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => {
            setEditSlotId(null)
            resetForm()
          }}
        >
          <div
            className="modal deployments-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="deploy-edit-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal__head">
              <h2 id="deploy-edit-title">Edit project</h2>
              <button
                type="button"
                className="modal__close"
                aria-label="Close"
                onClick={() => {
                  setEditSlotId(null)
                  resetForm()
                }}
              >
                ×
              </button>
            </div>
            <div className="modal__body deployments-modal__body">{projectFormFields}</div>
            <div className="modal__foot modal__foot--split">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setEditSlotId(null)
                  resetForm()
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={saveEdit}
                disabled={!formName.trim() || !formPath.trim() || !formCommand.trim()}
              >
                Save
                {runningMap[editSlotId] ? ' & restart' : ''}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmDangerModal
        open={deleteSlotId !== null}
        title="Delete project?"
        titleId="deploy-del-title"
        message={
          <>
            Remove{' '}
            <strong>
              {activeGroup.slots.find((s) => s.id === deleteSlotId)?.label.trim() || 'this project'}
            </strong>{' '}
            from this profile?
            {deleteSlotId && runningMap[deleteSlotId] ? ' The running terminal tab will be closed.' : ''}
          </>
        }
        confirmLabel="Delete"
        onCancel={() => setDeleteSlotId(null)}
        onConfirm={confirmDelete}
      />

      <ConfirmDangerModal
        open={deleteProfileId !== null}
        title="Delete profile?"
        titleId="deploy-del-profile-title"
        message={
          <>
            Delete profile <strong>{pendingProfileDelete?.name.trim() || 'this profile'}</strong>
            {pendingProfileDelete
              ? ` and all ${pendingProfileDelete.slots.length} project${pendingProfileDelete.slots.length === 1 ? '' : 's'} saved in it`
              : ''}
            ? Running projects in this profile will be stopped.
          </>
        }
        confirmLabel="Delete profile"
        onCancel={() => setDeleteProfileId(null)}
        onConfirm={confirmRemoveProfile}
      />
    </>
  )
}

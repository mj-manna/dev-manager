import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildCommand, slotRunnable } from '../deployments/deploymentCommands'
import {
  PACKAGE_JSON_SELECT_INSTALL_VALUE,
  formatPackageInstallCommand,
  formatPackageScriptCommand,
  packageManagerDetectionDescription,
} from '../deployments/packageScripts'
import {
  PROJECT_ENVIRONMENTS,
  createEmptySlot,
  type ProjectEnvironment,
  type TerminalGroup,
  type TerminalGroupSlot,
} from '../deployments/terminalGroupsStorage'
import { useTerminal } from '../terminal/TerminalContext'
import { useWorkspace } from '../workspace/WorkspaceContext'
import { ConfirmDangerModal } from './ConfirmDangerModal'

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

function folderLabelFromPath(p: string): string {
  const t = p.trim().replace(/[/\\]+$/, '')
  const parts = t.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || 'Project'
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
    showTerminal,
    focusTerminalTab,
    addTerminalTab,
    removeTerminalTab,
    runInTerminal,
    tabs,
    deploymentSlotTabMap,
    linkDeploymentSlotToTab,
  } = useTerminal()

  const { setGroups, activeGroup } = useWorkspace()

  const runningMap = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [pid, tid] of Object.entries(deploymentSlotTabMap)) {
      if (tabs.some((t) => t.id === tid)) out[pid] = tid
    }
    return out
  }, [deploymentSlotTabMap, tabs])

  const [addModalOpen, setAddModalOpen] = useState(false)
  const [editSlotId, setEditSlotId] = useState<string | null>(null)
  const [deleteSlotId, setDeleteSlotId] = useState<string | null>(null)

  const [formName, setFormName] = useState('')
  const [formPath, setFormPath] = useState('')
  const [formCommand, setFormCommand] = useState('pnpm dev')
  const [formEnv, setFormEnv] = useState<ProjectEnvironment>('development')
  const [formPort, setFormPort] = useState('')
  const [formSiteUrl, setFormSiteUrl] = useState('')

  type PkgScriptsEntry =
    | { state: 'loading' }
    | { state: 'none' }
    | {
        state: 'ok'
        runner: string
        scriptNames: string[]
        runnerSource: string
        runnerSourceDetail?: string
      }
    | { state: 'err'; message: string }

  const [pkgScriptsByCwd, setPkgScriptsByCwd] = useState<Record<string, PkgScriptsEntry>>({})
  const pkgScriptsByCwdRef = useRef(pkgScriptsByCwd)
  pkgScriptsByCwdRef.current = pkgScriptsByCwd
  /** Bumped on effect cleanup so aborted fetches never skip a retry or clobber a newer request. */
  const pkgFetchGenRef = useRef<Record<string, number>>({})
  const [scriptSelectBust, setScriptSelectBust] = useState<Record<string, number>>({})

  const [dragSlotIndex, setDragSlotIndex] = useState<number | null>(null)

  const slotsCwdFingerprint = useMemo(() => {
    if (!activeGroup) return ''
    return [...new Set(activeGroup.slots.map((s) => s.cwd.trim()).filter(Boolean))].sort().join('\0')
  }, [activeGroup])

  useEffect(() => {
    if (!slotsCwdFingerprint) return
    /** Stable list from fingerprint — do not depend on `activeGroup` reference (it changes every groups update and was aborting every in-flight fetch). */
    const cwds = slotsCwdFingerprint.split('\0').filter(Boolean)
    const inflight: { cwd: string; ac: AbortController; tid: number }[] = []

    for (const cwd of cwds) {
      const ex = pkgScriptsByCwdRef.current[cwd]
      if (ex?.state === 'ok' || ex?.state === 'none' || ex?.state === 'err') continue

      const prevGen = pkgFetchGenRef.current[cwd] ?? 0
      const myGen = prevGen + 1
      pkgFetchGenRef.current[cwd] = myGen

      const ac = new AbortController()
      const tid = window.setTimeout(() => ac.abort(), 20_000)
      inflight.push({ cwd, ac, tid })

      setPkgScriptsByCwd((p) => (p[cwd]?.state === 'loading' ? p : { ...p, [cwd]: { state: 'loading' } }))

      void (async () => {
        const stale = () => pkgFetchGenRef.current[cwd] !== myGen
        try {
          const res = await fetch('/api/deployments/package-json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cwd }),
            signal: ac.signal,
          })
          if (stale()) return
          const data = (await res.json()) as {
            ok?: boolean
            error?: string
            hasPackageJson?: boolean
            scripts?: Record<string, string>
            runner?: string
            runnerSource?: string
            runnerSourceDetail?: string
          }
          if (ac.signal.aborted || stale()) return
          if (!data.ok) {
            if (stale()) return
            setPkgScriptsByCwd((p) => ({
              ...p,
              [cwd]: { state: 'err', message: data.error || 'Could not read package.json' },
            }))
            return
          }
          if (!data.hasPackageJson) {
            if (stale()) return
            setPkgScriptsByCwd((p) => ({ ...p, [cwd]: { state: 'none' } }))
            return
          }
          const names = Object.keys(data.scripts ?? {}).sort()
          if (stale()) return
          setPkgScriptsByCwd((p) => ({
            ...p,
            [cwd]: {
              state: 'ok',
              runner: data.runner || 'npm',
              scriptNames: names,
              runnerSource: data.runnerSource || 'npm_default',
              ...(typeof data.runnerSourceDetail === 'string' && data.runnerSourceDetail.trim()
                ? { runnerSourceDetail: data.runnerSourceDetail.trim() }
                : {}),
            },
          }))
        } catch {
          if (stale()) return
          if (ac.signal.aborted) {
            setPkgScriptsByCwd((p) => ({
              ...p,
              [cwd]: { state: 'err', message: 'Timed out reading package.json' },
            }))
            return
          }
          if (stale()) return
          setPkgScriptsByCwd((p) => ({
            ...p,
            [cwd]: { state: 'err', message: 'Request failed' },
          }))
        } finally {
          window.clearTimeout(tid)
        }
      })()
    }

    return () => {
      for (const { cwd, ac, tid } of inflight) {
        window.clearTimeout(tid)
        ac.abort()
        pkgFetchGenRef.current[cwd] = (pkgFetchGenRef.current[cwd] ?? 0) + 1
      }
    }
  }, [slotsCwdFingerprint])

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
      window.setTimeout(() => {
        const cmd = buildCommand(next)
        const tabId = addTerminalTab({
          label: next.label || 'Project',
          cwd: next.cwd,
          command: cmd,
          projectSlotId: next.id,
          jobCategory: 'run',
          jobDetail: cmd,
        })
        linkDeploymentSlotToTab(next.id, tabId)
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
    linkDeploymentSlotToTab,
  ])

  const startProject = useCallback(
    (slot: TerminalGroupSlot) => {
      if (!slotRunnable(slot) || runningMap[slot.id]) return
      const cmd = buildCommand(slot)
      const tabId = addTerminalTab({
        label: slot.label.trim() || 'Project',
        cwd: slot.cwd.trim(),
        command: cmd,
        projectSlotId: slot.id,
        jobCategory: 'run',
        jobDetail: cmd,
      })
      linkDeploymentSlotToTab(slot.id, tabId)
      showTerminal()
    },
    [runningMap, addTerminalTab, showTerminal, linkDeploymentSlotToTab],
  )

  const stopProject = useCallback(
    (slot: TerminalGroupSlot) => {
      const tid = runningMap[slot.id]
      if (!tid) return
      removeTerminalTab(tid)
    },
    [runningMap, removeTerminalTab],
  )

  const restartProject = useCallback(
    (slot: TerminalGroupSlot) => {
      const tid = runningMap[slot.id]
      if (tid) removeTerminalTab(tid)
      window.setTimeout(() => {
        if (!slotRunnable(slot)) return
        const cmd = buildCommand(slot)
        const tabId = addTerminalTab({
          label: slot.label.trim() || 'Project',
          cwd: slot.cwd.trim(),
          command: cmd,
          projectSlotId: slot.id,
          jobCategory: 'run',
          jobDetail: cmd,
        })
        linkDeploymentSlotToTab(slot.id, tabId)
        showTerminal()
      }, 200)
    },
    [runningMap, removeTerminalTab, addTerminalTab, showTerminal, linkDeploymentSlotToTab],
  )

  const confirmDelete = useCallback(() => {
    if (!activeGroup || !deleteSlotId) return
    const slot = activeGroup.slots.find((s) => s.id === deleteSlotId)
    if (slot && runningMap[slot.id]) stopProject(slot)
    patchGroup(activeGroup.id, (g) => ({
      ...g,
      slots: g.slots.filter((s) => s.id !== deleteSlotId),
    }))
    setDeleteSlotId(null)
  }, [activeGroup, deleteSlotId, runningMap, patchGroup, stopProject])

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
      <section className="panel deployments-panel">
        <div className="panel__head deployments-panel__head--toolbar">
          <div className="deployments-panel__head-actions">
            <button type="button" className="btn btn--primary" onClick={openAddModal}>
              Add project
            </button>
          </div>
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
                <th scope="col" className="deployments-panel__th-actions">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {activeGroup.slots.length === 0 ? (
                <tr>
                  <td colSpan={5} className="data-table__muted">
                    No projects in this workspace.
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
                      <td className="deployments-panel__actions-cell">
                        <div className="deployments-panel__actions-row">
                        {(() => {
                          const cwd = slot.cwd.trim()
                          if (!cwd) return null
                          const pkg = pkgScriptsByCwd[cwd]
                          return (
                            <>
                              {pkg?.state === 'loading' || pkg === undefined ? (
                                <div
                                  className="deployments-panel__script-strip deployments-panel__script-strip--loading deployments-panel__script-strip--inline"
                                  role="status"
                                  aria-live="polite"
                                  aria-label="Loading package.json"
                                >
                                  <span className="deployments-panel__script-spinner" aria-hidden />
                                  <span className="deployments-panel__script-strip-text">Loading…</span>
                                </div>
                              ) : null}
                              {pkg?.state === 'ok' ? (
                                (() => {
                                  const installCmd = formatPackageInstallCommand(pkg.runner)
                                  const detectDesc = packageManagerDetectionDescription(
                                    pkg.runnerSource,
                                    pkg.runnerSourceDetail,
                                  )
                                  const badgeTitle = `${pkg.runner} — ${detectDesc}`
                                  const selectTitle = `Choose a package.json script or ${installCmd}. ${detectDesc}`
                                  return (
                                    <div className="deployments-panel__script-strip deployments-panel__script-strip--ready deployments-panel__script-strip--inline">
                                      <span
                                        className="deployments-panel__runner-badge"
                                        title={badgeTitle}
                                      >
                                        {pkg.runner}
                                      </span>
                                      <select
                                        key={`${slot.id}-${scriptSelectBust[slot.id] ?? 0}`}
                                        className="deployments-panel__script-select"
                                        defaultValue=""
                                        title={selectTitle}
                                        aria-label={`Run script or install for ${slot.label.trim() || cwd}`}
                                        onChange={(e) => {
                                          const name = e.target.value
                                          if (!name) return
                                          const cmd =
                                            name === PACKAGE_JSON_SELECT_INSTALL_VALUE
                                              ? installCmd
                                              : formatPackageScriptCommand(pkg.runner, name)
                                          runInTerminal(cmd, {
                                            cwd,
                                            label: slot.label.trim() || folderLabelFromPath(cwd),
                                            projectSlotId: slot.id,
                                            jobCategory: 'task',
                                            jobDetail: cmd,
                                          })
                                          showTerminal()
                                          setScriptSelectBust((b) => ({
                                            ...b,
                                            [slot.id]: (b[slot.id] ?? 0) + 1,
                                          }))
                                        }}
                                      >
                                        <option value="">Run…</option>
                                        <optgroup label="Install">
                                          <option value={PACKAGE_JSON_SELECT_INSTALL_VALUE}>
                                            {installCmd}
                                          </option>
                                        </optgroup>
                                        {pkg.scriptNames.length > 0 ? (
                                          <optgroup label="Scripts">
                                            {pkg.scriptNames.map((s) => (
                                              <option key={s} value={s}>
                                                {s}
                                              </option>
                                            ))}
                                          </optgroup>
                                        ) : null}
                                      </select>
                                    </div>
                                  )
                                })()
                              ) : null}
                              {pkg?.state === 'err' ? (
                                <div
                                  className="deployments-panel__script-strip deployments-panel__script-strip--err deployments-panel__script-strip--inline"
                                  role="alert"
                                  title={pkg.message}
                                >
                                  <span className="deployments-panel__script-strip-err-msg">
                                    {pkg.message}
                                  </span>
                                </div>
                              ) : null}
                            </>
                          )
                        })()}
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
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

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
            from this workspace?
            {deleteSlotId && runningMap[deleteSlotId] ? ' The running terminal tab will be closed.' : ''}
          </>
        }
        confirmLabel="Delete"
        onCancel={() => setDeleteSlotId(null)}
        onConfirm={confirmDelete}
      />
    </>
  )
}

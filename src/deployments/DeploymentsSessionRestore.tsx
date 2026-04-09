import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { STORAGE_CHANGED_EVENT } from '../appData/storageRegistry'
import { useTerminal } from '../terminal/TerminalContext'
import { buildCommand, findSlotById, slotRunnable } from './deploymentCommands'
import { loadPersistedRunningSlotIds, savePersistedRunningSlotIds } from './deploymentsRunningStorage'
import { loadTerminalGroups, type TerminalGroup } from './terminalGroupsStorage'

const DM_RESTORE_MARK = '__dmDeploymentsRestoredForLoad'
const DM_TASK_RESTORE_MARK = '__dmDeploymentTasksRestoredForLoad'

function slotRowLabel(slot: { label: string; cwd: string }) {
  const L = slot.label.trim()
  if (L) return L
  const parts = slot.cwd.trim().replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || 'Project'
}

/**
 * Runs on every app load (any route). Recreates deployment terminal tabs after F5 and
 * keeps localStorage in sync with running slots. Strict Mode remount clears Provider state
 * but leaves window markers + localStorage — we restore again when tabs are empty.
 */
export function DeploymentsSessionRestore() {
  const {
    addTerminalTab,
    showTerminal,
    tabs,
    linkDeploymentSlotToTab,
    deploymentSlotTabMap,
    runInTerminal,
    terminalJobs,
  } = useTerminal()
  const [groups, setGroups] = useState<TerminalGroup[]>(() => loadTerminalGroups())
  const [persistReady, setPersistReady] = useState(() => typeof globalThis.window === 'undefined')

  useEffect(() => {
    const sync = () => setGroups(loadTerminalGroups())
    window.addEventListener(STORAGE_CHANGED_EVENT, sync)
    return () => window.removeEventListener(STORAGE_CHANGED_EVENT, sync)
  }, [])

  useLayoutEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- gate localStorage persist until slot restore finishes */
    const w = window as unknown as Record<string, string | undefined>
    const loadId = window.__dmPageLoadId
    const persistedIds = loadPersistedRunningSlotIds()
    const tabsHaveProject = tabs.some((t) => t.projectSlotId)
    const alreadyRestoredThisLoad = Boolean(loadId && w[DM_RESTORE_MARK] === loadId)
    const strictRemountNeedRestore =
      alreadyRestoredThisLoad && !tabsHaveProject && persistedIds.length > 0

    if (alreadyRestoredThisLoad && !strictRemountNeedRestore) {
      setPersistReady(true)
      return
    }

    if (persistedIds.length === 0) {
      if (loadId) w[DM_RESTORE_MARK] = loadId
      setPersistReady(true)
      return
    }

    let opened = false
    for (const slotId of persistedIds) {
      const slot = findSlotById(groups, slotId)
      if (!slot || !slotRunnable(slot)) continue
      const cmd = buildCommand(slot)
      const tabId = addTerminalTab({
        label: slot.label.trim() || 'Project',
        cwd: slot.cwd.trim(),
        command: cmd,
        projectSlotId: slot.id,
        jobCategory: 'run',
        jobDetail: cmd,
      })
      linkDeploymentSlotToTab(slotId, tabId)
      opened = true
    }
    if (opened) showTerminal()
    if (loadId) w[DM_RESTORE_MARK] = loadId
    setPersistReady(true)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [groups, tabs, addTerminalTab, showTerminal, linkDeploymentSlotToTab])

  /**
   * Re-open Run… script tasks after F5 (jobs stay "running" in storage when `projectSlotId` is set).
   * Runs in layout so it happens before TerminalProvider's orphan job cleanup effect.
   */
  useLayoutEffect(() => {
    if (typeof window === 'undefined' || !persistReady) return
    const w = window as unknown as Record<string, string | undefined>
    const loadId = window.__dmPageLoadId
    const staleTask = terminalJobs.some(
      (j) =>
        j.status === 'running' &&
        j.category === 'task' &&
        Boolean(j.projectSlotId?.trim()) &&
        !tabs.some((t) => t.id === j.tabId),
    )
    if (loadId && w[DM_TASK_RESTORE_MARK] === loadId && !staleTask) return

    let opened = false
    for (const job of terminalJobs) {
      if (job.status !== 'running' || job.category !== 'task' || !job.projectSlotId?.trim()) continue
      if (tabs.some((t) => t.id === job.tabId)) continue
      const slot = findSlotById(groups, job.projectSlotId.trim())
      if (!slot || !slot.cwd.trim()) continue
      const cmd = job.detail?.trim()
      if (!cmd) continue
      runInTerminal(cmd, {
        cwd: slot.cwd.trim(),
        label: slotRowLabel(slot),
        projectSlotId: job.projectSlotId,
        jobCategory: 'task',
        jobDetail: cmd,
      })
      opened = true
    }
    if (opened) showTerminal()
    if (loadId) w[DM_TASK_RESTORE_MARK] = loadId
  }, [persistReady, tabs, terminalJobs, groups, runInTerminal, showTerminal])

  const runningSlotIds = useMemo(() => {
    const ids = Object.keys(deploymentSlotTabMap).filter((sid) =>
      tabs.some((t) => t.id === deploymentSlotTabMap[sid]),
    )
    return [...new Set(ids)].sort()
  }, [deploymentSlotTabMap, tabs])

  useEffect(() => {
    if (!persistReady) return
    savePersistedRunningSlotIds(runningSlotIds)
  }, [persistReady, runningSlotIds])

  return null
}

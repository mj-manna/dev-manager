import { loadConnections, saveConnections } from '../database/connectionsStorage'
import { WORKSPACE_DELETED_EVENT, type WorkspaceDeletedDetail } from '../appData/workspaceEvents'
import { loadPersistedRunningSlotIds, savePersistedRunningSlotIds } from '../deployments/deploymentsRunningStorage'
import { createEmptyGroup, type TerminalGroup } from '../deployments/terminalGroupsStorage'
import type { Dispatch, SetStateAction } from 'react'

/**
 * Removes a workspace and all data that references it: DB connections scoped to that
 * workspace, persisted “running deployment” slot ids, and dispatches an event so open
 * terminal tabs for those slots are closed.
 */
export function deleteWorkspaceCascade(args: {
  workspaceId: string
  groups: TerminalGroup[]
  setGroups: Dispatch<SetStateAction<TerminalGroup[]>>
}): void {
  const { workspaceId, groups, setGroups } = args
  const g = groups.find((x) => x.id === workspaceId)
  const slotIds = g ? g.slots.map((s) => s.id) : []

  if (slotIds.length > 0) {
    const detail: WorkspaceDeletedDetail = { slotIds }
    window.dispatchEvent(new CustomEvent(WORKSPACE_DELETED_EVENT, { detail }))
  }

  const nextConnections = loadConnections().filter((c) => c.projectGroupId !== workspaceId)
  saveConnections(nextConnections)

  const running = loadPersistedRunningSlotIds()
  const slotSet = new Set(slotIds)
  savePersistedRunningSlotIds(running.filter((id) => !slotSet.has(id)))

  setGroups((gs) => {
    const next = gs.filter((x) => x.id !== workspaceId)
    return next.length === 0 ? [createEmptyGroup('Default')] : next
  })
}

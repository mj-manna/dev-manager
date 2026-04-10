import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { STORAGE_CHANGED_EVENT } from '../appData/storageRegistry'
import {
  loadActiveGroupId,
  loadTerminalGroups,
  saveActiveGroupId,
  saveTerminalGroups,
  type TerminalGroup,
} from '../deployments/terminalGroupsStorage'

export type WorkspaceContextValue = {
  groups: TerminalGroup[]
  setGroups: Dispatch<SetStateAction<TerminalGroup[]>>
  /** Persisted workspace (deployment group) id, or null if none. */
  activeGroupId: string | null
  setActiveGroupId: (id: string | null) => void
  /** Resolved group id (falls back to first group). */
  effectiveGroupId: string | null
  activeGroup: TerminalGroup | null
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

function resolveInitialGroupId(groups: TerminalGroup[]): string | null {
  if (groups.length === 0) return null
  const savedG = loadActiveGroupId()
  if (savedG && groups.some((x) => x.id === savedG)) return savedG
  return groups[0]!.id
}

function getInitialWorkspaceState(): { groups: TerminalGroup[]; groupId: string | null } {
  const groups = loadTerminalGroups()
  return { groups, groupId: resolveInitialGroupId(groups) }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(() => getInitialWorkspaceState(), [])
  const [groups, setGroups] = useState<TerminalGroup[]>(initial.groups)
  const [activeGroupId, setActiveGroupIdState] = useState<string | null>(initial.groupId)

  const groupsRef = useRef(groups)
  groupsRef.current = groups

  const syncFromStorage = useCallback(() => {
    const next = loadTerminalGroups()
    setGroups(next)
    setActiveGroupIdState(resolveInitialGroupId(next))
  }, [])

  useEffect(() => {
    window.addEventListener(STORAGE_CHANGED_EVENT, syncFromStorage)
    return () => window.removeEventListener(STORAGE_CHANGED_EVENT, syncFromStorage)
  }, [syncFromStorage])

  useEffect(() => {
    saveTerminalGroups(groups)
  }, [groups])

  const effectiveGroupId = useMemo(() => {
    if (groups.length === 0) return null
    if (activeGroupId && groups.some((g) => g.id === activeGroupId)) return activeGroupId
    return groups[0]!.id
  }, [groups, activeGroupId])

  useEffect(() => {
    if (groups.length === 0) {
      if (activeGroupId !== null) setActiveGroupIdState(null)
      return
    }
    if (!activeGroupId || !groups.some((g) => g.id === activeGroupId)) {
      setActiveGroupIdState(groups[0]!.id)
    }
  }, [groups, activeGroupId])

  const activeGroup = useMemo(
    () => (effectiveGroupId ? groups.find((g) => g.id === effectiveGroupId) ?? null : null),
    [groups, effectiveGroupId],
  )

  useEffect(() => {
    if (effectiveGroupId) saveActiveGroupId(effectiveGroupId)
    else saveActiveGroupId(null)
  }, [effectiveGroupId])

  const setActiveGroupId = useCallback((id: string | null) => {
    setActiveGroupIdState(id)
  }, [])

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      groups,
      setGroups,
      activeGroupId,
      setActiveGroupId,
      effectiveGroupId,
      activeGroup,
    }),
    [groups, activeGroupId, setActiveGroupId, effectiveGroupId, activeGroup],
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceContextValue {
  const v = useContext(WorkspaceContext)
  if (!v) throw new Error('useWorkspace must be used within WorkspaceProvider')
  return v
}

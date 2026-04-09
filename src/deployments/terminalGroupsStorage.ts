const STORAGE_KEY = 'dev-manager-terminal-groups-v2'
const LEGACY_STORAGE_KEY = 'dev-manager-terminal-groups-v1'
const ACTIVE_GROUP_KEY = 'dev-manager-terminal-groups-active-v1'

export const PROJECT_ENVIRONMENTS = ['production', 'staging', 'preview', 'development', 'local'] as const
export type ProjectEnvironment = (typeof PROJECT_ENVIRONMENTS)[number]

export function isProjectEnvironment(v: string): v is ProjectEnvironment {
  return (PROJECT_ENVIRONMENTS as readonly string[]).includes(v)
}

export type TerminalGroupSlot = {
  id: string
  /** Project display name */
  label: string
  cwd: string
  command: string
  portNote?: string
  /** Optional URL or host to open in browser (e.g. https://app.test or app.local:5173). */
  siteUrl?: string
  environment: ProjectEnvironment
}

export type TerminalGroup = {
  id: string
  name: string
  slots: TerminalGroupSlot[]
}

function newId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `g-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function createEmptySlot(): TerminalGroupSlot {
  return {
    id: newId(),
    label: '',
    cwd: '',
    command: 'pnpm dev',
    portNote: '',
    siteUrl: '',
    environment: 'development',
  }
}

export function createEmptyGroup(name = 'New group'): TerminalGroup {
  return {
    id: newId(),
    name,
    slots: [],
  }
}

function parseSlot(so: Record<string, unknown>): TerminalGroupSlot {
  const envRaw = so.environment
  const environment: ProjectEnvironment =
    typeof envRaw === 'string' && isProjectEnvironment(envRaw) ? envRaw : 'development'
  return {
    id: typeof so.id === 'string' ? so.id : newId(),
    label: typeof so.label === 'string' ? so.label : '',
    cwd: typeof so.cwd === 'string' ? so.cwd : '',
    command: typeof so.command === 'string' ? so.command : 'pnpm dev',
    portNote: typeof so.portNote === 'string' ? so.portNote : '',
    siteUrl: typeof so.siteUrl === 'string' ? so.siteUrl : '',
    environment,
  }
}

export function loadTerminalGroups(): TerminalGroup[] {
  const tryParse = (raw: string | null): TerminalGroup[] | null => {
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed) || parsed.length === 0) return null
      const groups: TerminalGroup[] = []
      for (const g of parsed) {
        if (!g || typeof g !== 'object') continue
        const o = g as Record<string, unknown>
        const name = typeof o.name === 'string' ? o.name : 'Group'
        const id = typeof o.id === 'string' ? o.id : newId()
        const slotsRaw = o.slots
        const slots: TerminalGroupSlot[] = []
        if (Array.isArray(slotsRaw)) {
          for (const s of slotsRaw) {
            if (!s || typeof s !== 'object') continue
            slots.push(parseSlot(s as Record<string, unknown>))
          }
        }
        groups.push({ id, name, slots })
      }
      return groups.length > 0 ? groups : null
    } catch {
      return null
    }
  }

  const fromV2 = tryParse(
    typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null,
  )
  if (fromV2) return fromV2

  const fromLegacy = tryParse(
    typeof localStorage !== 'undefined' ? localStorage.getItem(LEGACY_STORAGE_KEY) : null,
  )
  if (fromLegacy) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(fromLegacy))
    } catch {
      /* ignore */
    }
    return fromLegacy
  }

  return [createEmptyGroup('Default')]
}

export function saveTerminalGroups(groups: TerminalGroup[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(groups))
  } catch {
    /* ignore */
  }
}

export function loadActiveGroupId(): string | null {
  try {
    const v = localStorage.getItem(ACTIVE_GROUP_KEY)
    return v && v.trim() ? v : null
  } catch {
    return null
  }
}

export function saveActiveGroupId(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_GROUP_KEY, id)
    else localStorage.removeItem(ACTIVE_GROUP_KEY)
  } catch {
    /* ignore */
  }
}

import { notifyAppStorageChanged } from '../appData/storageRegistry'
import {
  idbClearConnections,
  idbGetAllConnectionRecords,
  idbPutAllConnectionRecords,
  openAppDb,
} from '../appData/appIndexedDb'

const LEGACY_LOCAL_KEY = 'dev-manager-db-connections-v1'

/** Supported today: redis, mysql, postgresql. Future document stores (e.g. MongoDB): collection + document browser. */
export type ConnectionKind = 'redis' | 'mysql' | 'postgresql'

export type DbConnection = {
  id: string
  name: string
  kind: ConnectionKind
  host: string
  port: number
  /** MySQL / PostgreSQL */
  username?: string
  database?: string
  /** Optional; stored only in this browser */
  password?: string
  /** When set, connection belongs to this deployment workspace (group). */
  projectGroupId?: string
  /** Optional link to a deployment project row (legacy / detail). */
  projectSlotId?: string
}

let memoryConnections: DbConnection[] = []
let hydrated = false
let hydratePromise: Promise<void> | null = null

function readLegacyLocalStorage(): DbConnection[] {
  try {
    const raw = localStorage.getItem(LEGACY_LOCAL_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidConnection)
  } catch {
    return []
  }
}

function stripLegacyLocalKey() {
  try {
    localStorage.removeItem(LEGACY_LOCAL_KEY)
  } catch {
    /* ignore */
  }
}

export async function hydrateConnectionsStorage(): Promise<void> {
  if (hydrated) return
  if (!hydratePromise) {
    hydratePromise = (async () => {
      await openAppDb()
      let list = await idbGetAllConnectionRecords<DbConnection>()
      if (list.length === 0) {
        const legacy = readLegacyLocalStorage()
        if (legacy.length > 0) {
          await idbPutAllConnectionRecords(legacy)
          stripLegacyLocalKey()
          list = legacy
        }
      } else {
        stripLegacyLocalKey()
      }
      memoryConnections = list.filter(isValidConnection)
      hydrated = true
      notifyAppStorageChanged()
    })()
  }
  await hydratePromise
}

/** In-memory snapshot; call after `hydrateConnectionsStorage()` (done in main). */
export function loadConnections(): DbConnection[] {
  return [...memoryConnections]
}

export function replaceConnectionsMemory(list: DbConnection[]): void {
  memoryConnections = [...list]
}

export function parseConnectionsFromExport(raw: string): DbConnection[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidConnection)
  } catch {
    return []
  }
}

function isValidConnection(x: unknown): x is DbConnection {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  if (
    typeof o.id !== 'string' ||
    typeof o.name !== 'string' ||
    (o.kind !== 'redis' && o.kind !== 'mysql' && o.kind !== 'postgresql') ||
    typeof o.host !== 'string' ||
    typeof o.port !== 'number' ||
    !Number.isFinite(o.port)
  ) {
    return false
  }
  if (o.projectGroupId !== undefined && typeof o.projectGroupId !== 'string') return false
  if (o.projectSlotId !== undefined && typeof o.projectSlotId !== 'string') return false
  return true
}

export function getConnectionById(id: string): DbConnection | undefined {
  return memoryConnections.find((c) => c.id === id)
}

export async function persistConnectionsToIndexedDb(list: DbConnection[]): Promise<void> {
  memoryConnections = [...list]
  await idbPutAllConnectionRecords(memoryConnections)
  notifyAppStorageChanged()
}

export function saveConnections(list: DbConnection[]): void {
  memoryConnections = [...list]
  void idbPutAllConnectionRecords(memoryConnections)
    .then(() => {
      notifyAppStorageChanged()
    })
    .catch(() => {
      notifyAppStorageChanged()
    })
}

export async function clearConnectionsStorage(): Promise<void> {
  memoryConnections = []
  await idbClearConnections()
  stripLegacyLocalKey()
  notifyAppStorageChanged()
}

export function defaultPort(kind: ConnectionKind): number {
  if (kind === 'redis') return 6379
  if (kind === 'mysql') return 3306
  return 5432
}

export function newConnectionId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

export function kindLabel(kind: ConnectionKind): string {
  if (kind === 'redis') return 'Redis'
  if (kind === 'mysql') return 'MySQL'
  return 'PostgreSQL'
}

export function redisCliCommand(c: DbConnection): string {
  const parts = ['redis-cli', '-h', quoteShell(c.host), '-p', String(c.port)]
  if (c.password?.trim()) {
    parts.push('-a', quoteShell(c.password.trim()))
  }
  return parts.join(' ')
}

export function mysqlCliCommand(c: DbConnection): string {
  const u = c.username?.trim() || 'root'
  const parts = ['mysql', '-h', quoteShell(c.host), '-P', String(c.port), '-u', quoteShell(u)]
  if (c.password?.trim()) {
    parts.push('-p' + c.password.trim())
  } else {
    parts.push('-p')
  }
  if (c.database?.trim()) {
    parts.push(quoteShell(c.database.trim()))
  }
  return parts.join(' ')
}

export function psqlCommand(c: DbConnection): string {
  const u = c.username?.trim() || 'postgres'
  const db = c.database?.trim()
  const parts = ['psql', '-h', quoteShell(c.host), '-p', String(c.port), '-U', quoteShell(u)]
  if (c.password?.trim()) {
    return `PGPASSWORD=${shellSingleQuote(c.password.trim())} ${parts.join(' ')}${db ? ' ' + quoteShell(db) : ''}`
  }
  if (db) {
    parts.push(quoteShell(db))
  }
  return parts.join(' ')
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function quoteShell(s: string): string {
  if (/^[a-zA-Z0-9._@-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

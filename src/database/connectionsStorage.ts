const STORAGE_KEY = 'dev-manager-db-connections-v1'

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
  /** Optional; stored only in this browser’s localStorage */
  password?: string
}

export const defaultPort = (kind: ConnectionKind): number => {
  if (kind === 'redis') return 6379
  if (kind === 'mysql') return 3306
  return 5432
}

export function newConnectionId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

export function getConnectionById(id: string): DbConnection | undefined {
  return loadConnections().find((c) => c.id === id)
}

export function loadConnections(): DbConnection[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
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
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    (o.kind === 'redis' || o.kind === 'mysql' || o.kind === 'postgresql') &&
    typeof o.host === 'string' &&
    typeof o.port === 'number' &&
    Number.isFinite(o.port)
  )
}

export function saveConnections(list: DbConnection[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    /* quota / private mode */
  }
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

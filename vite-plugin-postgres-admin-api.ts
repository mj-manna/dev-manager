import { Client, escapeLiteral } from 'pg'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect } from 'vite'

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

type PgConnBody = {
  host?: string
  port?: number
  username?: string
  password?: string
  /** Admin session DB; default postgres */
  database?: string
}

type ParsedConn = {
  host: string
  port: number
  user: string
  password: string | undefined
  database: string
}

function parseAdminConn(body: PgConnBody): ParsedConn | null {
  const host = typeof body.host === 'string' ? body.host.trim() : ''
  const port = typeof body.port === 'number' && Number.isFinite(body.port) ? body.port : 0
  if (!host || port < 1 || port > 65535) return null
  const user =
    typeof body.username === 'string' && body.username.trim() ? body.username.trim() : 'postgres'
  const database =
    typeof body.database === 'string' && body.database.trim() ? body.database.trim() : 'postgres'
  const password =
    typeof body.password === 'string' && body.password.length ? body.password : undefined
  return { host, port, user, password, database }
}

async function withPgClient<T>(c: ParsedConn, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database,
    connectionTimeoutMillis: 15000,
  })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end().catch(() => {})
  }
}

function pgErr(e: unknown): string {
  const x = e as { message?: string }
  return x.message || 'PostgreSQL error'
}

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/

function assertIdent(name: unknown, label: string): string {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new Error(`Invalid ${label} (use letters, numbers, underscore; max 63 chars)`)
  }
  return name
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** PASSWORD must be a SQL literal — not `$1` (unsupported in these statements). */
function passwordLiteral(pwd: string): string {
  return escapeLiteral(pwd)
}

async function handleOverview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: PgConnBody
  try {
    body = JSON.parse(await readBody(req)) as PgConnBody
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' })
    return
  }
  const conn = parseAdminConn(body)
  if (!conn) {
    sendJson(res, 400, { ok: false, error: 'host and valid port required' })
    return
  }
  try {
    const payload = await withPgClient(conn, async (c) => {
      const [dbs, roles] = await Promise.all([
        c.query<{ name: string; owner: string | null }>(
          `SELECT d.datname AS name, pg_catalog.pg_get_userbyid(d.datdba)::text AS owner
           FROM pg_catalog.pg_database d
           WHERE d.datistemplate = false
           ORDER BY d.datname`,
        ),
        c.query<{ name: string; can_login: boolean; is_super: boolean }>(
          `SELECT rolname AS name, rolcanlogin AS can_login, rolsuper AS is_super
           FROM pg_catalog.pg_roles
           WHERE rolname !~ '^pg_'
           ORDER BY rolname`,
        ),
      ])
      return {
        databases: dbs.rows.map((r) => ({ name: r.name, owner: r.owner ?? '' })),
        roles: roles.rows.map((r) => ({
          name: r.name,
          canLogin: r.can_login,
          isSuper: r.is_super,
        })),
      }
    })
    sendJson(res, 200, { ok: true, ...payload })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: pgErr(e) })
  }
}

async function handleCreateDatabase(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: PgConnBody & { newDatabase?: string }
  try {
    body = JSON.parse(await readBody(req)) as PgConnBody & { newDatabase?: string }
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' })
    return
  }
  const conn = parseAdminConn(body)
  if (!conn) {
    sendJson(res, 400, { ok: false, error: 'host and valid port required' })
    return
  }
  let dbName: string
  try {
    dbName = assertIdent(body.newDatabase, 'database name')
  } catch (err) {
    sendJson(res, 400, { ok: false, error: pgErr(err) })
    return
  }
  try {
    await withPgClient(conn, async (c) => {
      await c.query(`CREATE DATABASE ${quoteIdent(dbName)}`)
    })
    sendJson(res, 200, { ok: true })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: pgErr(e) })
  }
}

async function handleCreateRole(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: PgConnBody & { newRole?: string; newPassword?: string; login?: boolean }
  try {
    body = JSON.parse(await readBody(req)) as PgConnBody & {
      newRole?: string
      newPassword?: string
      login?: boolean
    }
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' })
    return
  }
  const conn = parseAdminConn(body)
  if (!conn) {
    sendJson(res, 400, { ok: false, error: 'host and valid port required' })
    return
  }
  let roleName: string
  try {
    roleName = assertIdent(body.newRole, 'role name')
  } catch (err) {
    sendJson(res, 400, { ok: false, error: pgErr(err) })
    return
  }
  const pwd = typeof body.newPassword === 'string' ? body.newPassword : ''
  const login = body.login !== false
  if (login && pwd.length === 0) {
    sendJson(res, 400, { ok: false, error: 'Password required for login roles' })
    return
  }
  try {
    await withPgClient(conn, async (c) => {
      const qn = quoteIdent(roleName)
      if (login) {
        await c.query({
          text: `CREATE ROLE ${qn} WITH LOGIN PASSWORD ${passwordLiteral(pwd)}`,
        })
      } else {
        await c.query(`CREATE ROLE ${qn}`)
      }
    })
    sendJson(res, 200, { ok: true })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: pgErr(e) })
  }
}

async function handleAlterPassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: PgConnBody & { roleName?: string; newPassword?: string }
  try {
    body = JSON.parse(await readBody(req)) as PgConnBody & { roleName?: string; newPassword?: string }
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' })
    return
  }
  const conn = parseAdminConn(body)
  if (!conn) {
    sendJson(res, 400, { ok: false, error: 'host and valid port required' })
    return
  }
  let roleName: string
  try {
    roleName = assertIdent(body.roleName, 'role name')
  } catch (err) {
    sendJson(res, 400, { ok: false, error: pgErr(err) })
    return
  }
  const pwd = typeof body.newPassword === 'string' ? body.newPassword : ''
  if (pwd.length === 0) {
    sendJson(res, 400, { ok: false, error: 'Password required' })
    return
  }
  try {
    await withPgClient(conn, async (c) => {
      await c.query({
        text: `ALTER ROLE ${quoteIdent(roleName)} WITH PASSWORD ${passwordLiteral(pwd)}`,
      })
    })
    sendJson(res, 200, { ok: true })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: pgErr(e) })
  }
}

async function handleGrantConnect(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: PgConnBody & { grantDatabase?: string; grantRole?: string }
  try {
    body = JSON.parse(await readBody(req)) as PgConnBody & { grantDatabase?: string; grantRole?: string }
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' })
    return
  }
  const conn = parseAdminConn(body)
  if (!conn) {
    sendJson(res, 400, { ok: false, error: 'host and valid port required' })
    return
  }
  let db: string
  let role: string
  try {
    db = assertIdent(body.grantDatabase, 'database')
    role = assertIdent(body.grantRole, 'role')
  } catch (err) {
    sendJson(res, 400, { ok: false, error: pgErr(err) })
    return
  }
  try {
    await withPgClient(conn, async (c) => {
      await c.query(`GRANT CONNECT ON DATABASE ${quoteIdent(db)} TO ${quoteIdent(role)}`)
    })
    sendJson(res, 200, { ok: true })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: pgErr(e) })
  }
}

function postgresAdminMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url?.split('?')[0] ?? ''
    const map: Record<string, () => void> = {
      '/api/db/postgres-admin/overview': () => void handleOverview(req, res),
      '/api/db/postgres-admin/create-database': () => void handleCreateDatabase(req, res),
      '/api/db/postgres-admin/create-role': () => void handleCreateRole(req, res),
      '/api/db/postgres-admin/alter-password': () => void handleAlterPassword(req, res),
      '/api/db/postgres-admin/grant-connect': () => void handleGrantConnect(req, res),
    }
    const run = map[url]
    if (run) {
      run()
      return
    }
    next()
  }
}

export function postgresAdminApiPlugin() {
  return {
    name: 'dev-manager-postgres-admin-api',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(postgresAdminMiddleware())
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(postgresAdminMiddleware())
    },
  }
}

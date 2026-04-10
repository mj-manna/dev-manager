import { escape } from 'mysql2'
import mysql from 'mysql2/promise'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect } from 'vite'
import type { RowDataPacket } from 'mysql2'

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

type MysqlConnBody = {
  host?: string
  port?: number
  username?: string
  password?: string
  database?: string
}

type ParsedConn = {
  host: string
  port: number
  user: string
  password: string | undefined
  database: string
}

function parseAdminConn(body: MysqlConnBody): ParsedConn | null {
  const host = typeof body.host === 'string' ? body.host.trim() : ''
  const port = typeof body.port === 'number' && Number.isFinite(body.port) ? body.port : 0
  if (!host || port < 1 || port > 65535) return null
  const user =
    typeof body.username === 'string' && body.username.trim() ? body.username.trim() : 'root'
  const database =
    typeof body.database === 'string' && body.database.trim() ? body.database.trim() : 'mysql'
  const password =
    typeof body.password === 'string' && body.password.length ? body.password : undefined
  return { host, port, user, password, database }
}

async function withMysql<T>(c: ParsedConn, fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const conn = await mysql.createConnection({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database,
    connectTimeout: 15000,
  })
  try {
    return await fn(conn)
  } finally {
    await conn.end().catch(() => {})
  }
}

function mysqlErr(e: unknown): string {
  const x = e as { message?: string; sqlMessage?: string }
  return (x.sqlMessage || x.message || '').trim() || 'MySQL error'
}

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/

function assertIdent(name: unknown, label: string): string {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new Error(`Invalid ${label} (letter or underscore, then alphanumeric/underscore; max 63 chars)`)
  }
  return name
}

/** MySQL account host pattern (e.g. %, localhost, 127.0.0.1). */
const HOST_PATTERN = /^[a-zA-Z0-9._:%-]+$/

function assertHostPattern(host: unknown, label: string): string {
  if (typeof host !== 'string' || !host.trim()) {
    throw new Error(`${label} is required`)
  }
  const h = host.trim()
  if (h.length > 255 || !HOST_PATTERN.test(h)) {
    throw new Error(`Invalid ${label}`)
  }
  return h
}

function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`'
}

function quoteUserHost(user: string, host: string): string {
  return `'${user.replace(/'/g, "''")}'@'${host.replace(/'/g, "''")}'`
}

async function handleOverview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: MysqlConnBody
  try {
    body = JSON.parse(await readBody(req)) as MysqlConnBody
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
    const payload = await withMysql(conn, async (c) => {
      const [dbRows] = await c.query<RowDataPacket[]>(
        `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA
         WHERE SCHEMA_NAME NOT IN ('information_schema','performance_schema','sys','mysql')
         ORDER BY SCHEMA_NAME`,
      )
      const [userRows] = await c.query<RowDataPacket[]>(
        `SELECT User AS userName, Host AS host FROM mysql.user
         WHERE User NOT IN ('mysql.infoschema', 'mysql.session', 'mysql.sys')
         ORDER BY User, Host`,
      )
      return {
        databases: dbRows.map((r) => {
          const row = r as Record<string, string>
          return { name: String(row.name ?? row.SCHEMA_NAME ?? '') }
        }),
        users: userRows.map((r) => {
          const row = r as Record<string, string>
          const u = row.userName ?? row.User ?? ''
          const h = row.host ?? row.Host ?? ''
          return { user: String(u), host: String(h) }
        }),
      }
    })
    sendJson(res, 200, { ok: true, ...payload })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: mysqlErr(e) })
  }
}

async function handleCreateDatabase(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: MysqlConnBody & { newDatabase?: string }
  try {
    body = JSON.parse(await readBody(req)) as MysqlConnBody & { newDatabase?: string }
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
    sendJson(res, 400, { ok: false, error: mysqlErr(err) })
    return
  }
  try {
    await withMysql(conn, async (c) => {
      await c.query(`CREATE DATABASE ${quoteIdent(dbName)}`)
    })
    sendJson(res, 200, { ok: true })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: mysqlErr(e) })
  }
}

async function handleCreateUser(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: MysqlConnBody & { newUser?: string; newHost?: string; newPassword?: string }
  try {
    body = JSON.parse(await readBody(req)) as MysqlConnBody & {
      newUser?: string
      newHost?: string
      newPassword?: string
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
  let userName: string
  let hostPat: string
  try {
    userName = assertIdent(body.newUser, 'user name')
    hostPat = assertHostPattern(
      typeof body.newHost === 'string' && body.newHost.trim() ? body.newHost : '%',
      'host',
    )
  } catch (err) {
    sendJson(res, 400, { ok: false, error: mysqlErr(err) })
    return
  }
  const pwd = typeof body.newPassword === 'string' ? body.newPassword : ''
  if (pwd.length === 0) {
    sendJson(res, 400, { ok: false, error: 'Password required' })
    return
  }
  try {
    await withMysql(conn, async (c) => {
      await c.query(`CREATE USER ${quoteUserHost(userName, hostPat)} IDENTIFIED BY ${escape(pwd)}`)
    })
    sendJson(res, 200, { ok: true })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: mysqlErr(e) })
  }
}

async function handleAlterPassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: MysqlConnBody & { accountUser?: string; accountHost?: string; newPassword?: string }
  try {
    body = JSON.parse(await readBody(req)) as MysqlConnBody & {
      accountUser?: string
      accountHost?: string
      newPassword?: string
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
  let userName: string
  let hostPat: string
  try {
    userName = assertIdent(body.accountUser, 'user name')
    hostPat = assertHostPattern(body.accountHost, 'host')
  } catch (err) {
    sendJson(res, 400, { ok: false, error: mysqlErr(err) })
    return
  }
  const pwd = typeof body.newPassword === 'string' ? body.newPassword : ''
  if (pwd.length === 0) {
    sendJson(res, 400, { ok: false, error: 'Password required' })
    return
  }
  try {
    await withMysql(conn, async (c) => {
      await c.query(
        `ALTER USER ${quoteUserHost(userName, hostPat)} IDENTIFIED BY ${escape(pwd)}`,
      )
    })
    sendJson(res, 200, { ok: true })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: mysqlErr(e) })
  }
}

async function handleGrantDatabase(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: MysqlConnBody & { grantDatabase?: string; grantUser?: string; grantHost?: string }
  try {
    body = JSON.parse(await readBody(req)) as MysqlConnBody & {
      grantDatabase?: string
      grantUser?: string
      grantHost?: string
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
  let db: string
  let userName: string
  let hostPat: string
  try {
    db = assertIdent(body.grantDatabase, 'database')
    userName = assertIdent(body.grantUser, 'user name')
    hostPat = assertHostPattern(body.grantHost, 'host')
  } catch (err) {
    sendJson(res, 400, { ok: false, error: mysqlErr(err) })
    return
  }
  try {
    await withMysql(conn, async (c) => {
      await c.query(
        `GRANT ALL PRIVILEGES ON ${quoteIdent(db)}.* TO ${quoteUserHost(userName, hostPat)}`,
      )
      await c.query('FLUSH PRIVILEGES')
    })
    sendJson(res, 200, { ok: true })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: mysqlErr(e) })
  }
}

function mysqlAdminMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url?.split('?')[0] ?? ''
    const map: Record<string, () => void> = {
      '/api/db/mysql-admin/overview': () => void handleOverview(req, res),
      '/api/db/mysql-admin/create-database': () => void handleCreateDatabase(req, res),
      '/api/db/mysql-admin/create-user': () => void handleCreateUser(req, res),
      '/api/db/mysql-admin/alter-password': () => void handleAlterPassword(req, res),
      '/api/db/mysql-admin/grant-database': () => void handleGrantDatabase(req, res),
    }
    const run = map[url]
    if (run) {
      run()
      return
    }
    next()
  }
}

export function mysqlAdminApiPlugin() {
  return {
    name: 'dev-manager-mysql-admin-api',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(mysqlAdminMiddleware())
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(mysqlAdminMiddleware())
    },
  }
}

import { Client } from 'pg'
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
  database?: string
}

type ParsedConn = {
  host: string
  port: number
  user: string
  password: string | undefined
  database: string
}

function parseConn(body: PgConnBody): ParsedConn | null {
  const host = typeof body.host === 'string' ? body.host.trim() : ''
  const port = typeof body.port === 'number' && Number.isFinite(body.port) ? body.port : 0
  if (!host || port < 1 || port > 65535) return null
  const user =
    typeof body.username === 'string' && body.username.trim() ? body.username.trim() : 'postgres'
  const database =
    typeof body.database === 'string' && body.database.trim() ? body.database.trim() : 'postgres'
  const password = typeof body.password === 'string' && body.password.length ? body.password : undefined
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

/** Unquoted SQL identifiers only (prevents injection into identifier positions). */
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/

function assertIdent(name: unknown, label: string): string {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new Error(`Invalid ${label}`)
  }
  return name
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

async function fetchTableType(
  c: Client,
  schema: string,
  table: string,
): Promise<string | undefined> {
  const r = await c.query<{ table_type: string }>(
    `SELECT table_type
     FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, table],
  )
  return r.rows[0]?.table_type
}

async function fetchPrimaryKeyColumns(c: Client, schema: string, table: string): Promise<string[]> {
  const r = await c.query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints AS tc
     JOIN information_schema.key_column_usage AS kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema = $1
       AND tc.table_name = $2
     ORDER BY kcu.ordinal_position`,
    [schema, table],
  )
  return r.rows.map((row) => row.column_name)
}

/** Parse user-edited text into a value suitable for node-pg parameters. */
function parseValueFromText(udt: string, text: string, nullable: boolean): unknown {
  const t = text.trim()
  if (t === '' && nullable) return null
  if (t === '' && !nullable) throw new Error('A value is required for this column')
  const lower = udt.toLowerCase()
  if (['int2', 'int4', 'int8'].includes(lower)) {
    const n = Number(t)
    if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error('Invalid integer')
    return n
  }
  if (['float4', 'float8', 'numeric'].includes(lower)) {
    const n = Number(t)
    if (!Number.isFinite(n)) throw new Error('Invalid number')
    return n
  }
  if (lower === 'bool') {
    const x = t.toLowerCase()
    if (['t', 'true', '1', 'yes', 'on'].includes(x)) return true
    if (['f', 'false', '0', 'no', 'off'].includes(x)) return false
    throw new Error('Invalid boolean (use true/false)')
  }
  if (
    ['text', 'varchar', 'bpchar', 'name', 'uuid', 'date', 'timestamp', 'timestamptz', 'time'].includes(lower) ||
    lower.startsWith('varchar') ||
    lower.startsWith('bpchar')
  ) {
    return t
  }
  if (['json', 'jsonb'].includes(lower)) {
    try {
      return JSON.parse(t) as unknown
    } catch {
      throw new Error('Invalid JSON')
    }
  }
  throw new Error(`Column type "${udt}" cannot be edited in the browser`)
}

async function handleSchemas(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
  const conn = parseConn(body)
  if (!conn) {
    sendJson(res, 400, { ok: false, error: 'host and valid port required' })
    return
  }
  try {
    const schemas = await withPgClient(conn, async (c) => {
      const r = await c.query<{ schema_name: string }>(
        `SELECT schema_name
         FROM information_schema.schemata
         WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
           AND schema_name NOT LIKE 'pg\\_%' ESCAPE '\\'
         ORDER BY schema_name`,
      )
      return r.rows.map((row) => row.schema_name)
    })
    sendJson(res, 200, { ok: true, schemas })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: pgErr(e) })
  }
}

async function handleTables(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: PgConnBody & { schema?: string }
  try {
    body = JSON.parse(await readBody(req)) as PgConnBody & { schema?: string }
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' })
    return
  }
  const conn = parseConn(body)
  if (!conn) {
    sendJson(res, 400, { ok: false, error: 'host and valid port required' })
    return
  }
  let schema: string
  try {
    schema = assertIdent(body.schema, 'schema')
  } catch (err) {
    sendJson(res, 400, { ok: false, error: pgErr(err) })
    return
  }
  try {
    const tables = await withPgClient(conn, async (c) => {
      const r = await c.query<{ table_name: string; table_type: string }>(
        `SELECT table_name, table_type
         FROM information_schema.tables
         WHERE table_schema = $1
         ORDER BY table_name`,
        [schema],
      )
      return r.rows.map((row) => ({ name: row.table_name, type: row.table_type }))
    })
    sendJson(res, 200, { ok: true, tables })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: pgErr(e) })
  }
}

const MAX_LIMIT = 200
const MAX_OFFSET = 1_000_000

async function handleRows(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: PgConnBody & { schema?: string; table?: string; limit?: number; offset?: number }
  try {
    body = JSON.parse(await readBody(req)) as PgConnBody & {
      schema?: string
      table?: string
      limit?: number
      offset?: number
    }
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' })
    return
  }
  const conn = parseConn(body)
  if (!conn) {
    sendJson(res, 400, { ok: false, error: 'host and valid port required' })
    return
  }
  let schema: string
  let table: string
  try {
    schema = assertIdent(body.schema, 'schema')
    table = assertIdent(body.table, 'table')
  } catch (err) {
    sendJson(res, 400, { ok: false, error: pgErr(err) })
    return
  }
  const limit =
    typeof body.limit === 'number' && Number.isFinite(body.limit)
      ? Math.min(Math.max(1, Math.floor(body.limit)), MAX_LIMIT)
      : 100
  const offset =
    typeof body.offset === 'number' && Number.isFinite(body.offset)
      ? Math.min(Math.max(0, Math.floor(body.offset)), MAX_OFFSET)
      : 0

  const qSchema = quoteIdent(schema)
  const qTable = quoteIdent(table)
  /* No ORDER BY: avoids errors on non-sortable first columns; order is not stable across pages. */
  const sql = `SELECT * FROM ${qSchema}.${qTable} LIMIT $1 OFFSET $2`

  try {
    const payload = await withPgClient(conn, async (c) => {
      const [r, tableType, primaryKeyColumns] = await Promise.all([
        c.query<Record<string, unknown>>(sql, [limit, offset]),
        fetchTableType(c, schema, table),
        fetchPrimaryKeyColumns(c, schema, table),
      ])
      const columns = r.fields.map((f) => f.name)
      return {
        columns,
        rows: r.rows,
        rowCount: r.rowCount ?? r.rows.length,
        tableType: tableType ?? null,
        primaryKeyColumns,
      }
    })
    const n = payload.rows.length
    sendJson(res, 200, {
      ok: true,
      schema,
      table,
      columns: payload.columns,
      rows: payload.rows,
      rowCount: payload.rowCount,
      limit,
      offset,
      hasMore: n >= limit,
      tableType: payload.tableType,
      primaryKeyColumns: payload.primaryKeyColumns,
    })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: pgErr(e) })
  }
}

async function handleUpdateCell(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: PgConnBody & {
    schema?: string
    table?: string
    column?: string
    primaryKey?: Record<string, unknown>
    valueText?: string
  }
  try {
    body = JSON.parse(await readBody(req)) as PgConnBody & {
      schema?: string
      table?: string
      column?: string
      primaryKey?: Record<string, unknown>
      valueText?: string
    }
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' })
    return
  }
  const conn = parseConn(body)
  if (!conn) {
    sendJson(res, 400, { ok: false, error: 'host and valid port required' })
    return
  }
  let schema: string
  let table: string
  let column: string
  try {
    schema = assertIdent(body.schema, 'schema')
    table = assertIdent(body.table, 'table')
    column = assertIdent(body.column, 'column')
  } catch (err) {
    sendJson(res, 400, { ok: false, error: pgErr(err) })
    return
  }
  const primaryKey = body.primaryKey
  if (typeof primaryKey !== 'object' || primaryKey === null || Array.isArray(primaryKey)) {
    sendJson(res, 400, { ok: false, error: 'primaryKey object required' })
    return
  }
  const valueText = typeof body.valueText === 'string' ? body.valueText : ''

  try {
    await withPgClient(conn, async (c) => {
      const tt = await fetchTableType(c, schema, table)
      if (tt !== 'BASE TABLE') {
        throw new Error('Only base tables can be edited in the browser')
      }

      const pkCols = await fetchPrimaryKeyColumns(c, schema, table)
      if (pkCols.length === 0) {
        throw new Error('Table has no primary key; cell editing is disabled')
      }
      for (const pk of pkCols) {
        if (!(pk in primaryKey)) {
          throw new Error(`Missing primary key value for column "${pk}"`)
        }
      }
      if (pkCols.includes(column)) {
        throw new Error('Primary key columns cannot be edited here')
      }

      const colMetaR = await c.query<{
        udt_name: string
        is_generated: string | null
        is_nullable: string
      }>(
        `SELECT udt_name, is_generated, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        [schema, table, column],
      )
      const colMeta = colMetaR.rows[0]
      if (!colMeta) throw new Error('Unknown column')
      const gen = colMeta.is_generated
      if (gen === 'ALWAYS' || gen === 'YES') {
        throw new Error('Generated columns are read-only')
      }

      const nullable = colMeta.is_nullable === 'YES'
      const newVal = parseValueFromText(colMeta.udt_name, valueText, nullable)

      const qSchema = quoteIdent(schema)
      const qTable = quoteIdent(table)
      const qCol = quoteIdent(column)
      const whereParts = pkCols.map((pk, i) => `${quoteIdent(pk)} = $${i + 2}`)
      const params: unknown[] = [newVal, ...pkCols.map((pk) => primaryKey[pk])]

      const sql = `UPDATE ${qSchema}.${qTable} SET ${qCol} = $1 WHERE ${whereParts.join(' AND ')}`
      const result = await c.query(sql, params)
      if (result.rowCount === 0) {
        throw new Error('No row was updated (deleted or primary key mismatch)')
      }
    })
    sendJson(res, 200, { ok: true })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: pgErr(e) })
  }
}

function postgresBrowserMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url?.split('?')[0] ?? ''
    if (url === '/api/db/postgres/schemas') {
      void handleSchemas(req, res)
      return
    }
    if (url === '/api/db/postgres/tables') {
      void handleTables(req, res)
      return
    }
    if (url === '/api/db/postgres/rows') {
      void handleRows(req, res)
      return
    }
    if (url === '/api/db/postgres/update-cell') {
      void handleUpdateCell(req, res)
      return
    }
    next()
  }
}

export function postgresBrowserApiPlugin() {
  return {
    name: 'dev-manager-postgres-browser-api',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(postgresBrowserMiddleware())
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(postgresBrowserMiddleware())
    },
  }
}

import mysql from 'mysql2/promise'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect } from 'vite'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'

/**
 * Values for `connection.query(sql, values)` — avoids prepared-statement quirks
 * (e.g. LIMIT ? sent as DOUBLE → ER_WRONG_ARGUMENTS on MySQL 8.0.22+).
 */
function bindParams(values: unknown[]): (string | number | boolean | Date | Buffer | null)[] {
  return values.map((v) => {
    if (v === undefined || v === null) return null
    if (typeof v === 'bigint') return v.toString()
    if (typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
      return JSON.stringify(v)
    }
    return v as string | number | boolean | Date | Buffer | null
  })
}

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
  /** Optional default database for the server session (login). */
  database?: string
}

type ParsedConn = {
  host: string
  port: number
  user: string
  password: string | undefined
  database: string | undefined
}

function parseConn(body: MysqlConnBody): ParsedConn | null {
  const host = typeof body.host === 'string' ? body.host.trim() : ''
  const port = typeof body.port === 'number' && Number.isFinite(body.port) ? body.port : 0
  if (!host || port < 1 || port > 65535) return null
  const user =
    typeof body.username === 'string' && body.username.trim() ? body.username.trim() : 'root'
  const password = typeof body.password === 'string' && body.password.length ? body.password : undefined
  const database =
    typeof body.database === 'string' && body.database.trim() ? body.database.trim() : undefined
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
    throw new Error(`Invalid ${label}`)
  }
  return name
}

function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`'
}

async function fetchTableType(
  conn: mysql.Connection,
  schema: string,
  table: string,
): Promise<string | undefined> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT TABLE_TYPE AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [schema, table],
  )
  const r = rows[0] as { t?: string } | undefined
  return r?.t
}

async function fetchTableColumnNames(
  conn: mysql.Connection,
  schema: string,
  table: string,
): Promise<string[]> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [schema, table],
  )
  return rows.map((row) => String((row as { c: string }).c))
}

async function fetchPrimaryKeyColumns(
  conn: mysql.Connection,
  schema: string,
  table: string,
): Promise<string[]> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS c
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
     ORDER BY ORDINAL_POSITION`,
    [schema, table],
  )
  return rows.map((row) => String((row as { c: string }).c))
}

function parseValueFromMysqlType(
  dataType: string,
  text: string,
  nullable: boolean,
  extra: string,
): unknown {
  const t = text.trim()
  if (t === '' && nullable) return null
  if (t === '' && !nullable) throw new Error('A value is required for this column')
  const lower = dataType.toLowerCase()
  if (extra.toLowerCase().includes('auto_increment')) {
    throw new Error('Auto-increment columns are read-only here')
  }
  if (
    [
      'tinyint',
      'smallint',
      'mediumint',
      'int',
      'integer',
      'bigint',
      'year',
    ].includes(lower)
  ) {
    const n = Number(t)
    if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error('Invalid integer')
    return n
  }
  if (['decimal', 'numeric', 'float', 'double'].includes(lower)) {
    const n = Number(t)
    if (!Number.isFinite(n)) throw new Error('Invalid number')
    return n
  }
  if (lower === 'bit') {
    if (!/^[01]+$/.test(t)) throw new Error('Invalid bit string')
    return t
  }
  if (lower === 'json') {
    try {
      return JSON.parse(t) as unknown
    } catch {
      throw new Error('Invalid JSON')
    }
  }
  if (
    [
      'char',
      'varchar',
      'text',
      'tinytext',
      'mediumtext',
      'longtext',
      'enum',
      'set',
      'date',
      'datetime',
      'timestamp',
      'time',
    ].includes(lower) ||
    lower.startsWith('varchar') ||
    lower.startsWith('char')
  ) {
    return t
  }
  if (
    ['binary', 'varbinary', 'blob', 'tinyblob', 'mediumblob', 'longblob'].includes(lower) ||
    lower.includes('blob')
  ) {
    throw new Error(`Column type "${dataType}" cannot be edited in the browser`)
  }
  return t
}

const MAX_LIMIT = 200
const MAX_DELETE_ROWS = 200
const MAX_OFFSET = 1_000_000
const MAX_FILTERS = 12
const MAX_GLOBAL_SEARCH_LEN = 500
const MAX_FILTER_VALUE_LEN = 4000
const MAX_GLOBAL_SEARCH_COLUMNS = 48

const FILTER_OPS = new Set([
  '=',
  '!=',
  '<>',
  '<',
  '>',
  '<=',
  '>=',
  'LIKE',
  'ILIKE',
  'IS_NULL',
  'IS_NOT_NULL',
])

type RowFilterIn = { column?: string; op?: string; value?: string }

function sqlOp(op: string): string {
  if (op === '!=') return '<>'
  return op
}

/** Builds a WHERE fragment using `?` placeholders (mysql2). */
function parseRowFiltersMysql(raw: unknown): { clause: string; params: unknown[] } {
  if (raw === undefined || raw === null) return { clause: '', params: [] }
  if (!Array.isArray(raw)) throw new Error('filters must be an array')
  const parts: string[] = []
  const params: unknown[] = []
  for (const item of raw.slice(0, MAX_FILTERS)) {
    if (typeof item !== 'object' || item === null) continue
    const f = item as RowFilterIn
    const col = assertIdent(f.column, 'filter column')
    const op = f.op
    if (typeof op !== 'string' || !FILTER_OPS.has(op)) {
      throw new Error('Invalid filter operator')
    }
    const qc = quoteIdent(col)
    if (op === 'IS_NULL') {
      parts.push(`${qc} IS NULL`)
    } else if (op === 'IS_NOT_NULL') {
      parts.push(`${qc} IS NOT NULL`)
    } else {
      if (typeof f.value !== 'string') throw new Error('Filter value required')
      if (f.value.length > MAX_FILTER_VALUE_LEN) throw new Error('Filter value too long')
      if (op === 'ILIKE') {
        // Avoid `LOWER(?)` — some servers / binary protocol combos break on placeholders inside functions.
        parts.push(`LOWER(CAST(${qc} AS CHAR(8000))) LIKE ?`)
        params.push(f.value.toLowerCase())
      } else {
        const sop = sqlOp(op)
        parts.push(`${qc} ${sop} ?`)
        params.push(f.value)
      }
    }
  }
  return { clause: parts.join(' AND '), params }
}

function rowToJsonSafe(row: RowDataPacket): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') out[k] = v.toString()
    else if (v instanceof Date) out[k] = v.toISOString()
    else if (Buffer.isBuffer(v)) {
      out[k] = { type: 'Buffer', data: [...v] }
    } else out[k] = v as unknown
  }
  return out
}

async function handleSchemas(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
  const conn = parseConn(body)
  if (!conn) {
    sendJson(res, 400, { ok: false, error: 'host and valid port required' })
    return
  }
  try {
    const schemas = await withMysql(conn, async (c) => {
      const [rows] = await c.query<RowDataPacket[]>(
        `SELECT SCHEMA_NAME AS s FROM information_schema.SCHEMATA
         WHERE SCHEMA_NAME NOT IN ('information_schema','performance_schema','sys','mysql')
         ORDER BY SCHEMA_NAME`,
      )
      return rows.map((r) => String((r as { s: string }).s))
    })
    sendJson(res, 200, { ok: true, schemas })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: mysqlErr(e) })
  }
}

async function handleTables(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: MysqlConnBody & { schema?: string }
  try {
    body = JSON.parse(await readBody(req)) as MysqlConnBody & { schema?: string }
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
    sendJson(res, 400, { ok: false, error: mysqlErr(err) })
    return
  }
  try {
    const tables = await withMysql(conn, async (c) => {
      const [rows] = await c.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS n, TABLE_TYPE AS t FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
        [schema],
      )
      return rows.map((row) => {
        const r = row as { n: string; t: string }
        return { name: r.n, type: r.t }
      })
    })
    sendJson(res, 200, { ok: true, tables })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: mysqlErr(e) })
  }
}

async function handleRows(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: MysqlConnBody & {
    schema?: string
    table?: string
    limit?: number
    offset?: number
    filters?: unknown
    globalSearch?: string
  }
  try {
    body = JSON.parse(await readBody(req)) as MysqlConnBody & {
      schema?: string
      table?: string
      limit?: number
      offset?: number
      filters?: unknown
      globalSearch?: string
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
    sendJson(res, 400, { ok: false, error: mysqlErr(err) })
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

  let filterClause = ''
  let filterParams: unknown[] = []
  try {
    const parsed = parseRowFiltersMysql(body.filters)
    filterClause = parsed.clause
    filterParams = parsed.params
  } catch (err) {
    sendJson(res, 400, { ok: false, error: mysqlErr(err) })
    return
  }

  const globalRaw = typeof body.globalSearch === 'string' ? body.globalSearch.trim() : ''
  if (globalRaw.length > MAX_GLOBAL_SEARCH_LEN) {
    sendJson(res, 400, { ok: false, error: 'globalSearch text is too long' })
    return
  }

  const qSchema = quoteIdent(schema)
  const qTable = quoteIdent(table)
  const fromSql = `${qSchema}.${qTable}`

  try {
    const payload = await withMysql(conn, async (c) => {
      const whereParts: string[] = []
      const params: unknown[] = [...filterParams]
      if (filterClause) whereParts.push(`(${filterClause})`)
      if (globalRaw.length > 0) {
        const colNames = (await fetchTableColumnNames(c, schema, table)).slice(0, MAX_GLOBAL_SEARCH_COLUMNS)
        if (colNames.length === 0) throw new Error('No columns to search')
        const searchPat = `%${globalRaw}%`.toLowerCase()
        const ors = colNames
          .map((name) => `LOWER(CAST(${quoteIdent(name)} AS CHAR(8000))) LIKE ?`)
          .join(' OR ')
        whereParts.push(`(${ors})`)
        for (let i = 0; i < colNames.length; i++) params.push(searchPat)
      }
      const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''
      const countSql = `SELECT COUNT(*) AS c FROM ${fromSql} ${whereSql}`
      // LIMIT/OFFSET as `?` with `execute()` is a common source of ER_WRONG_ARGUMENTS on MySQL 8.0.22+;
      // values are already clamped to safe integers.
      const dataSql = `SELECT * FROM ${fromSql} ${whereSql} LIMIT ${limit} OFFSET ${offset}`

      // Use text protocol (`query`) so we are not affected by mysql2 prepared-statement type bugs.
      const [countRows] = await c.query<RowDataPacket[]>(countSql, bindParams(params))
      const [dataRows, fields] = await c.query<RowDataPacket[]>(dataSql, bindParams(params))
      const tableType = await fetchTableType(c, schema, table)
      const primaryKeyColumns = await fetchPrimaryKeyColumns(c, schema, table)
      const totalCount = Number((countRows[0] as { c?: number | string } | undefined)?.c ?? 0)
      const columns = (fields ?? []).map((f) => f.name)
      const rows = (dataRows as RowDataPacket[]).map(rowToJsonSafe)
      return {
        columns,
        rows,
        rowCount: rows.length,
        totalCount,
        tableType: tableType ?? null,
        primaryKeyColumns,
      }
    })
    const n = payload.rows.length
    const total = payload.totalCount
    sendJson(res, 200, {
      ok: true,
      schema,
      table,
      columns: payload.columns,
      rows: payload.rows,
      rowCount: payload.rowCount,
      totalCount: total,
      limit,
      offset,
      hasMore: n >= limit && offset + n < total,
      tableType: payload.tableType,
      primaryKeyColumns: payload.primaryKeyColumns,
    })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: mysqlErr(e) })
  }
}

async function handleUpdateCell(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: MysqlConnBody & {
    schema?: string
    table?: string
    column?: string
    primaryKey?: Record<string, unknown>
    valueText?: string
  }
  try {
    body = JSON.parse(await readBody(req)) as MysqlConnBody & {
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
    sendJson(res, 400, { ok: false, error: mysqlErr(err) })
    return
  }
  const primaryKey = body.primaryKey
  if (typeof primaryKey !== 'object' || primaryKey === null || Array.isArray(primaryKey)) {
    sendJson(res, 400, { ok: false, error: 'primaryKey object required' })
    return
  }
  const valueText = typeof body.valueText === 'string' ? body.valueText : ''

  try {
    await withMysql(conn, async (c) => {
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

      const [metaRows] = await c.query<RowDataPacket[]>(
        `SELECT DATA_TYPE AS dt, IS_NULLABLE AS nu, EXTRA AS ex, COLUMN_KEY AS ck
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [schema, table, column],
      )
      const colMeta = metaRows[0] as { dt: string; nu: string; ex: string; ck: string } | undefined
      if (!colMeta) throw new Error('Unknown column')
      if (colMeta.ck === 'PRI') {
        throw new Error('Primary key columns cannot be edited here')
      }

      const nullable = colMeta.nu === 'YES'
      const newVal = parseValueFromMysqlType(colMeta.dt, valueText, nullable, colMeta.ex)

      const qSchema = quoteIdent(schema)
      const qTable = quoteIdent(table)
      const qCol = quoteIdent(column)
      const setParts = [`${qCol} = ?`]
      const execParams: unknown[] = [newVal]
      const whereParts = pkCols.map((pk) => {
        execParams.push(primaryKey[pk])
        return `${quoteIdent(pk)} = ?`
      })
      const sql = `UPDATE ${qSchema}.${qTable} SET ${setParts.join(', ')} WHERE ${whereParts.join(' AND ')}`
      const [result] = await c.query<ResultSetHeader>(sql, bindParams(execParams))
      const info = result as ResultSetHeader
      if (!info.affectedRows) {
        throw new Error('No row was updated (deleted or primary key mismatch)')
      }
    })
    sendJson(res, 200, { ok: true })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: mysqlErr(e) })
  }
}

async function handleDeleteRows(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: MysqlConnBody & {
    schema?: string
    table?: string
    primaryKeys?: unknown
  }
  try {
    body = JSON.parse(await readBody(req)) as MysqlConnBody & {
      schema?: string
      table?: string
      primaryKeys?: unknown
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
    sendJson(res, 400, { ok: false, error: mysqlErr(err) })
    return
  }
  const raw = body.primaryKeys
  if (!Array.isArray(raw) || raw.length === 0) {
    sendJson(res, 400, { ok: false, error: 'primaryKeys must be a non-empty array' })
    return
  }
  if (raw.length > MAX_DELETE_ROWS) {
    sendJson(res, 400, {
      ok: false,
      error: `At most ${MAX_DELETE_ROWS} rows can be deleted per request`,
    })
    return
  }

  try {
    const deleted = await withMysql(conn, async (c) => {
      const tt = await fetchTableType(c, schema, table)
      if (tt !== 'BASE TABLE') {
        throw new Error('Only base tables support row delete')
      }

      const pkCols = await fetchPrimaryKeyColumns(c, schema, table)
      if (pkCols.length === 0) {
        throw new Error('Table has no primary key')
      }

      const qSchema = quoteIdent(schema)
      const qTable = quoteIdent(table)
      await c.beginTransaction()
      try {
        let n = 0
        for (const item of raw) {
          if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            throw new Error('Each primaryKeys entry must be an object')
          }
          const pk = item as Record<string, unknown>
          for (const col of pkCols) {
            if (!(col in pk)) {
              throw new Error(`Missing primary key value for column "${col}"`)
            }
          }
          const params: unknown[] = []
          const whereParts = pkCols.map((col) => {
            params.push(pk[col])
            return `${quoteIdent(col)} = ?`
          })
          const sql = `DELETE FROM ${qSchema}.${qTable} WHERE ${whereParts.join(' AND ')}`
          const [result] = await c.query<ResultSetHeader>(sql, bindParams(params))
          const info = result as ResultSetHeader
          n += info.affectedRows ?? 0
        }
        await c.commit()
        return n
      } catch (e) {
        await c.rollback().catch(() => {})
        throw e
      }
    })
    sendJson(res, 200, { ok: true, deleted })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: mysqlErr(e) })
  }
}

function mysqlBrowserMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url?.split('?')[0] ?? ''
    if (url === '/api/db/mysql/schemas') {
      void handleSchemas(req, res)
      return
    }
    if (url === '/api/db/mysql/tables') {
      void handleTables(req, res)
      return
    }
    if (url === '/api/db/mysql/rows') {
      void handleRows(req, res)
      return
    }
    if (url === '/api/db/mysql/update-cell') {
      void handleUpdateCell(req, res)
      return
    }
    if (url === '/api/db/mysql/delete-rows') {
      void handleDeleteRows(req, res)
      return
    }
    next()
  }
}

export function mysqlBrowserApiPlugin() {
  return {
    name: 'dev-manager-mysql-browser-api',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(mysqlBrowserMiddleware())
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(mysqlBrowserMiddleware())
    },
  }
}

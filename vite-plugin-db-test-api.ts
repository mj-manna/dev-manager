import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect } from 'vite'

const execFileAsync = promisify(execFile)

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

type TestBody = {
  kind?: string
  host?: string
  port?: number
  username?: string
  database?: string
  password?: string
}

function errMsg(e: unknown): string {
  const x = e as NodeJS.ErrnoException & { stderr?: string; stdout?: string }
  if (x.code === 'ENOENT') {
    return 'CLI tool not found on PATH (install redis-cli, mysql, or psql for this check).'
  }
  const msg = (x.stderr || x.stdout || x.message || '').trim()
  return msg || 'Connection check failed'
}

async function testRedis(host: string, port: number, password?: string): Promise<{ ok: true; detail: string }> {
  const args = ['-h', host, '-p', String(port), 'PING']
  if (password?.length) args.push('-a', password)
  const { stdout, stderr } = await execFileAsync('redis-cli', args, {
    timeout: 12000,
    encoding: 'utf8',
    maxBuffer: 256 * 1024,
  })
  const out = `${stdout}${stderr}`.trim()
  if (/PONG/i.test(out)) return { ok: true, detail: 'Redis replied PONG.' }
  if (out) return { ok: true, detail: out }
  return { ok: true, detail: 'OK' }
}

async function testMysql(
  host: string,
  port: number,
  user: string,
  password: string | undefined,
  database: string | undefined,
): Promise<{ ok: true; detail: string }> {
  const args = ['-h', host, '-P', String(port), '-u', user, '--connect-timeout=8']
  if (password?.length) args.push('-p' + password)
  if (database?.length) args.push('-D', database)
  args.push('-e', 'SELECT 1')
  await execFileAsync('mysql', args, {
    timeout: 15000,
    encoding: 'utf8',
    maxBuffer: 256 * 1024,
  })
  return { ok: true, detail: 'MySQL accepted credentials (SELECT 1).' }
}

async function testPostgres(
  host: string,
  port: number,
  user: string,
  password: string | undefined,
  database: string | undefined,
): Promise<{ ok: true; detail: string }> {
  const env = { ...process.env }
  if (password?.length) env.PGPASSWORD = password
  const db = database?.trim() || 'postgres'
  const args = ['-h', host, '-p', String(port), '-U', user, '-d', db, '-c', 'SELECT 1']
  await execFileAsync('psql', args, {
    env,
    timeout: 15000,
    encoding: 'utf8',
    maxBuffer: 256 * 1024,
  })
  return { ok: true, detail: 'PostgreSQL accepted connection (SELECT 1).' }
}

async function handleDbTestApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: TestBody
  try {
    body = JSON.parse(await readBody(req)) as TestBody
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' })
    return
  }
  const kind = body.kind
  const host = typeof body.host === 'string' ? body.host.trim() : ''
  const port = typeof body.port === 'number' && Number.isFinite(body.port) ? body.port : 0
  if (!host) {
    sendJson(res, 400, { ok: false, error: 'host is required' })
    return
  }
  if (port < 1 || port > 65535) {
    sendJson(res, 400, { ok: false, error: 'port must be 1–65535' })
    return
  }

  try {
    if (kind === 'redis') {
      const r = await testRedis(host, port, body.password?.trim())
      sendJson(res, 200, { ok: true, detail: r.detail })
      return
    }
    if (kind === 'mysql') {
      const user = body.username?.trim() || 'root'
      const r = await testMysql(host, port, user, body.password?.trim(), body.database?.trim())
      sendJson(res, 200, { ok: true, detail: r.detail })
      return
    }
    if (kind === 'postgresql') {
      const user = body.username?.trim() || 'postgres'
      const r = await testPostgres(host, port, user, body.password?.trim(), body.database?.trim())
      sendJson(res, 200, { ok: true, detail: r.detail })
      return
    }
    sendJson(res, 400, { ok: false, error: 'kind must be redis, mysql, or postgresql' })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: errMsg(e) })
  }
}

function dbTestApiMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url?.split('?')[0] ?? ''
    if (url !== '/api/db/test-connection') {
      next()
      return
    }
    void handleDbTestApi(req, res)
  }
}

export function dbTestApiPlugin() {
  return {
    name: 'dev-manager-db-test-api',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(dbTestApiMiddleware())
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(dbTestApiMiddleware())
    },
  }
}

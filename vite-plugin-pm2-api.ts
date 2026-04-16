import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect } from 'vite'

const execFileAsync = promisify(execFile)

const PM2_NAME = /^[a-zA-Z0-9_.@-]{1,200}$/

function stripAnsi(input: string): string {
  const csi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
  return input.replace(csi, '')
}

/** PM2 sometimes prints banners; jlist JSON is always a top-level array. */
function coerceJlistStdout(raw: string): string {
  const t = stripAnsi(raw).replace(/^\uFEFF/, '').trimStart()
  const i = t.indexOf('[')
  if (i <= 0) return t
  return t.slice(i)
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

async function runPm2(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('pm2', args, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', PM2_DISABLE_COLORS: '1' },
    })
    return { ok: true, stdout: String(stdout).trimEnd(), stderr: String(stderr).trimEnd() }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return {
      ok: false,
      stdout: String(err.stdout ?? '').trimEnd(),
      stderr: String(err.stderr ?? '').trimEnd(),
    }
  }
}

export type Pm2ProcessRow = {
  pmId: number
  name: string
  status: string
  cpu: number
  memoryBytes: number
  restarts: number
  pid: number | null
}

function parseJlist(stdout: string): { processes: Pm2ProcessRow[]; parseError: string | null } {
  const coerced = coerceJlistStdout(stdout)
  let parsed: unknown
  try {
    parsed = JSON.parse(coerced) as unknown
  } catch {
    const head = coerced.slice(0, 120).replace(/\s+/g, ' ')
    return {
      processes: [],
      parseError: `pm2 jlist returned invalid JSON (starts with: ${head || '(empty)'}…)`,
    }
  }
  if (!Array.isArray(parsed)) {
    return { processes: [], parseError: 'pm2 jlist was not a JSON array' }
  }
  const processes: Pm2ProcessRow[] = []
  for (const item of parsed) {
    if (item == null || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name : ''
    const env = o.pm2_env != null && typeof o.pm2_env === 'object' ? (o.pm2_env as Record<string, unknown>) : null
    const pmIdRaw =
      typeof o.pm_id === 'number' ? o.pm_id : env && typeof env.pm_id === 'number' ? env.pm_id : NaN
    const status =
      env && typeof env.status === 'string'
        ? env.status
        : typeof o.status === 'string'
          ? o.status
          : 'unknown'
    const monit = o.monit != null && typeof o.monit === 'object' ? (o.monit as Record<string, unknown>) : null
    const cpu = monit && typeof monit.cpu === 'number' ? monit.cpu : 0
    const memoryBytes = monit && typeof monit.memory === 'number' ? monit.memory : 0
    const restarts =
      env && typeof env.restart_time === 'number'
        ? env.restart_time
        : typeof o.restart_time === 'number'
          ? o.restart_time
          : 0
    const pid = typeof o.pid === 'number' ? o.pid : null
    if (!name || !Number.isFinite(pmIdRaw)) continue
    processes.push({
      pmId: pmIdRaw,
      name,
      status: status.toLowerCase(),
      cpu,
      memoryBytes,
      restarts,
      pid,
    })
  }
  return { processes, parseError: null }
}

function validProcessTarget(target: string): boolean {
  const t = target.trim()
  if (/^\d+$/.test(t)) return true
  return PM2_NAME.test(t)
}

async function handlePm2Api(req: IncomingMessage, res: ServerResponse, pathOnly: string): Promise<void> {
  res.setHeader('Content-Type', 'application/json')

  if (pathOnly === '/api/pm2/status' && req.method === 'GET') {
    const ver = await runPm2(['-v'])
    res.end(
      JSON.stringify({
        platform: process.platform,
        cliAvailable: ver.ok,
        version: ver.ok ? ver.stdout || null : null,
        error: ver.ok ? null : ver.stderr || ver.stdout || 'pm2 not found or failed',
      }),
    )
    return
  }

  if (pathOnly === '/api/pm2/processes' && req.method === 'GET') {
    const r = await runPm2(['jlist'])
    if (!r.ok) {
      const msg = r.stderr || r.stdout || 'pm2 jlist failed'
      const code = msg.toLowerCase().includes('connect') || msg.toLowerCase().includes('econnrefused') ? 503 : 500
      res.statusCode = code
      res.end(JSON.stringify({ error: msg, processes: [] }))
      return
    }
    const { processes, parseError } = parseJlist(r.stdout)
    if (parseError) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: parseError, processes: [] }))
      return
    }
    res.end(JSON.stringify({ processes }))
    return
  }

  if (pathOnly === '/api/pm2/process' && req.method === 'POST') {
    let body: { target?: string; action?: string }
    try {
      body = JSON.parse(await readBody(req)) as { target?: string; action?: string }
    } catch {
      res.statusCode = 400
      res.end(JSON.stringify({ error: 'Invalid JSON body' }))
      return
    }
    const target = typeof body.target === 'string' ? body.target.trim() : ''
    const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : ''
    if (!validProcessTarget(target)) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: 'Invalid process name or id' }))
      return
    }
    if (action !== 'stop' && action !== 'reload' && action !== 'restart') {
      res.statusCode = 400
      res.end(JSON.stringify({ error: 'action must be stop, reload, or restart' }))
      return
    }
    const r = await runPm2([action, target])
    if (!r.ok) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: r.stderr || r.stdout || 'pm2 command failed' }))
      return
    }
    res.end(JSON.stringify({ ok: true, message: r.stdout || `${action} ${target}` }))
    return
  }

  if (pathOnly === '/api/pm2/restart-all' && req.method === 'POST') {
    const r = await runPm2(['restart', 'all'])
    if (!r.ok) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: r.stderr || r.stdout || 'pm2 restart all failed' }))
      return
    }
    res.end(JSON.stringify({ ok: true, message: r.stdout || 'pm2 restart all completed' }))
    return
  }

  res.statusCode = 404
  res.end(JSON.stringify({ error: 'Not found' }))
}

function pm2ApiMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const raw = req.url?.split('?')[0] ?? ''
    const url = raw.replace(/\/+$/, '') || '/'
    if (!url.startsWith('/api/pm2')) {
      next()
      return
    }
    void handlePm2Api(req, res, url)
  }
}

export function pm2ApiPlugin() {
  return {
    name: 'dev-manager-pm2-api',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(pm2ApiMiddleware())
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(pm2ApiMiddleware())
    },
  }
}

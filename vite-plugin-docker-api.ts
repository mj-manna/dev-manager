import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect } from 'vite'

const execFileAsync = promisify(execFile)

const CONTAINER_TARGET = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/

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

async function runDocker(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
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

export type DockerContainerRow = {
  id: string
  names: string
  image: string
  status: string
  state: string
}

function parseContainerLines(stdout: string): DockerContainerRow[] {
  const rows: DockerContainerRow[] = []
  const sep = '\x1f'
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const parts = t.split(sep)
    if (parts.length < 5) continue
    const [id, names, image, status, state] = parts
    if (!id) continue
    rows.push({
      id,
      names: names || '—',
      image: image || '—',
      status: status || '—',
      state: (state || 'unknown').toLowerCase(),
    })
  }
  return rows
}

async function handleDockerApi(req: IncomingMessage, res: ServerResponse, pathOnly: string): Promise<void> {
  res.setHeader('Content-Type', 'application/json')

  if (pathOnly === '/api/docker/status' && req.method === 'GET') {
    const client = await runDocker(['version', '--format', '{{.Client.Version}}'])
    const server = await runDocker(['info', '--format', '{{.ServerVersion}}'])
    const context = await runDocker(['context', 'show'])
    res.end(
      JSON.stringify({
        platform: process.platform,
        clientAvailable: client.ok,
        clientVersion: client.ok ? client.stdout || null : null,
        daemonReachable: server.ok,
        serverVersion: server.ok ? server.stdout || null : null,
        context: context.ok ? context.stdout || 'default' : null,
        error:
          !client.ok && client.stderr
            ? client.stderr
            : !server.ok && server.stderr
              ? server.stderr
              : null,
      }),
    )
    return
  }

  if (pathOnly === '/api/docker/containers' && req.method === 'GET') {
    const fmt = `{{.ID}}\x1f{{.Names}}\x1f{{.Image}}\x1f{{.Status}}\x1f{{.State}}`
    const r = await runDocker(['ps', '-a', '--no-trunc', '--format', fmt])
    if (!r.ok) {
      res.statusCode = r.stderr.includes('Cannot connect') || r.stderr.includes('connection refused') ? 503 : 500
      res.end(JSON.stringify({ error: r.stderr || 'docker ps failed', containers: [] }))
      return
    }
    res.end(JSON.stringify({ containers: parseContainerLines(r.stdout) }))
    return
  }

  if (pathOnly === '/api/docker/container' && req.method === 'POST') {
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
    if (!CONTAINER_TARGET.test(target)) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: 'Invalid container id or name' }))
      return
    }
    if (action !== 'start' && action !== 'stop' && action !== 'restart') {
      res.statusCode = 400
      res.end(JSON.stringify({ error: 'action must be start, stop, or restart' }))
      return
    }
    const r = await runDocker([action, target])
    if (!r.ok) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: r.stderr || r.stdout || 'docker command failed' }))
      return
    }
    res.end(JSON.stringify({ ok: true, message: r.stdout || `${action} ${target}` }))
    return
  }

  res.statusCode = 404
  res.end(JSON.stringify({ error: 'Not found' }))
}

function dockerApiMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url?.split('?')[0] ?? ''
    if (!url.startsWith('/api/docker')) {
      next()
      return
    }
    void handleDockerApi(req, res, url)
  }
}

export function dockerApiPlugin() {
  return {
    name: 'dev-manager-docker-api',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(dockerApiMiddleware())
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(dockerApiMiddleware())
    },
  }
}

import fs from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect, Plugin } from 'vite'

const MAX_BYTES = 512 * 1024

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

type Body = { cwd?: string }

type Runner = 'pnpm' | 'npm' | 'yarn' | 'bun'

/** Serialized on the API for UI tooltips. */
type RunnerSource =
  | 'package_manager_field'
  | 'pnpm_lock'
  | 'yarn_lock'
  | 'bun_lock'
  | 'package_lock_json'
  | 'npm_default'

type RunnerDetection = {
  runner: Runner
  source: RunnerSource
  /** e.g. raw `packageManager` value: `pnpm@9.0.0` */
  detail?: string
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function detectRunner(dir: string, pkg: Record<string, unknown>): Promise<RunnerDetection> {
  const pm = pkg.packageManager
  if (typeof pm === 'string' && pm.trim()) {
    const t = pm.trim()
    if (t.startsWith('pnpm')) return { runner: 'pnpm', source: 'package_manager_field', detail: t }
    if (t.startsWith('yarn')) return { runner: 'yarn', source: 'package_manager_field', detail: t }
    if (t.startsWith('bun')) return { runner: 'bun', source: 'package_manager_field', detail: t }
    if (t.startsWith('npm')) return { runner: 'npm', source: 'package_manager_field', detail: t }
  }
  if (await fileExists(path.join(dir, 'pnpm-lock.yaml')))
    return { runner: 'pnpm', source: 'pnpm_lock' }
  if (await fileExists(path.join(dir, 'yarn.lock'))) return { runner: 'yarn', source: 'yarn_lock' }
  if (await fileExists(path.join(dir, 'bun.lockb')) || (await fileExists(path.join(dir, 'bun.lock'))))
    return { runner: 'bun', source: 'bun_lock' }
  if (await fileExists(path.join(dir, 'package-lock.json')))
    return { runner: 'npm', source: 'package_lock_json' }
  return { runner: 'npm', source: 'npm_default' }
}

async function handlePackageJson(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let body: Body = {}
  try {
    body = JSON.parse(raw) as Body
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' })
    return
  }
  const input = typeof body.cwd === 'string' ? body.cwd.trim() : ''
  if (!input) {
    sendJson(res, 400, { ok: false, error: 'Missing cwd' })
    return
  }
  const resolved = path.isAbsolute(input) ? path.normalize(input) : path.resolve(process.cwd(), input)
  if (resolved.includes('\0')) {
    sendJson(res, 400, { ok: false, error: 'Invalid path' })
    return
  }
  let st: Awaited<ReturnType<typeof fs.stat>>
  try {
    st = await fs.stat(resolved)
  } catch {
    sendJson(res, 200, {
      ok: true,
      hasPackageJson: false,
      scripts: {},
      runner: 'npm' as Runner,
      runnerSource: 'npm_default' as RunnerSource,
    })
    return
  }
  if (!st.isDirectory()) {
    sendJson(res, 200, {
      ok: true,
      hasPackageJson: false,
      scripts: {},
      runner: 'npm' as Runner,
      runnerSource: 'npm_default' as RunnerSource,
    })
    return
  }
  const pkgPath = path.join(resolved, 'package.json')
  let buf: Buffer
  try {
    buf = await fs.readFile(pkgPath)
  } catch {
    sendJson(res, 200, {
      ok: true,
      hasPackageJson: false,
      scripts: {},
      runner: 'npm' as Runner,
      runnerSource: 'npm_default' as RunnerSource,
    })
    return
  }
  if (buf.length > MAX_BYTES) {
    sendJson(res, 413, { ok: false, error: 'package.json too large' })
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(buf.toString('utf8'))
  } catch {
    sendJson(res, 200, {
      ok: true,
      hasPackageJson: true,
      scripts: {},
      runner: 'npm' as Runner,
      runnerSource: 'npm_default' as RunnerSource,
      parseError: 'Invalid JSON in package.json',
    })
    return
  }
  const pkg = parsed as Record<string, unknown>
  const scriptsRaw = pkg.scripts
  const scripts: Record<string, string> = {}
  if (scriptsRaw && typeof scriptsRaw === 'object' && !Array.isArray(scriptsRaw)) {
    for (const [k, v] of Object.entries(scriptsRaw as Record<string, unknown>)) {
      if (typeof v === 'string' && k) scripts[k] = v
    }
  }
  const detection = await detectRunner(resolved, pkg)
  sendJson(res, 200, {
    ok: true,
    hasPackageJson: true,
    scripts,
    runner: detection.runner,
    runnerSource: detection.source,
    ...(detection.detail ? { runnerSourceDetail: detection.detail } : {}),
  })
}

function deploymentsPackageMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url?.split('?')[0] ?? ''
    if (req.method !== 'POST' || url !== '/api/deployments/package-json') {
      next()
      return
    }
    void handlePackageJson(req as IncomingMessage, res as ServerResponse).catch((e) => {
      sendJson(res as ServerResponse, 500, {
        ok: false,
        error: e instanceof Error ? e.message : 'Server error',
      })
    })
  }
}

export function deploymentsPackageApiPlugin(): Plugin {
  return {
    name: 'deployments-package-api',
    configureServer(server) {
      server.middlewares.use(deploymentsPackageMiddleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use(deploymentsPackageMiddleware())
    },
  }
}

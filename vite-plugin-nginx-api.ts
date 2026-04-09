import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { Connect } from 'vite'
import {
  enableDebianStyleVhostSite,
  execWithSudo,
  mkdirMaybeElevated,
  readFileMaybeElevated,
  removeVhostConfigFile,
  unlinkMaybeElevated,
  writeFileMaybeElevated,
} from './privileged-write'

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

const SAFE_NAME = /^[a-zA-Z0-9._-]+$/

function isSafeBasename(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 128 &&
    SAFE_NAME.test(name) &&
    !name.includes('..')
  )
}

async function nginxVersionLine(): Promise<string | null> {
  try {
    const { stderr, stdout } = await execFileAsync('nginx', ['-v'], {
      encoding: 'utf8',
    })
    const t = (stderr || stdout || '').trim()
    return t || null
  } catch {
    return null
  }
}

async function resolveNginxRoot(): Promise<string> {
  let root = '/etc/nginx'
  try {
    const { stderr } = await execFileAsync('nginx', ['-V'], {
      encoding: 'utf8',
    })
    const m = (stderr || '').match(/--conf-path=(\S+)/)
    if (m) root = path.dirname(m[1])
  } catch {
    /* use default */
  }
  if (process.platform === 'darwin') {
    for (const p of ['/opt/homebrew/etc/nginx', '/usr/local/etc/nginx']) {
      try {
        await fs.access(path.join(p, 'nginx.conf'))
        return p
      } catch {
        /* continue */
      }
    }
  }
  return root
}

type VhostEntry = {
  id: string
  name: string
  path: string
  enabled: boolean
  layout: 'debian' | 'confd'
}

async function listVhosts(root: string): Promise<{
  layout: 'debian' | 'confd'
  vhosts: VhostEntry[]
}> {
  const sitesAvailable = path.join(root, 'sites-available')
  const sitesEnabled = path.join(root, 'sites-enabled')
  const confD = path.join(root, 'conf.d')

  try {
    await fs.access(sitesAvailable)
    const names = await fs.readdir(sitesAvailable)
    const vhosts: VhostEntry[] = []
    for (const name of names) {
      if (!isSafeBasename(name)) continue
      const full = path.join(sitesAvailable, name)
      const st = await fs.stat(full).catch(() => null)
      if (!st?.isFile()) continue
      let enabled = false
      const enPath = path.join(sitesEnabled, name)
      try {
        await fs.lstat(enPath)
        enabled = true
      } catch {
        enabled = false
      }
      vhosts.push({
        id: name,
        name,
        path: full,
        enabled,
        layout: 'debian',
      })
    }
    return { layout: 'debian', vhosts }
  } catch {
    /* fall through */
  }

  try {
    await fs.access(confD)
    const names = await fs.readdir(confD)
    const vhosts: VhostEntry[] = []
    for (const name of names) {
      if (!name.endsWith('.conf')) continue
      if (!isSafeBasename(name)) continue
      const full = path.join(confD, name)
      const st = await fs.stat(full).catch(() => null)
      if (!st?.isFile()) continue
      vhosts.push({
        id: name,
        name,
        path: full,
        enabled: true,
        layout: 'confd',
      })
    }
    vhosts.sort((a, b) => a.name.localeCompare(b.name))
    return { layout: 'confd', vhosts }
  } catch {
    return { layout: 'confd', vhosts: [] }
  }
}

/** Resolve a vhost id to a file path (sites-available first, then conf.d). */
async function resolveVhostPathFlexible(
  root: string,
  id: string,
): Promise<string | null> {
  if (!isSafeBasename(id)) return null
  const p1 = path.join(root, 'sites-available', id)
  try {
    const st = await fs.stat(p1)
    if (st.isFile()) return p1
  } catch {
    /* try conf.d */
  }
  const confName = id.endsWith('.conf') ? id : `${id}.conf`
  if (!isSafeBasename(confName)) return null
  const p2 = path.join(root, 'conf.d', confName)
  try {
    const st = await fs.stat(p2)
    if (st.isFile()) return p2
  } catch {
    return null
  }
  return null
}

async function detectLayoutForCreate(root: string): Promise<'debian' | 'confd'> {
  try {
    await fs.access(path.join(root, 'sites-available'))
    return 'debian'
  } catch {
    return 'confd'
  }
}

/** Shell command to install nginx (run in interactive terminal; uses sudo on Linux). */
export async function getNginxInstallCommand(): Promise<{
  command: string | null
  error?: string
  hint?: string
}> {
  if (process.platform === 'win32') {
    return {
      command: null,
      error:
        'Automatic command is not generated for Windows. Install nginx (e.g. winget or installer), ensure it is on PATH, then refresh.',
      hint: 'Example: winget install nginx',
    }
  }
  if (process.platform === 'darwin') {
    return {
      command:
        'command -v brew >/dev/null 2>&1 && brew install nginx || echo "Install Homebrew first: https://brew.sh"',
      hint: 'Runs in the in-app terminal; type your macOS password if prompted.',
    }
  }
  try {
    const rel = await fs.readFile('/etc/os-release', 'utf8')
    if (
      /\bID=\s*"?ubuntu"?/i.test(rel) ||
      /\bID=\s*"?debian"?/i.test(rel) ||
      /ID_LIKE=.*debian/i.test(rel)
    ) {
      return {
        command:
          "sudo sh -c 'export DEBIAN_FRONTEND=noninteractive && apt-get update && apt-get install -y nginx'",
        hint: 'Enter your sudo password in the terminal when prompted.',
      }
    }
    if (/fedora|rhel|centos|rocky|almalinux/i.test(rel)) {
      return {
        command:
          "sudo sh -c '(command -v dnf >/dev/null 2>&1 && dnf install -y nginx) || yum install -y nginx'",
        hint: 'Enter your sudo password in the terminal when prompted.',
      }
    }
    return {
      command: null,
      error:
        'Could not detect apt or dnf/yum. Install nginx with your package manager, then refresh.',
    }
  } catch {
    return {
      command: null,
      error: 'Could not read /etc/os-release. Install nginx manually.',
    }
  }
}

async function getNginxUninstallCommand(): Promise<{
  command: string | null
  error?: string
  hint?: string
}> {
  if (process.platform === 'win32') {
    return {
      command: null,
      error:
        'Automatic uninstall is not generated for Windows. Remove nginx from Apps, or use winget / your installer, then refresh.',
    }
  }
  if (process.platform === 'darwin') {
    return {
      command:
        '(brew services stop nginx 2>/dev/null; command -v brew >/dev/null 2>&1 && brew uninstall nginx) || echo "nginx may not be from Homebrew — remove it manually."',
      hint: 'Runs in the in-app terminal. Stops the service when managed by Homebrew.',
    }
  }
  try {
    const rel = await fs.readFile('/etc/os-release', 'utf8')
    if (
      /\bID=\s*"?ubuntu"?/i.test(rel) ||
      /\bID=\s*"?debian"?/i.test(rel) ||
      /ID_LIKE=.*debian/i.test(rel)
    ) {
      return {
        command:
          "sudo sh -c 'export DEBIAN_FRONTEND=noninteractive && apt-get remove --purge -y nginx nginx-common nginx-core 2>/dev/null || apt-get remove --purge -y nginx nginx-common'",
        hint: 'Purges nginx packages. Enter sudo password in the terminal. Then click Refresh on this page.',
      }
    }
    if (/fedora|rhel|centos|rocky|almalinux/i.test(rel)) {
      return {
        command:
          "sudo sh -c '(command -v dnf >/dev/null 2>&1 && dnf remove -y nginx) || yum remove -y nginx'",
        hint: 'Removes nginx. Then refresh this page.',
      }
    }
    return {
      command: null,
      error: 'Could not detect package manager. Uninstall nginx manually, then refresh.',
    }
  } catch {
    return {
      command: null,
      error: 'Could not read /etc/os-release. Uninstall nginx manually.',
    }
  }
}

async function restartNginx(): Promise<{ ok: boolean; message: string }> {
  if (process.platform === 'darwin') {
    try {
      await execFileAsync('brew', ['services', 'restart', 'nginx'], {
        encoding: 'utf8',
      })
      return { ok: true, message: 'nginx restarted (brew services).' }
    } catch (e) {
      const err = e as { stderr?: string; message?: string }
      try {
        await execFileAsync('nginx', ['-s', 'reload'], { encoding: 'utf8' })
        return { ok: true, message: 'nginx reload signal sent.' }
      } catch {
        return {
          ok: false,
          message: err.stderr || err.message || 'Restart failed on macOS.',
        }
      }
    }
  }
  try {
    await execFileAsync('systemctl', ['restart', 'nginx'], { encoding: 'utf8' })
    return { ok: true, message: 'nginx restarted (systemctl).' }
  } catch {
    try {
      await execFileAsync('service', ['nginx', 'restart'], { encoding: 'utf8' })
      return { ok: true, message: 'nginx restarted (service).' }
    } catch (e) {
      const err = e as { stderr?: string; message?: string }
      return {
        ok: false,
        message:
          err.stderr ||
          err.message ||
          'Restart failed. Try: sudo systemctl restart nginx',
      }
    }
  }
}

function nginxTestLooksLikePermissionFailure(stdout: string, stderr: string): boolean {
  const t = `${stderr}\n${stdout}`.toLowerCase()
  return (
    t.includes('permission denied') ||
    t.includes('(13:') ||
    t.includes('eacces') ||
    t.includes('operation not permitted')
  )
}

async function testNginx(sudoPassword?: string): Promise<{
  ok: boolean
  stdout: string
  stderr: string
  needsElevation?: boolean
}> {
  const runPlain = async () => {
    try {
      const { stdout, stderr } = await execFileAsync('nginx', ['-t'], {
        encoding: 'utf8',
      })
      return {
        ok: true as const,
        stdout: stdout || '',
        stderr: stderr || '',
      }
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number }
      return {
        ok: false as const,
        stdout: err.stdout || '',
        stderr: err.stderr || '',
      }
    }
  }

  const first = await runPlain()
  if (first.ok) {
    return first
  }

  const needRoot =
    process.platform !== 'win32' && nginxTestLooksLikePermissionFailure(first.stdout, first.stderr)

  if (!needRoot) {
    return first
  }

  if (!sudoPassword) {
    return {
      ...first,
      needsElevation: true,
    }
  }

  try {
    const r = await execWithSudo(sudoPassword, 'nginx', ['-t'])
    return {
      ok: r.exitCode === 0,
      stdout: r.stdout,
      stderr: r.stderr,
    }
  } catch (e) {
    return {
      ok: false,
      stdout: '',
      stderr: (e as Error).message,
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

async function handleNginxApi(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
): Promise<void> {
  const method = req.method || 'GET'

  if (segments.length === 1 && segments[0] === 'status' && method === 'GET') {
    const versionLine = await nginxVersionLine()
    const installed = Boolean(versionLine)
    const root = installed ? await resolveNginxRoot() : ''
    let layout: 'debian' | 'confd' | 'none' = 'none'
    let vhosts: VhostEntry[] = []
    if (installed && root) {
      const listed = await listVhosts(root)
      vhosts = listed.vhosts
      layout = listed.vhosts.length
        ? listed.layout
        : await detectLayoutForCreate(root)
    }
    sendJson(res, 200, {
      installed,
      version: versionLine,
      configRoot: root || null,
      layout,
      vhosts,
      platform: process.platform,
    })
    return
  }

  if (segments.length === 1 && segments[0] === 'install-command' && method === 'GET') {
    const ic = await getNginxInstallCommand()
    if (ic.command) {
      sendJson(res, 200, { command: ic.command, hint: ic.hint })
    } else {
      sendJson(res, 400, { error: ic.error, hint: ic.hint })
    }
    return
  }

  if (segments.length === 1 && segments[0] === 'uninstall-command' && method === 'GET') {
    const uc = await getNginxUninstallCommand()
    if (uc.command) {
      sendJson(res, 200, { command: uc.command, hint: uc.hint })
    } else {
      sendJson(res, 400, { error: uc.error, hint: uc.hint })
    }
    return
  }

  if (segments.length === 1 && segments[0] === 'restart' && method === 'POST') {
    const r = await restartNginx()
    sendJson(res, r.ok ? 200 : 500, r)
    return
  }

  if (segments.length === 1 && segments[0] === 'test' && method === 'POST') {
    const raw = await readBody(req)
    let sudoPassword: string | undefined
    if (raw.trim()) {
      try {
        const b = JSON.parse(raw) as { sudoPassword?: string }
        if (typeof b.sudoPassword === 'string') sudoPassword = b.sudoPassword
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' })
        return
      }
    }
    const t = await testNginx(sudoPassword)
    if (t.needsElevation) {
      sendJson(res, 403, {
        ok: false,
        stdout: t.stdout,
        stderr: t.stderr,
        code: 'EACCES',
        needsElevation: true,
        error:
          'nginx -t tried to open root-only paths (e.g. /run/nginx.pid). Enter your password to run the test with sudo.',
      })
      return
    }
    const sudoRejected =
      Boolean(sudoPassword) &&
      !t.ok &&
      /sorry|incorrect password|authentication failure|no password was provided|a password is required/i.test(
        t.stderr,
      )
    if (sudoRejected) {
      sendJson(res, 403, {
        ok: false,
        stdout: t.stdout,
        stderr: t.stderr,
        code: 'ELEVATION_FAILED',
        error: t.stderr.trim() || 'sudo did not accept the password.',
      })
      return
    }
    sendJson(res, 200, {
      ok: t.ok,
      stdout: t.stdout,
      stderr: t.stderr,
    })
    return
  }

  if (segments[0] === 'vhosts') {
    const versionLine = await nginxVersionLine()
    if (!versionLine) {
      sendJson(res, 400, { error: 'nginx is not installed' })
      return
    }
    const root = await resolveNginxRoot()
    const { layout, vhosts } = await listVhosts(root)

    if (segments.length === 1 && method === 'GET') {
      sendJson(res, 200, { configRoot: root, layout, vhosts })
      return
    }

    if (segments.length === 2) {
      const id = decodeURIComponent(segments[1])
      const filePath = await resolveVhostPathFlexible(root, id)
      if (!filePath) {
        sendJson(res, 404, { error: 'Virtual host not found' })
        return
      }
      if (method === 'GET') {
        const rd = await readFileMaybeElevated(filePath, root, undefined)
        if (rd.ok === false) {
          sendJson(res, rd.httpStatus, {
            error: rd.error,
            code: rd.code,
            ...(rd.needsElevation ? { needsElevation: true } : {}),
          })
          return
        }
        sendJson(res, 200, {
          id,
          path: filePath,
          content: rd.content,
        })
        return
      }
      if (method === 'POST') {
        const raw = await readBody(req)
        let sudoPassword: string | undefined
        if (raw.trim()) {
          try {
            const b = JSON.parse(raw) as { sudoPassword?: string }
            if (typeof b.sudoPassword === 'string') sudoPassword = b.sudoPassword
          } catch {
            sendJson(res, 400, { error: 'Invalid JSON body' })
            return
          }
        }
        const rd = await readFileMaybeElevated(filePath, root, sudoPassword)
        if (rd.ok === false) {
          sendJson(res, rd.httpStatus, {
            error: rd.error,
            code: rd.code,
            ...(rd.needsElevation ? { needsElevation: true } : {}),
          })
          return
        }
        sendJson(res, 200, {
          id,
          path: filePath,
          content: rd.content,
        })
        return
      }
      if (method === 'PUT') {
        const raw = await readBody(req)
        let body: { content?: string; sudoPassword?: string }
        try {
          body = JSON.parse(raw) as { content?: string; sudoPassword?: string }
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON' })
          return
        }
        if (typeof body.content !== 'string') {
          sendJson(res, 400, { error: 'Expected { "content": string }' })
          return
        }
        const sudoPassword =
          typeof body.sudoPassword === 'string' ? body.sudoPassword : undefined
        const wr = await writeFileMaybeElevated(
          filePath,
          body.content,
          root,
          sudoPassword,
        )
        if (wr.ok === false) {
          sendJson(res, wr.httpStatus, {
            error: wr.error,
            code: wr.code,
            ...(wr.needsElevation ? { needsElevation: true } : {}),
          })
          return
        }
        sendJson(res, 200, { ok: true, path: filePath })
        return
      }
      if (method === 'DELETE') {
        const raw = await readBody(req)
        let sudoPassword: string | undefined
        if (raw.trim()) {
          try {
            const b = JSON.parse(raw) as { sudoPassword?: string }
            if (typeof b.sudoPassword === 'string') sudoPassword = b.sudoPassword
          } catch {
            sendJson(res, 400, { error: 'Invalid JSON body' })
            return
          }
        }
        const del = await removeVhostConfigFile(root, filePath, sudoPassword)
        if (del.ok === false) {
          sendJson(res, del.httpStatus, {
            error: del.error,
            code: del.code,
            ...(del.needsElevation ? { needsElevation: true } : {}),
          })
          return
        }
        sendJson(res, 200, { ok: true, id, path: filePath })
        return
      }
    }

    if (segments.length === 1 && method === 'POST') {
      const raw = await readBody(req)
      let body: { name?: string; content?: string; sudoPassword?: string }
      try {
        body = JSON.parse(raw) as { name?: string; content?: string; sudoPassword?: string }
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' })
        return
      }
      const nameRaw = typeof body.name === 'string' ? body.name.trim() : ''
      if (!nameRaw) {
        sendJson(res, 400, { error: 'name is required' })
        return
      }
      const sudoPassword =
        typeof body.sudoPassword === 'string' ? body.sudoPassword : undefined
      const createLayout = await detectLayoutForCreate(root)
      let baseName = nameRaw
      if (createLayout === 'confd' && !baseName.endsWith('.conf')) {
        baseName = `${baseName}.conf`
      }
      if (!isSafeBasename(baseName)) {
        sendJson(res, 400, {
          error: 'Invalid name (use letters, numbers, dot, underscore, hyphen only)',
        })
        return
      }
      const dir =
        createLayout === 'debian'
          ? path.join(root, 'sites-available')
          : path.join(root, 'conf.d')
      const md = await mkdirMaybeElevated(dir, root, sudoPassword)
      if (md.ok === false) {
        sendJson(res, md.httpStatus, {
          error: md.error,
          code: md.code,
          ...(md.needsElevation ? { needsElevation: true } : {}),
        })
        return
      }
      const filePath = path.join(dir, baseName)
      try {
        await fs.access(filePath)
        sendJson(res, 409, { error: 'File already exists' })
        return
      } catch {
        /* good */
      }
      const defaultContent =
        typeof body.content === 'string'
          ? body.content
          : `server {
    listen 80;
    server_name localhost;
    root /var/www/html;
    index index.html;
}
`
      const wr = await writeFileMaybeElevated(
        filePath,
        defaultContent,
        root,
        sudoPassword,
      )
      if (wr.ok === false) {
        sendJson(res, wr.httpStatus, {
          error: wr.error,
          code: wr.code,
          ...(wr.needsElevation ? { needsElevation: true } : {}),
        })
        return
      }
      if (createLayout === 'debian') {
        const en = await enableDebianStyleVhostSite(root, baseName, sudoPassword)
        if (en.ok === false) {
          await unlinkMaybeElevated(filePath, root, sudoPassword)
          sendJson(res, en.httpStatus, {
            error: en.error,
            code: en.code,
            ...(en.needsElevation ? { needsElevation: true } : {}),
          })
          return
        }
      }
      sendJson(res, 201, {
        ok: true,
        id: baseName,
        path: filePath,
        layout: createLayout,
        enabled: true,
      })
      return
    }
  }

  sendJson(res, 404, { error: 'Not found' })
}

function parseSegments(url: string): string[] | null {
  const pathOnly = url.split('?')[0] || ''
  if (!pathOnly.startsWith('/api/nginx')) return null
  const rest = pathOnly.slice('/api/nginx'.length).replace(/^\//, '')
  if (!rest) return []
  return rest.split('/').map((s) => decodeURIComponent(s))
}

function nginxApiMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url?.split('?')[0] ?? ''
    const segments = parseSegments(url)
    if (segments === null) {
      next()
      return
    }
    void handleNginxApi(req, res, segments)
  }
}

export function nginxApiPlugin() {
  return {
    name: 'dev-manager-nginx-api',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(nginxApiMiddleware())
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(nginxApiMiddleware())
    },
  }
}

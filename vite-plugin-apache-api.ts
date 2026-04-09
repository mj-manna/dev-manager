import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { Connect } from 'vite'
import {
  enableDebianStyleVhostSite,
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

type ApacheKind = 'apache2' | 'httpd'

async function detectApache(): Promise<{ versionLine: string; kind: ApacheKind } | null> {
  for (const bin of ['apache2', 'httpd'] as const) {
    try {
      const { stderr, stdout } = await execFileAsync(bin, ['-v'], {
        encoding: 'utf8',
      })
      const line = (stderr || stdout || '').trim().split('\n')[0]
      if (line) {
        return { versionLine: line, kind: bin }
      }
    } catch {
      /* try next */
    }
  }
  return null
}

async function httpdRootFromV(kind: ApacheKind): Promise<string | null> {
  const tryBins =
    kind === 'apache2'
      ? (['apache2ctl', 'apachectl', 'httpd'] as const)
      : (['apachectl', 'httpd', 'apache2ctl'] as const)
  for (const bin of tryBins) {
    try {
      const { stderr, stdout } = await execFileAsync(bin, ['-V'], {
        encoding: 'utf8',
      })
      const m = (stderr + stdout).match(/HTTPD_ROOT="([^"]+)"/)
      if (m) return m[1]
    } catch {
      /* next */
    }
  }
  return null
}

async function resolveApacheRoot(kind: ApacheKind): Promise<string> {
  const fromV = await httpdRootFromV(kind)
  if (fromV) return fromV
  return kind === 'apache2' ? '/etc/apache2' : '/etc/httpd'
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

async function getApacheInstallCommand(): Promise<{
  command: string | null
  error?: string
  hint?: string
}> {
  if (process.platform === 'win32') {
    return {
      command: null,
      error:
        'Automatic command is not generated for Windows. Install Apache (e.g. XAMPP or official builds), ensure httpd is on PATH, then refresh.',
      hint: 'Or use WSL and install apache2 there.',
    }
  }
  if (process.platform === 'darwin') {
    return {
      command:
        'command -v brew >/dev/null 2>&1 && brew install httpd || echo "Install Homebrew first: https://brew.sh"',
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
          "sudo sh -c 'export DEBIAN_FRONTEND=noninteractive && apt-get update && apt-get install -y apache2'",
        hint: 'Enter your sudo password in the terminal when prompted.',
      }
    }
    if (/fedora|rhel|centos|rocky|almalinux/i.test(rel)) {
      return {
        command:
          "sudo sh -c '(command -v dnf >/dev/null 2>&1 && dnf install -y httpd) || yum install -y httpd'",
        hint: 'Enter your sudo password in the terminal when prompted.',
      }
    }
    return {
      command: null,
      error:
        'Could not detect apt or dnf/yum. Install apache2 or httpd with your package manager, then refresh.',
    }
  } catch {
    return {
      command: null,
      error: 'Could not read /etc/os-release. Install Apache manually.',
    }
  }
}

async function getApacheUninstallCommand(): Promise<{
  command: string | null
  error?: string
  hint?: string
}> {
  if (process.platform === 'win32') {
    return {
      command: null,
      error:
        'Automatic uninstall is not generated for Windows. Remove Apache/XAMPP from your system, then refresh.',
    }
  }
  if (process.platform === 'darwin') {
    return {
      command:
        '(brew services stop httpd 2>/dev/null; command -v brew >/dev/null 2>&1 && brew uninstall httpd) || echo "httpd may not be from Homebrew — remove it manually."',
      hint: 'Runs in the in-app terminal. Then refresh this page.',
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
          "sudo sh -c 'export DEBIAN_FRONTEND=noninteractive && apt-get remove --purge -y apache2 apache2-utils apache2-bin 2>/dev/null || apt-get remove --purge -y apache2 apache2-utils'",
        hint: 'Purges Apache packages. Enter sudo password in the terminal. Then click Refresh.',
      }
    }
    if (/fedora|rhel|centos|rocky|almalinux/i.test(rel)) {
      return {
        command: "sudo sh -c '(command -v dnf >/dev/null 2>&1 && dnf remove -y httpd) || yum remove -y httpd'",
        hint: 'Removes httpd. Then refresh this page.',
      }
    }
    return {
      command: null,
      error: 'Could not detect package manager. Uninstall Apache manually, then refresh.',
    }
  } catch {
    return {
      command: null,
      error: 'Could not read /etc/os-release. Uninstall Apache manually.',
    }
  }
}

async function restartApache(kind: ApacheKind): Promise<{ ok: boolean; message: string }> {
  if (process.platform === 'darwin') {
    try {
      await execFileAsync('brew', ['services', 'restart', 'httpd'], {
        encoding: 'utf8',
      })
      return { ok: true, message: 'httpd restarted (brew services).' }
    } catch (e) {
      const err = e as { stderr?: string; message?: string }
      try {
        await execFileAsync('apachectl', ['restart'], { encoding: 'utf8' })
        return { ok: true, message: 'apachectl restart completed.' }
      } catch {
        return {
          ok: false,
          message: err.stderr || err.message || 'Restart failed on macOS.',
        }
      }
    }
  }
  const unit = kind === 'apache2' ? 'apache2' : 'httpd'
  try {
    await execFileAsync('systemctl', ['restart', unit], { encoding: 'utf8' })
    return { ok: true, message: `${unit} restarted (systemctl).` }
  } catch {
    try {
      await execFileAsync('service', [unit, 'restart'], { encoding: 'utf8' })
      return { ok: true, message: `${unit} restarted (service).` }
    } catch (e) {
      const err = e as { stderr?: string; message?: string }
      const hint = kind === 'apache2' ? 'apache2' : 'httpd'
      return {
        ok: false,
        message:
          err.stderr ||
          err.message ||
          `Restart failed. Try: sudo systemctl restart ${hint}`,
      }
    }
  }
}

async function testApache(kind: ApacheKind): Promise<{
  ok: boolean
  stdout: string
  stderr: string
}> {
  const order =
    kind === 'apache2'
      ? (['apache2ctl', 'apachectl', 'httpd'] as const)
      : (['apachectl', 'httpd', 'apache2ctl'] as const)
  let lastOut = ''
  let lastErr = ''
  for (const bin of order) {
    const args = bin === 'httpd' ? (['-t'] as const) : (['configtest'] as const)
    try {
      const { stdout, stderr } = await execFileAsync(bin, [...args], {
        encoding: 'utf8',
      })
      return { ok: true, stdout: stdout || '', stderr: stderr || '' }
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string }
      lastOut = err.stdout || ''
      lastErr = err.stderr || ''
    }
  }
  return { ok: false, stdout: lastOut, stderr: lastErr }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

const DEFAULT_VHOST_APACHE = `<VirtualHost *:80>
    ServerName localhost
    DocumentRoot /var/www/html

    <Directory /var/www/html>
        AllowOverride All
        Require all granted
    </Directory>
</VirtualHost>
`

async function handleApacheApi(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
): Promise<void> {
  const method = req.method || 'GET'

  if (segments.length === 1 && segments[0] === 'status' && method === 'GET') {
    const det = await detectApache()
    const installed = Boolean(det)
    const kind = det?.kind ?? 'apache2'
    const root = installed ? await resolveApacheRoot(kind) : ''
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
      version: det?.versionLine ?? null,
      kind: installed ? kind : null,
      configRoot: root || null,
      layout,
      vhosts,
      platform: process.platform,
    })
    return
  }

  if (segments.length === 1 && segments[0] === 'install-command' && method === 'GET') {
    const ic = await getApacheInstallCommand()
    if (ic.command) {
      sendJson(res, 200, { command: ic.command, hint: ic.hint })
    } else {
      sendJson(res, 400, { error: ic.error, hint: ic.hint })
    }
    return
  }

  if (segments.length === 1 && segments[0] === 'uninstall-command' && method === 'GET') {
    const uc = await getApacheUninstallCommand()
    if (uc.command) {
      sendJson(res, 200, { command: uc.command, hint: uc.hint })
    } else {
      sendJson(res, 400, { error: uc.error, hint: uc.hint })
    }
    return
  }

  if (segments.length === 1 && segments[0] === 'restart' && method === 'POST') {
    const det = await detectApache()
    if (!det) {
      sendJson(res, 400, { ok: false, message: 'Apache (apache2/httpd) is not installed' })
      return
    }
    const r = await restartApache(det.kind)
    sendJson(res, r.ok ? 200 : 500, r)
    return
  }

  if (segments.length === 1 && segments[0] === 'test' && method === 'POST') {
    const det = await detectApache()
    if (!det) {
      sendJson(res, 200, {
        ok: false,
        stdout: '',
        stderr: 'Apache (apache2/httpd) is not installed',
      })
      return
    }
    const t = await testApache(det.kind)
    sendJson(res, 200, t)
    return
  }

  if (segments[0] === 'vhosts') {
    const det = await detectApache()
    if (!det) {
      sendJson(res, 400, { error: 'Apache is not installed' })
      return
    }
    const root = await resolveApacheRoot(det.kind)
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
        typeof body.content === 'string' ? body.content : DEFAULT_VHOST_APACHE
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
  if (!pathOnly.startsWith('/api/apache')) return null
  const rest = pathOnly.slice('/api/apache'.length).replace(/^\//, '')
  if (!rest) return []
  return rest.split('/').map((s) => decodeURIComponent(s))
}

function apacheApiMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url?.split('?')[0] ?? ''
    const segments = parseSegments(url)
    if (segments === null) {
      next()
      return
    }
    void handleApacheApi(req, res, segments)
  }
}

export function apacheApiPlugin() {
  return {
    name: 'dev-manager-apache-api',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(apacheApiMiddleware())
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(apacheApiMiddleware())
    },
  }
}

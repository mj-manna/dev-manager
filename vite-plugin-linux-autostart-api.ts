import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect } from 'vite'
import type { ResolvedConfig } from 'vite'

const DESKTOP_BASENAME = 'dev-manager.desktop'
const AUTOSTART_MARKER = 'X-DevManager-Autostart=v1'
const PROJECT_ROOT_KEY = 'X-DevManager-ProjectRoot='

export type LinuxAutostartSlotSnapshot = {
  groupName: string
  label: string
  cwd: string
  command: string
  siteUrl?: string
  environment: string
}

export type LinuxAutostartSnapshotFile = {
  version: 1
  writtenAt: string
  projectRoot: string
  devCommand: string
  appOrigin: string
  openBrowser: boolean
  deploymentSlots: LinuxAutostartSlotSnapshot[]
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
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

function autostartPaths() {
  const home = os.homedir()
  return {
    autostartDir: path.join(home, '.config', 'autostart'),
    appConfigDir: path.join(home, '.config', 'dev-manager'),
    desktopPath: path.join(home, '.config', 'autostart', DESKTOP_BASENAME),
    snapshotPath: path.join(home, '.config', 'dev-manager', 'autostart-snapshot.json'),
    launchScriptPath: path.join(home, '.config', 'dev-manager', 'launch-dev-manager.sh'),
  }
}

async function detectDevCommand(projectRoot: string): Promise<string> {
  try {
    await fs.access(path.join(projectRoot, 'pnpm-lock.yaml'))
    return 'pnpm dev'
  } catch {
    /* continue */
  }
  try {
    await fs.access(path.join(projectRoot, 'yarn.lock'))
    return 'yarn dev'
  } catch {
    /* continue */
  }
  return 'npm run dev'
}

const RUN_COMMAND_MAX = 400

/** Returns validated command or an error message. */
function validateRunCommand(raw: string): { ok: true; command: string } | { ok: false; error: string } {
  const t = raw.trim()
  if (!t) return { ok: false, error: 'Run command cannot be empty.' }
  if (t.length > RUN_COMMAND_MAX) {
    return { ok: false, error: `Run command is too long (max ${RUN_COMMAND_MAX} characters).` }
  }
  if (/[\n\r\x00]/.test(t)) {
    return { ok: false, error: 'Run command cannot contain line breaks or null bytes.' }
  }
  return { ok: true, command: t }
}

function resolveRunCommand(
  body: PostBody,
  detected: string,
): { ok: true; command: string } | { ok: false; error: string } {
  if (body.runCommand === undefined || body.runCommand === null) {
    return { ok: true, command: detected }
  }
  if (typeof body.runCommand !== 'string') {
    return { ok: false, error: 'runCommand must be a string.' }
  }
  const trimmed = body.runCommand.trim()
  if (trimmed === '') {
    return { ok: true, command: detected }
  }
  return validateRunCommand(trimmed)
}

function parseDesktopProjectRoot(content: string): string | null {
  const line = content.split('\n').find((l) => l.trimStart().startsWith(PROJECT_ROOT_KEY))
  if (!line) return null
  const v = line.slice(line.indexOf(PROJECT_ROOT_KEY) + PROJECT_ROOT_KEY.length).trim()
  return v || null
}

function isOurDesktopFile(content: string): boolean {
  return content.includes(AUTOSTART_MARKER)
}

function shellQuoteSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function buildLaunchScript(opts: {
  projectRoot: string
  devCommand: string
  appOrigin: string
  openBrowser: boolean
}): string {
  const { projectRoot, devCommand, appOrigin, openBrowser } = opts
  const cd = shellQuoteSingle(projectRoot)
  const origin = shellQuoteSingle(appOrigin)
  const openBlock = openBrowser
    ? `( sleep 8 && command -v xdg-open >/dev/null 2>&1 && xdg-open ${origin} >/dev/null 2>&1 ) &\n`
    : ''
  return `#!/usr/bin/env bash
set -euo pipefail
cd ${cd} || exit 1
${openBlock}exec ${devCommand}
`
}

function buildDesktopEntry(launchScriptPath: string, projectRoot: string): string {
  const execPath = shellQuoteSingle(launchScriptPath)
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=Dev Manager
Comment=Start the Dev Manager Vite dev server after login (${projectRoot})
Exec=/usr/bin/env bash ${execPath}
Icon=applications-development
Terminal=false
Categories=Development;
StartupNotify=false
${AUTOSTART_MARKER}
${PROJECT_ROOT_KEY}${projectRoot}
`
}

type PostBody = {
  enabled?: boolean
  openBrowser?: boolean
  /** If omitted or blank, the lockfile-detected command is used. */
  runCommand?: string | null
  snapshot?: {
    deploymentSlots?: LinuxAutostartSlotSnapshot[]
  }
}

export function linuxAutostartApiPlugin() {
  let serverPort = 9999

  async function handleGet(
    res: ServerResponse,
    projectRoot: string,
    appOrigin: string,
  ): Promise<void> {
    if (process.platform !== 'linux') {
      sendJson(res, 200, {
        supported: false,
        platform: process.platform,
        configured: false,
      })
      return
    }

    const { desktopPath, snapshotPath, launchScriptPath, appConfigDir } = autostartPaths()
    let desktopContent = ''
    let desktopExists = false
    try {
      desktopContent = await fs.readFile(desktopPath, 'utf8')
      desktopExists = true
    } catch {
      desktopExists = false
    }

    const isOurs = desktopExists && isOurDesktopFile(desktopContent)
    const configured = isOurs
    const configuredProjectRoot = isOurs ? parseDesktopProjectRoot(desktopContent) : null

    let snapshot: LinuxAutostartSnapshotFile | null = null
    try {
      const raw = await fs.readFile(snapshotPath, 'utf8')
      snapshot = JSON.parse(raw) as LinuxAutostartSnapshotFile
    } catch {
      snapshot = null
    }

    const detectedDevCommand = await detectDevCommand(projectRoot)
    const snapshotMatchesProject = Boolean(
      snapshot &&
        typeof snapshot.projectRoot === 'string' &&
        path.resolve(snapshot.projectRoot) === path.resolve(projectRoot),
    )
    let savedRunCommand: string | null = null
    if (snapshotMatchesProject && snapshot) {
      const d = snapshot.devCommand
      if (typeof d === 'string' && d.trim()) savedRunCommand = d.trim()
    }
    const matches =
      !configured ||
      !configuredProjectRoot ||
      path.resolve(configuredProjectRoot) === path.resolve(projectRoot)

    sendJson(res, 200, {
      supported: true,
      platform: 'linux',
      configured,
      matchesCurrentProject: matches,
      desktopFilePath: desktopPath,
      snapshotFilePath: snapshotPath,
      launchScriptPath,
      appConfigDir,
      projectRoot,
      configuredProjectRoot,
      /** @deprecated use detectedDevCommand */
      devCommand: detectedDevCommand,
      detectedDevCommand,
      savedRunCommand,
      appOrigin,
      snapshot,
    })
  }

  async function handlePost(
    req: IncomingMessage,
    res: ServerResponse,
    projectRoot: string,
    appOrigin: string,
  ): Promise<void> {
    if (process.platform !== 'linux') {
      sendJson(res, 400, { error: 'Linux autostart is only available on Linux.' })
      return
    }

    const raw = await readBody(req)
    let body: PostBody
    try {
      body = JSON.parse(raw) as PostBody
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body.' })
      return
    }

    const enabled = body.enabled === true
    const openBrowser = body.openBrowser === true
    const slots = Array.isArray(body.snapshot?.deploymentSlots) ? body.snapshot!.deploymentSlots! : []

    const { autostartDir, appConfigDir, desktopPath, snapshotPath, launchScriptPath } = autostartPaths()
    const detectedDevCommand = await detectDevCommand(projectRoot)
    const resolved = resolveRunCommand(body, detectedDevCommand)
    if (resolved.ok === false) {
      sendJson(res, 400, { error: resolved.error })
      return
    }
    const devCommand = resolved.command

    if (!enabled) {
      try {
        const prev = await fs.readFile(desktopPath, 'utf8').catch(() => '')
        if (prev && isOurDesktopFile(prev)) {
          await fs.unlink(desktopPath)
        }
      } catch {
        /* ignore */
      }
      sendJson(res, 200, { ok: true, enabled: false })
      return
    }

    const snapshotFile: LinuxAutostartSnapshotFile = {
      version: 1,
      writtenAt: new Date().toISOString(),
      projectRoot,
      devCommand,
      appOrigin,
      openBrowser,
      deploymentSlots: slots,
    }

    await fs.mkdir(autostartDir, { recursive: true })
    await fs.mkdir(appConfigDir, { recursive: true })

    const script = buildLaunchScript({ projectRoot, devCommand, appOrigin, openBrowser })
    await fs.writeFile(launchScriptPath, script, { mode: 0o755 })
    await fs.chmod(launchScriptPath, 0o755)

    await fs.writeFile(snapshotPath, JSON.stringify(snapshotFile, null, 2), 'utf8')

    const desktop = buildDesktopEntry(launchScriptPath, projectRoot)
    await fs.writeFile(desktopPath, desktop, 'utf8')

    sendJson(res, 200, {
      ok: true,
      enabled: true,
      desktopFilePath: desktopPath,
      snapshotFilePath: snapshotPath,
      launchScriptPath,
      devCommand,
      appOrigin,
    })
  }

  return {
    name: 'dev-manager-linux-autostart-api',
    configResolved(config: ResolvedConfig) {
      const p = config.server.port
      serverPort = typeof p === 'number' ? p : 5173
    },
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(
        ((req, res, next) => {
          const url = req.url?.split('?')[0] ?? ''
          if (url !== '/api/linux-autostart') {
            next()
            return
          }
          const projectRoot = process.cwd()
          const appOrigin = `http://127.0.0.1:${serverPort}`

          if (req.method === 'GET') {
            void handleGet(res, projectRoot, appOrigin)
            return
          }
          if (req.method === 'POST') {
            void handlePost(req, res, projectRoot, appOrigin)
            return
          }
          res.statusCode = 405
          res.setHeader('Allow', 'GET, POST')
          res.end()
        }) as Connect.NextHandleFunction,
      )
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(
        ((req, res, next) => {
          const url = req.url?.split('?')[0] ?? ''
          if (url !== '/api/linux-autostart') {
            next()
            return
          }
          const projectRoot = process.cwd()
          const appOrigin = `http://127.0.0.1:${serverPort}`

          if (req.method === 'GET') {
            void handleGet(res, projectRoot, appOrigin)
            return
          }
          if (req.method === 'POST') {
            void handlePost(req, res, projectRoot, appOrigin)
            return
          }
          res.statusCode = 405
          res.setHeader('Allow', 'GET, POST')
          res.end()
        }) as Connect.NextHandleFunction,
      )
    },
  }
}

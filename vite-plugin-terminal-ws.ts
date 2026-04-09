import { createRequire } from 'node:module'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'

/** Keep in sync with `src/terminal/constants.ts`. */
const TERMINAL_WS_PATH = '/__terminal/ws'

const nodeRequire = createRequire(import.meta.url)

type PtyMod = {
  spawn: (
    file: string,
    args: string[],
    options: Record<string, unknown>,
  ) => {
    onData: (cb: (data: string) => void) => void
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void
    write: (data: string) => void
    resize: (cols: number, rows: number) => void
    kill: () => void
  }
}

function loadNodePty(): PtyMod | null {
  try {
    return nodeRequire('node-pty') as PtyMod
  } catch {
    return null
  }
}

type ClientMsg =
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'input'; data: string }
  | { type: 'run'; command: string }

function sendControl(ws: WebSocket, payload: object) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload))
}

/**
 * GNU `ls` / tree-style colors when ~/.bashrc is skipped or does not set LS_COLORS.
 * (Keeps directories, symlinks, archives, executables visually distinct.)
 */
const DEFAULT_LS_COLORS =
  'rs=0:di=01;34:ln=01;36:mh=00:pi=40;33:so=01;35:do=01;35:bd=40;33;01:cd=40;33;01:or=40;31;01:mi=00:su=37;41:sg=30;43:ca=30;41:tw=30;42:ow=34;42:st=37;44:ex=01;32:*.tar=01;31:*.tgz=01;31:*.zip=01;31:*.zst=01;31:*.7z=01;31:*.jpg=01;35:*.png=01;35:*.mp4=01;35'

/** BSD `ls` on macOS (GNU `ls` ignores this). */
const DEFAULT_LSCOLORS = 'ExGxBxDxCxEgEdxbxgxcxd'

/** Use util-linux `script` to put bash on a real PTY while we talk over pipes → WebSocket (sudo stays out of the IDE terminal). */
function scriptBridgeCommand(): { cmd: string; args: string[] } | null {
  if (process.platform === 'win32') return null
  if (process.platform === 'darwin') {
    return {
      cmd: 'script',
      args: ['-q', '/dev/null', '/bin/bash', '-i'],
    }
  }
  return {
    cmd: 'script',
    args: ['-q', '-e', '-c', 'exec bash -i', '/dev/null'],
  }
}

function spawnPiped(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ChildProcessWithoutNullStreams | null> {
  return new Promise((resolve) => {
    const c = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd,
      detached: false,
    }) as ChildProcessWithoutNullStreams
    c.once('error', () => resolve(null))
    c.once('spawn', () => resolve(c))
  })
}

function resolveSessionCwd(cwdQuery: string | null): string {
  const fallback = process.env.HOME || process.cwd()
  if (!cwdQuery || !cwdQuery.trim()) return fallback
  const resolved = path.resolve(cwdQuery.trim())
  try {
    const st = fs.statSync(resolved)
    if (st.isDirectory()) return resolved
  } catch {
    /* invalid path */
  }
  return fallback
}

async function bindTerminalSession(ws: WebSocket, cwdFromClient: string | null) {
  let cols = 80
  let rows = 24
  let ptyProc: ReturnType<PtyMod['spawn']> | null = null
  let child: ChildProcessWithoutNullStreams | null = null

  const cleanup = () => {
    try {
      ptyProc?.kill()
    } catch {
      /* ignore */
    }
    ptyProc = null
    try {
      child?.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    child = null
  }

  const shellEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    DEV_MANAGER_EMBEDDED_SHELL: '1',
    /** Node, vitest, chalk, etc. */
    FORCE_COLOR: '1',
    /** BSD / macOS `ls` */
    CLICOLOR: '1',
    /** GNU `ls` when not using a distro alias */
    LS_COLORS: process.env.LS_COLORS || DEFAULT_LS_COLORS,
    LSCOLORS: process.env.LSCOLORS || DEFAULT_LSCOLORS,
    /** `grep --color` default highlights */
    GREP_COLORS: process.env.GREP_COLORS || 'mt=01;31:sl=:cx=:fn=35:ln=32:bn=32:se=36',
  }
  /* Parent process (e.g. CI or user shell) may set NO_COLOR; re-enable ANSI in the panel. */
  delete shellEnv.NO_COLOR
  const cwd = resolveSessionCwd(cwdFromClient)

  const attachPromise = (async () => {
    const ptyMod = loadNodePty()
    if (ptyMod) {
      try {
        const shell =
          process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash'
        const args = process.platform === 'win32' ? ['-NoLogo'] : ['-il']
        ptyProc = ptyMod.spawn(shell, args, {
          name: 'xterm-256color',
          cols: Math.max(2, cols),
          rows: Math.max(1, rows),
          cwd,
          env: shellEnv as Record<string, string>,
        })
        ptyProc.onData((d) => {
          if (ws.readyState === 1) ws.send(Buffer.from(d, 'utf8'), { binary: true })
        })
        ptyProc.onExit(({ exitCode, signal }) => {
          sendControl(ws, { type: 'exit', exitCode, signal })
          ws.close()
        })
        sendControl(ws, {
          type: 'ready',
          backend: 'pty',
          message:
            'Full PTY via node-pty — sudo/password prompts stay in this panel, not your dev terminal.',
        })
        return
      } catch {
        ptyProc = null
      }
    }

    let usedScriptBridge = false
    if (process.platform === 'win32') {
      child = await spawnPiped('powershell.exe', ['-NoLogo'], shellEnv, cwd)
    } else {
      const bridge = scriptBridgeCommand()
      if (bridge) {
        const bridged = await spawnPiped(bridge.cmd, bridge.args, shellEnv, cwd)
        if (bridged) {
          child = bridged
          usedScriptBridge = true
        }
      }
      if (!child) {
        child = await spawnPiped('bash', ['-i'], shellEnv, cwd)
      }
    }

    if (!child) {
      sendControl(ws, {
        type: 'error',
        message: 'Could not start a shell subprocess.',
      })
      ws.close()
      return
    }

    try {
      child.stdin.setDefaultEncoding('utf8')
    } catch {
      /* ignore */
    }
    child.on('error', (err) => {
      sendControl(ws, {
        type: 'error',
        message: err.message,
      })
    })
    const forward = (buf: Buffer) => {
      if (ws.readyState === 1) ws.send(buf, { binary: true })
    }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.on('exit', (code, signal) => {
      sendControl(ws, { type: 'exit', exitCode: code, signal })
      ws.close()
    })

    sendControl(ws, {
      type: 'ready',
      backend: usedScriptBridge ? 'script' : 'pipe',
      message: usedScriptBridge
        ? 'Separate PTY via `script` — sudo/password prompts stay in this panel, not the terminal running Vite/Bun.'
        : 'Plain piped shell (no PTY). `sudo` may still open the dev terminal. Install `node-pty` or the `script` utility (util-linux).',
    })
  })()

  ws.on('message', async (data) => {
    try {
      await attachPromise
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
      let msg: ClientMsg | null = null
      try {
        msg = JSON.parse(text) as ClientMsg
      } catch {
        return
      }
      if (msg.type === 'input' && typeof msg.data === 'string') {
        ptyProc?.write(msg.data)
        if (child?.stdin.writable) child.stdin.write(msg.data)
        return
      }
      if (msg.type === 'run' && typeof msg.command === 'string') {
        if (ptyProc) ptyProc.write(msg.command + '\r')
        if (child?.stdin.writable) {
          child.stdin.write(msg.command + '\n')
        }
        return
      }
      if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
        cols = msg.cols
        rows = msg.rows
        ptyProc?.resize(Math.max(2, cols), Math.max(1, rows))
      }
    } catch (e) {
      const err = e as Error
      sendControl(ws, { type: 'error', message: err.message || 'Terminal handler error' })
    }
  })

  ws.on('close', cleanup)
}

function mountTerminalWs(httpServer: Server | null | undefined) {
  if (!httpServer) return
  const wss = new WebSocketServer({ noServer: true })
  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const host = req.headers.host ?? 'localhost'
      const u = new URL(req.url ?? '/', `http://${host}`)
      if (u.pathname !== TERMINAL_WS_PATH) return
      const cwdParam = u.searchParams.get('cwd')
      wss.handleUpgrade(req, socket as Socket, head, (ws) => {
        void bindTerminalSession(ws, cwdParam)
      })
    } catch {
      socket.destroy()
    }
  })
}

export function terminalWsPlugin() {
  return {
    name: 'dev-manager-terminal-ws',
    configureServer(server: { httpServer?: Server | null }) {
      mountTerminalWs(server.httpServer ?? undefined)
    },
    configurePreviewServer(server: { httpServer?: Server | null }) {
      mountTerminalWs(server.httpServer ?? undefined)
    },
  }
}

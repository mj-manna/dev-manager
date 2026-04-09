import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { Connect } from 'vite'
import { writeHostsMaybeElevated } from './privileged-write'

/** System hosts file path: Windows vs Unix (Linux, macOS, *BSD, etc.). */
export function getHostsFilePath(): string {
  if (process.platform === 'win32') {
    const systemRoot =
      process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    return path.join(systemRoot, 'System32', 'drivers', 'etc', 'hosts')
  }
  return '/etc/hosts'
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

async function handleHostsApi(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const hostsPath = getHostsFilePath()

  if (req.method === 'GET') {
    try {
      const content = await fs.readFile(hostsPath, 'utf8')
      let writable = false
      try {
        await fs.access(hostsPath, fsConstants.W_OK)
        writable = true
      } catch {
        writable = false
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          path: hostsPath,
          platform: process.platform,
          content,
          writable,
        }),
      )
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          error: err.message || 'Failed to read hosts file',
          code: err.code,
          path: hostsPath,
          platform: process.platform,
        }),
      )
    }
    return
  }

  if (req.method === 'PUT') {
    try {
      const raw = await readBody(req)
      let body: { content?: string; sudoPassword?: string }
      try {
        body = JSON.parse(raw) as { content?: string; sudoPassword?: string }
      } catch {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Invalid JSON body' }))
        return
      }
      if (typeof body.content !== 'string') {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Expected { "content": string }' }))
        return
      }
      const sudoPassword =
        typeof body.sudoPassword === 'string' ? body.sudoPassword : undefined
      const wr = await writeHostsMaybeElevated(
        hostsPath,
        hostsPath,
        body.content,
        sudoPassword,
      )
      if (wr.ok === false) {
        res.statusCode = wr.httpStatus
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            error: wr.error,
            code: wr.code,
            ...(wr.needsElevation ? { needsElevation: true } : {}),
            hint:
              wr.needsElevation && process.platform === 'win32'
                ? 'Run the dev server as Administrator, or edit the hosts file manually.'
                : wr.needsElevation
                  ? 'Use the password prompt in the app, or run the dev server with permissions to write the hosts file.'
                  : undefined,
          }),
        )
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, path: hostsPath }))
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      res.statusCode = err.code === 'EACCES' || err.code === 'EPERM' ? 403 : 500
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          error: err.message || 'Failed to write hosts file',
          code: err.code,
        }),
      )
    }
    return
  }

  res.statusCode = 405
  res.setHeader('Allow', 'GET, PUT')
  res.end()
}

function hostsApiMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url?.split('?')[0] ?? ''
    if (url !== '/api/hosts') {
      next()
      return
    }
    void handleHostsApi(req, res)
  }
}

export function hostsApiPlugin() {
  return {
    name: 'dev-manager-hosts-api',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(hostsApiMiddleware())
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(hostsApiMiddleware())
    },
  }
}

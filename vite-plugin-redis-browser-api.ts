import { createClient } from 'redis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect } from 'vite'

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

type ConnBody = {
  host?: string
  port?: number
  password?: string
}

async function withRedis<T>(
  host: string,
  port: number,
  password: string | undefined,
  fn: (c: ReturnType<typeof createClient>) => Promise<T>,
): Promise<T> {
  const client = createClient({
    socket: { host, port, connectTimeout: 15000 },
    password: password || undefined,
  })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.quit().catch(() => client.disconnect())
  }
}

function redisErr(e: unknown): string {
  const x = e as Error & { message?: string }
  return x.message || 'Redis error'
}

/** SCAN keys with optional MATCH; returns next cursor + key names + Redis TYPE per key. */
async function handleKeys(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: ConnBody & { cursor?: string | number; match?: string }
  try {
    body = JSON.parse(await readBody(req)) as ConnBody & { cursor?: string | number; match?: string }
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' })
    return
  }
  const host = typeof body.host === 'string' ? body.host.trim() : ''
  const port = typeof body.port === 'number' && Number.isFinite(body.port) ? body.port : 0
  if (!host || port < 1 || port > 65535) {
    sendJson(res, 400, { ok: false, error: 'host and valid port required' })
    return
  }
  const startCursor =
    body.cursor === undefined || body.cursor === ''
      ? '0'
      : String(body.cursor)
  const match = typeof body.match === 'string' && body.match.trim() ? body.match.trim() : undefined
  const pwd = typeof body.password === 'string' ? body.password : undefined

  try {
    const result = await withRedis(host, port, pwd, async (c) => {
      const reply = await c.scan(startCursor, {
        COUNT: 80,
        ...(match ? { MATCH: match } : {}),
      })
      const keys = reply.keys
      const typed: { key: string; type: string }[] = []
      for (const key of keys) {
        typed.push({ key, type: await c.type(key) })
      }
      return { nextCursor: String(reply.cursor), keys: typed }
    })
    sendJson(res, 200, {
      ok: true,
      cursor: result.nextCursor,
      keys: result.keys,
      hasMore: result.nextCursor !== '0',
    })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: redisErr(e) })
  }
}

/** Read value by key (TYPE resolved on server). */
async function handleValue(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: ConnBody & { key?: string }
  try {
    body = JSON.parse(await readBody(req)) as ConnBody & { key?: string }
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' })
    return
  }
  const host = typeof body.host === 'string' ? body.host.trim() : ''
  const port = typeof body.port === 'number' && Number.isFinite(body.port) ? body.port : 0
  const key = typeof body.key === 'string' ? body.key : ''
  if (!host || port < 1 || port > 65535 || !key) {
    sendJson(res, 400, { ok: false, error: 'host, port, and key required' })
    return
  }
  const pwd = typeof body.password === 'string' ? body.password : undefined

  try {
    const payload = await withRedis(host, port, pwd, async (c) => {
      const t = (await c.type(key)).toLowerCase()
      if (t === 'string') {
        const value = await c.get(key)
        return { redisType: 'string', stringValue: value }
      }
      if (t === 'hash') {
        const entries = await c.hGetAll(key)
        return { redisType: 'hash', hashEntries: entries }
      }
      if (t === 'list') {
        const items = await c.lRange(key, 0, 499)
        const len = await c.lLen(key)
        return { redisType: 'list', listItems: items, listLength: len }
      }
      if (t === 'set') {
        const members = await c.sMembers(key)
        return { redisType: 'set', setMembers: members }
      }
      if (t === 'zset') {
        const withScores = await c.zRangeWithScores(key, 0, 499)
        const len = await c.zCard(key)
        return {
          redisType: 'zset',
          zsetMembers: withScores.map((x) => ({ score: x.score, member: String(x.value) })),
          zsetLength: len,
        }
      }
      if (t === 'stream') {
        const streamEntries = await c.xRange(key, '-', '+', { COUNT: 40 })
        return { redisType: 'stream', streamEntries }
      }
      return { redisType: t, unsupported: true }
    })
    sendJson(res, 200, { ok: true, key, ...payload })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: redisErr(e) })
  }
}

async function handleSetString(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: ConnBody & { key?: string; value?: string }
  try {
    body = JSON.parse(await readBody(req)) as ConnBody & { key?: string; value?: string }
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' })
    return
  }
  const host = typeof body.host === 'string' ? body.host.trim() : ''
  const port = typeof body.port === 'number' && Number.isFinite(body.port) ? body.port : 0
  const key = typeof body.key === 'string' ? body.key : ''
  const value = typeof body.value === 'string' ? body.value : ''
  if (!host || port < 1 || port > 65535 || !key) {
    sendJson(res, 400, { ok: false, error: 'host, port, and key required' })
    return
  }
  const pwd = typeof body.password === 'string' ? body.password : undefined
  try {
    await withRedis(host, port, pwd, async (c) => {
      const t = (await c.type(key)).toLowerCase()
      if (t !== 'string') {
        throw new Error(`Key is not a string (type: ${t})`)
      }
      await c.set(key, value)
    })
    sendJson(res, 200, { ok: true })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: redisErr(e) })
  }
}

async function handleHashSet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }
  let body: ConnBody & { key?: string; field?: string; value?: string }
  try {
    body = JSON.parse(await readBody(req)) as ConnBody & { key?: string; field?: string; value?: string }
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' })
    return
  }
  const host = typeof body.host === 'string' ? body.host.trim() : ''
  const port = typeof body.port === 'number' && Number.isFinite(body.port) ? body.port : 0
  const key = typeof body.key === 'string' ? body.key : ''
  const field = typeof body.field === 'string' ? body.field : ''
  const value = typeof body.value === 'string' ? body.value : ''
  if (!host || port < 1 || port > 65535 || !key || !field) {
    sendJson(res, 400, { ok: false, error: 'host, port, key, and field required' })
    return
  }
  const pwd = typeof body.password === 'string' ? body.password : undefined
  try {
    await withRedis(host, port, pwd, async (c) => {
      const t = (await c.type(key)).toLowerCase()
      if (t !== 'hash') {
        throw new Error(`Key is not a hash (type: ${t})`)
      }
      await c.hSet(key, field, value)
    })
    sendJson(res, 200, { ok: true })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: redisErr(e) })
  }
}

function redisBrowserMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url?.split('?')[0] ?? ''
    if (url === '/api/db/redis/keys') {
      void handleKeys(req, res)
      return
    }
    if (url === '/api/db/redis/value') {
      void handleValue(req, res)
      return
    }
    if (url === '/api/db/redis/set-string') {
      void handleSetString(req, res)
      return
    }
    if (url === '/api/db/redis/hash-set') {
      void handleHashSet(req, res)
      return
    }
    next()
  }
}

export function redisBrowserApiPlugin() {
  return {
    name: 'dev-manager-redis-browser-api',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(redisBrowserMiddleware())
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(redisBrowserMiddleware())
    },
  }
}

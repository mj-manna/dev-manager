import { useCallback, useEffect, useState } from 'react'

type Pm2Status = {
  platform: string
  cliAvailable: boolean
  version: string | null
  error: string | null
}

type Pm2ProcessRow = {
  pmId: number
  name: string
  status: string
  cpu: number
  memoryBytes: number
  restarts: number
  pid: number | null
}

function formatMem(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${mb.toFixed(1)} MiB`
  return `${(mb / 1024).toFixed(2)} GiB`
}

/** Avoid `response.json()` throwing when the server returns HTML (e.g. SPA fallback) or empty body. */
async function readJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text()
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error(
      `Empty response (${res.status}). The PM2 API is only served by Vite (pnpm dev / vite preview), not by copying dist/ to a static host unless you proxy /api/pm2/* to that Vite process.`,
    )
  }
  const c = trimmed[0]
  if (c !== '{' && c !== '[' && c !== '"') {
    const html = c === '<'
    throw new Error(
      html
        ? `Got HTML instead of JSON (${res.status}) — /api/pm2 is not reaching the Vite middleware. Run the app with pnpm dev (or vite preview) on this host, or configure your reverse proxy to forward /api/pm2 to it.`
        : `Non-JSON response (${res.status}): ${trimmed.slice(0, 200).replace(/\s+/g, ' ')}…`,
    )
  }
  try {
    return JSON.parse(trimmed) as T
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'JSON parse error'
    throw new Error(`${msg} — body starts: ${trimmed.slice(0, 160).replace(/\s+/g, ' ')}…`)
  }
}

export function Pm2Panel() {
  const [status, setStatus] = useState<Pm2Status | null>(null)
  const [processes, setProcesses] = useState<Pm2ProcessRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busyTarget, setBusyTarget] = useState<string | null>(null)
  const [globalBusy, setGlobalBusy] = useState(false)
  const [banner, setBanner] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setLoadError(null)
    setListError(null)
    try {
      const [sr, pr] = await Promise.all([fetch('/api/pm2/status'), fetch('/api/pm2/processes')])
      const sj = (await readJsonResponse<Pm2Status & { error?: string }>(sr))
      setStatus({
        platform: sj.platform,
        cliAvailable: sj.cliAvailable,
        version: sj.version,
        error: sj.error ?? null,
      })
      if (!sr.ok) {
        setLoadError(typeof sj.error === 'string' ? sj.error : 'Could not read PM2 status.')
      }

      const pj = await readJsonResponse<{ processes?: Pm2ProcessRow[]; error?: string }>(pr)
      if (!pr.ok) {
        setListError(typeof pj.error === 'string' ? pj.error : 'Could not list processes.')
        setProcesses([])
      } else {
        setProcesses(Array.isArray(pj.processes) ? pj.processes : [])
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Network error')
      setProcesses([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runProcessAction = useCallback(
    async (target: string, action: 'stop' | 'reload' | 'restart') => {
      setBusyTarget(target)
      setBanner(null)
      try {
        const res = await fetch('/api/pm2/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, action }),
        })
        const data = await readJsonResponse<{ ok?: boolean; error?: string; message?: string }>(res)
        if (!res.ok) {
          setBanner({ type: 'err', text: data.error || `${action} failed` })
          return
        }
        setBanner({
          type: 'ok',
          text: typeof data.message === 'string' && data.message ? data.message : `${action} OK`,
        })
        await refresh()
      } catch (e) {
        setBanner({ type: 'err', text: e instanceof Error ? e.message : 'Request failed' })
      } finally {
        setBusyTarget(null)
      }
    },
    [refresh],
  )

  const restartAll = useCallback(async () => {
    setGlobalBusy(true)
    setBanner(null)
    try {
      const res = await fetch('/api/pm2/restart-all', { method: 'POST' })
      const data = await readJsonResponse<{ ok?: boolean; error?: string; message?: string }>(res)
      if (!res.ok) {
        setBanner({ type: 'err', text: data.error || 'Global restart failed' })
        return
      }
      setBanner({
        type: 'ok',
        text: typeof data.message === 'string' && data.message ? data.message : 'All processes restarted',
      })
      await refresh()
    } catch (e) {
      setBanner({ type: 'err', text: e instanceof Error ? e.message : 'Request failed' })
    } finally {
      setGlobalBusy(false)
    }
  }, [refresh])

  const isOnline = (s: string) => s === 'online' || s === 'launching'

  return (
    <section className="panel docker-panel">
      <div className="panel__head docker-panel__head">
        <div>
          <h2>PM2</h2>
          <p className="docker-panel__lede">
            Process manager — lists apps from <code className="host-editor__inline-code">pm2 jlist</code> on the host
            running the dev server. Use reload for zero-downtime cluster workers when applicable.
          </p>
        </div>
        <div className="docker-panel__head-actions">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => void restartAll()}
            disabled={globalBusy || refreshing || !status?.cliAvailable}
            title="Runs: pm2 restart all"
          >
            {globalBusy ? 'Restarting all…' : 'Restart all'}
          </button>
          <button type="button" className="btn btn--secondary" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {banner ? (
        <div
          className={`docker-panel__banner host-editor__banner host-editor__banner--${banner.type === 'ok' ? 'ok' : 'err'}`}
        >
          {banner.text}
        </div>
      ) : null}

      <div className="docker-panel__body">
        {loading ? (
          <p className="docker-panel__muted">Loading PM2…</p>
        ) : (
          <>
            <dl className="docker-panel__meta">
              <div className="docker-panel__meta-row">
                <dt>CLI</dt>
                <dd>
                  {status?.cliAvailable ? (
                    <code className="host-editor__inline-code">{status.version ?? '—'}</code>
                  ) : (
                    <span className="docker-panel__warn">PM2 not available (install globally: npm i -g pm2)</span>
                  )}
                </dd>
              </div>
              <div className="docker-panel__meta-row">
                <dt>Platform</dt>
                <dd>
                  <code className="host-editor__inline-code">{status?.platform ?? '—'}</code>
                </dd>
              </div>
            </dl>

            {loadError ? (
              <pre className="docker-panel__pre docker-panel__pre--err" role="status">
                {loadError}
              </pre>
            ) : null}

            {listError ? (
              <pre className="docker-panel__pre docker-panel__pre--warn" role="status">
                {listError}
              </pre>
            ) : null}

            <div className="table-wrap docker-panel__table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Id</th>
                    <th scope="col">Status</th>
                    <th scope="col">CPU %</th>
                    <th scope="col">Memory</th>
                    <th scope="col">Restarts</th>
                    <th scope="col" className="docker-panel__th-actions">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {processes.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="data-table__muted">
                        {status?.cliAvailable ? 'No PM2 processes in the current daemon.' : 'Install PM2 to manage processes.'}
                      </td>
                    </tr>
                  ) : (
                    processes.map((p) => {
                      const up = isOnline(p.status)
                      const busy = busyTarget === p.name
                      return (
                        <tr key={`${p.pmId}-${p.name}`}>
                          <td>
                            <span className="data-table__name">{p.name}</span>
                            {p.pid != null ? (
                              <div className="docker-panel__id data-table__muted">pid {p.pid}</div>
                            ) : null}
                          </td>
                          <td className="data-table__muted">{p.pmId}</td>
                          <td>
                            <span className={`docker-panel__state docker-panel__state--${up ? 'up' : 'down'}`}>
                              {p.status}
                            </span>
                          </td>
                          <td className="data-table__muted">{p.cpu.toFixed(1)}</td>
                          <td className="data-table__muted">{formatMem(p.memoryBytes)}</td>
                          <td className="data-table__muted">{p.restarts}</td>
                          <td>
                            <div className="docker-panel__actions">
                              <button
                                type="button"
                                className="btn btn--ghost btn--xs"
                                disabled={busy || globalBusy}
                                onClick={() => void runProcessAction(p.name, 'stop')}
                              >
                                Stop
                              </button>
                              <button
                                type="button"
                                className="btn btn--secondary btn--xs"
                                disabled={busy || globalBusy || !up}
                                title={!up ? 'Process is not online' : undefined}
                                onClick={() => void runProcessAction(p.name, 'reload')}
                              >
                                Reload
                              </button>
                              <button
                                type="button"
                                className="btn btn--secondary btn--xs"
                                disabled={busy || globalBusy}
                                onClick={() => void runProcessAction(p.name, 'restart')}
                              >
                                Restart
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

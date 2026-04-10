import { useCallback, useEffect, useState } from 'react'

type DockerStatus = {
  platform: string
  clientAvailable: boolean
  clientVersion: string | null
  daemonReachable: boolean
  serverVersion: string | null
  context: string | null
  error: string | null
}

type DockerContainerRow = {
  id: string
  names: string
  image: string
  status: string
  state: string
}

export function DockerPanel() {
  const [status, setStatus] = useState<DockerStatus | null>(null)
  const [containers, setContainers] = useState<DockerContainerRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busyTarget, setBusyTarget] = useState<string | null>(null)
  const [banner, setBanner] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setLoadError(null)
    setListError(null)
    try {
      const [sr, cr] = await Promise.all([fetch('/api/docker/status'), fetch('/api/docker/containers')])
      const sj = (await sr.json()) as DockerStatus & { error?: string }
      setStatus({
        platform: sj.platform,
        clientAvailable: sj.clientAvailable,
        clientVersion: sj.clientVersion,
        daemonReachable: sj.daemonReachable,
        serverVersion: sj.serverVersion,
        context: sj.context,
        error: sj.error ?? null,
      })
      if (!sr.ok) {
        setLoadError(typeof sj.error === 'string' ? sj.error : 'Could not read Docker status.')
      }

      const cj = (await cr.json()) as { containers?: DockerContainerRow[]; error?: string }
      if (!cr.ok) {
        setListError(typeof cj.error === 'string' ? cj.error : 'Could not list containers.')
        setContainers([])
      } else {
        setContainers(Array.isArray(cj.containers) ? cj.containers : [])
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Network error')
      setContainers([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runAction = useCallback(
    async (target: string, action: 'start' | 'stop' | 'restart') => {
      setBusyTarget(target)
      setBanner(null)
      try {
        const res = await fetch('/api/docker/container', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, action }),
        })
        const data = (await res.json()) as { ok?: boolean; error?: string; message?: string }
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

  const running = (s: string) => s === 'running'

  return (
    <section className="panel docker-panel">
        <div className="panel__head docker-panel__head">
          <div>
            <h2>Docker</h2>
            <p className="docker-panel__lede">
              Local Engine status and containers — commands run on the machine hosting the Dev Manager dev server.
            </p>
          </div>
          <div className="docker-panel__head-actions">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
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
            <p className="docker-panel__muted">Loading Docker status…</p>
          ) : (
            <>
              <dl className="docker-panel__meta">
                <div className="docker-panel__meta-row">
                  <dt>Client</dt>
                  <dd>
                    {status?.clientAvailable ? (
                      <code className="host-editor__inline-code">{status.clientVersion ?? '—'}</code>
                    ) : (
                      <span className="docker-panel__warn">Not available (is Docker installed?)</span>
                    )}
                  </dd>
                </div>
                <div className="docker-panel__meta-row">
                  <dt>Engine</dt>
                  <dd>
                    {status?.daemonReachable ? (
                      <code className="host-editor__inline-code">{status.serverVersion ?? '—'}</code>
                    ) : (
                      <span className="docker-panel__warn">Not reachable — start the Docker daemon</span>
                    )}
                  </dd>
                </div>
                {status?.context ? (
                  <div className="docker-panel__meta-row">
                    <dt>Context</dt>
                    <dd>
                      <code className="host-editor__inline-code">{status.context}</code>
                    </dd>
                  </div>
                ) : null}
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
                      <th scope="col">Image</th>
                      <th scope="col">Status</th>
                      <th scope="col">State</th>
                      <th scope="col" className="docker-panel__th-actions">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {containers.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="data-table__muted">
                          {status?.daemonReachable ? 'No containers.' : 'Start the Docker daemon to list containers.'}
                        </td>
                      </tr>
                    ) : (
                      containers.map((c) => {
                        const isRun = running(c.state)
                        const busy = busyTarget === c.id
                        return (
                          <tr key={c.id}>
                            <td>
                              <span className="data-table__name">{c.names}</span>
                              <div className="docker-panel__id data-table__muted">{c.id.slice(0, 12)}…</div>
                            </td>
                            <td className="data-table__muted">{c.image}</td>
                            <td className="data-table__muted">{c.status}</td>
                            <td>
                              <span className={`docker-panel__state docker-panel__state--${isRun ? 'up' : 'down'}`}>
                                {c.state}
                              </span>
                            </td>
                            <td>
                              <div className="docker-panel__actions">
                                {isRun ? (
                                  <>
                                    <button
                                      type="button"
                                      className="btn btn--ghost btn--xs"
                                      disabled={busy}
                                      onClick={() => void runAction(c.id, 'stop')}
                                    >
                                      Stop
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn--secondary btn--xs"
                                      disabled={busy}
                                      onClick={() => void runAction(c.id, 'restart')}
                                    >
                                      Restart
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      className="btn btn--primary btn--xs"
                                      disabled={busy}
                                      onClick={() => void runAction(c.id, 'start')}
                                    >
                                      Start
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn--ghost btn--xs"
                                      disabled={busy}
                                      onClick={() => void runAction(c.id, 'restart')}
                                    >
                                      Restart
                                    </button>
                                  </>
                                )}
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

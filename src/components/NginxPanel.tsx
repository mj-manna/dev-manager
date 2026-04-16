import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { needsElevationPrompt, useSudoElevation } from '../elevation/SudoElevationContext'
import { memoryCacheGet, memoryCacheSet } from '../lib/memoryCache'
import { useTerminal } from '../terminal/TerminalContext'
import { ConfirmDangerModal } from './ConfirmDangerModal'
import { WebServerConflictGate } from './WebServerConflictGate'
import { WebServerVhostTabs } from './WebServerVhostTabs'

type VhostRow = {
  id: string
  name: string
  path: string
  enabled: boolean
  layout: string
}

type StatusPayload = {
  installed: boolean
  version: string | null
  configRoot: string | null
  layout: string
  vhosts: VhostRow[]
  platform: string
}

const NGINX_STATUS_CACHE_KEY = 'dm:panel:nginx-status-v2'

function ErrorModal({
  title,
  body,
  onClose,
}: {
  title: string
  body: string
  onClose: () => void
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="nginx-modal-title">
      <div className="modal">
        <div className="modal__head">
          <h2 id="nginx-modal-title">{title}</h2>
          <button type="button" className="modal__close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <pre className="modal__body">{body.trim() || '(no output)'}</pre>
        <div className="modal__foot">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

export function NginxPanel() {
  const { fetchJsonWithElevation } = useSudoElevation()
  const { runInTerminal, showTerminal, tabExitEvent, clearTabExitEvent } = useTerminal()
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /** Apache (httpd) must be absent before this Nginx panel is usable. */
  const [apacheInstalled, setApacheInstalled] = useState(false)

  const [vhosts, setVhosts] = useState<VhostRow[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editorContent, setEditorContent] = useState('')
  const [editorLoading, setEditorLoading] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restartBusy, setRestartBusy] = useState(false)
  const [testBusy, setTestBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [banner, setBanner] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const [newName, setNewName] = useState('')
  const [newBusy, setNewBusy] = useState(false)
  const createVhostInFlight = useRef(false)

  const proposedCreateId = useMemo(() => {
    const trimmed = newName.trim()
    if (!trimmed) return null
    const layout = status?.layout === 'debian' ? 'debian' : 'confd'
    if (layout === 'confd' && !trimmed.endsWith('.conf')) {
      return `${trimmed}.conf`
    }
    return trimmed
  }, [newName, status?.layout])

  const createNameCollides =
    proposedCreateId !== null && vhosts.some((v) => v.id === proposedCreateId)

  const [modal, setModal] = useState<{ title: string; body: string } | null>(null)
  const [deleteVhostConfirmOpen, setDeleteVhostConfirmOpen] = useState(false)

  const nginxLocalInstallWatchRef = useRef(false)
  /** Bumped after a successful local HTTPS install so the editor reloads from disk. */
  const [vhostContentEpoch, setVhostContentEpoch] = useState(0)

  const loadStatus = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = Boolean(opts?.silent)
    if (!silent) {
      setStatusError(null)
      setLoading(true)
    }
    try {
      if (silent) {
        const hit = memoryCacheGet<{
          apacheInstalled: boolean
          nginxData: StatusPayload & { error?: string }
        }>(NGINX_STATUS_CACHE_KEY)
        if (hit) {
          setApacheInstalled(hit.apacheInstalled)
          setStatus(hit.nginxData)
          setVhosts(hit.nginxData.vhosts)
          return
        }
      }
      const [nginxRes, apacheRes] = await Promise.all([
        fetch('/api/nginx/status'),
        fetch('/api/apache/status'),
      ])
      const nginxData = (await nginxRes.json()) as StatusPayload & { error?: string }
      const apacheData = (await apacheRes.json()) as { installed?: boolean }
      setApacheInstalled(Boolean(apacheData.installed))

      if (!nginxRes.ok) {
        if (!silent) {
          setStatus(null)
          setStatusError(nginxData.error || `HTTP ${nginxRes.status}`)
        }
        return
      }
      setStatus(nginxData)
      setVhosts(nginxData.vhosts)
      memoryCacheSet(NGINX_STATUS_CACHE_KEY, {
        apacheInstalled: Boolean(apacheData.installed),
        nginxData,
      })
    } catch (e) {
      if (!silent) {
        setStatus(null)
        setApacheInstalled(false)
        setStatusError(e instanceof Error ? e.message : 'Failed to load nginx status')
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    if (!status?.installed) return
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void loadStatus({ silent: true })
    }, 12000)
    return () => window.clearInterval(id)
  }, [status?.installed, loadStatus])

  useEffect(() => {
    if (!status?.installed) return
    setActiveId((cur) => {
      if (cur === '__new__') return cur
      if (cur && vhosts.some((v) => v.id === cur)) return cur
      if (vhosts.length) return vhosts[0].id
      return '__new__'
    })
  }, [status?.installed, vhosts])

  const refreshVhosts = useCallback(async () => {
    try {
      const res = await fetch('/api/nginx/vhosts')
      if (!res.ok) return
      const data = (await res.json()) as { vhosts: VhostRow[] }
      setVhosts(data.vhosts)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    if (!tabExitEvent || !nginxLocalInstallWatchRef.current) return
    nginxLocalInstallWatchRef.current = false
    clearTabExitEvent()
    if (tabExitEvent.payload.exitCode === 0) {
      void loadStatus()
      void refreshVhosts()
      setVhostContentEpoch((n) => n + 1)
      setBanner({
        type: 'ok',
        text: 'Install HTTPS finished successfully (exit 0). Nginx status and the open vhost file were refreshed.',
      })
    }
  }, [tabExitEvent, clearTabExitEvent, loadStatus, refreshVhosts])

  useEffect(() => {
    if (!status?.installed || activeId === null || activeId === '__new__') {
      if (activeId === '__new__') {
        setEditorContent('')
        setBanner(null)
      }
      return
    }
    let cancelled = false
    setEditorLoading(true)
    setBanner(null)
    void (async () => {
      try {
        const url = `/api/nginx/vhosts/${encodeURIComponent(activeId)}`
        let res = await fetch(url)
        let data = (await res.json()) as {
          content?: string
          error?: string
          code?: string
          needsElevation?: boolean
        }
        if (!res.ok && needsElevationPrompt(data, res.status)) {
          const elevated = await fetchJsonWithElevation(url, 'POST', {})
          res = elevated.res
          data = elevated.data as typeof data
        }
        if (!res.ok) {
          if (!cancelled) {
            setEditorContent('')
            setBanner({ type: 'err', text: data.error || `HTTP ${res.status}` })
          }
          return
        }
        if (!cancelled) {
          setEditorContent(data.content ?? '')
          setDirty(false)
        }
      } catch (e) {
        if (!cancelled) {
          setBanner({
            type: 'err',
            text: e instanceof Error ? e.message : 'Load failed',
          })
        }
      } finally {
        if (!cancelled) setEditorLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [status?.installed, activeId, fetchJsonWithElevation, vhostContentEpoch])

  const startInstallInTerminal = async () => {
    setBanner(null)
    try {
      const res = await fetch('/api/nginx/install-command')
      const data = (await res.json()) as { command?: string; error?: string; hint?: string }
      if (!res.ok || !data.command) {
        setBanner({
          type: 'err',
          text: data.error || 'No install command for this system.',
        })
        return
      }
      if (data.hint) {
        setBanner({ type: 'ok', text: data.hint })
      }
      runInTerminal(data.command)
    } catch (e) {
      setBanner({
        type: 'err',
        text: e instanceof Error ? e.message : 'Failed to load install command',
      })
    }
  }

  const save = async () => {
    if (!activeId || activeId === '__new__') return
    setSaving(true)
    setBanner(null)
    try {
      const { res, data } = await fetchJsonWithElevation(
        `/api/nginx/vhosts/${encodeURIComponent(activeId)}`,
        'PUT',
        { content: editorContent },
      )
      const d = data as { error?: string }
      if (!res.ok) {
        setBanner({ type: 'err', text: d.error || `Save failed (${res.status})` })
        return
      }
      setDirty(false)
      setBanner({ type: 'ok', text: 'Saved.' })
    } catch (e) {
      setBanner({
        type: 'err',
        text: e instanceof Error ? e.message : 'Save failed',
      })
    } finally {
      setSaving(false)
    }
  }

  const runTest = async () => {
    setTestBusy(true)
    setBanner(null)
    try {
      const { res, data } = await fetchJsonWithElevation('/api/nginx/test', 'POST', {})
      const d = data as {
        ok: boolean
        stdout: string
        stderr: string
        code?: string
      }
      if (!res.ok && res.status === 403) {
        const body = [d.stderr, d.stdout].filter(Boolean).join('\n---\n')
        setModal({
          title: 'Configuration test',
          body:
            body ||
            'Elevation was cancelled. nginx -t often needs root on Linux because of paths like /run/nginx.pid.',
        })
        return
      }
      if (!d.ok) {
        const body = [d.stderr, d.stdout].filter(Boolean).join('\n---\n')
        setModal({
          title: 'nginx configuration test failed',
          body: body || 'nginx -t reported an error.',
        })
        return
      }
      setBanner({ type: 'ok', text: 'Configuration test passed (nginx -t).' })
    } catch (e) {
      setModal({
        title: 'Test request failed',
        body: e instanceof Error ? e.message : 'Unknown error',
      })
    } finally {
      setTestBusy(false)
    }
  }

  const runRestart = async () => {
    setRestartBusy(true)
    setBanner(null)
    try {
      const res = await fetch('/api/nginx/restart', { method: 'POST' })
      const data = (await res.json()) as { ok?: boolean; message?: string }
      if (!res.ok || !data.ok) {
        setModal({
          title: 'Restart failed',
          body: data.message || `HTTP ${res.status}`,
        })
        return
      }
      setBanner({ type: 'ok', text: data.message || 'nginx restarted.' })
    } catch (e) {
      setModal({
        title: 'Restart request failed',
        body: e instanceof Error ? e.message : 'Unknown error',
      })
    } finally {
      setRestartBusy(false)
    }
  }

  const openDeleteVhostConfirm = () => {
    if (!activeId || activeId === '__new__') return
    setDeleteVhostConfirmOpen(true)
  }

  const performDeleteVhost = async () => {
    if (!activeId || activeId === '__new__') return
    setDeleteVhostConfirmOpen(false)
    setDeleteBusy(true)
    setBanner(null)
    try {
      const { res, data } = await fetchJsonWithElevation(
        `/api/nginx/vhosts/${encodeURIComponent(activeId)}`,
        'DELETE',
        {},
      )
      const d = data as { error?: string; ok?: boolean }
      if (!res.ok) {
        setBanner({ type: 'err', text: d.error || `Delete failed (${res.status})` })
        return
      }
      setDirty(false)
      setEditorContent('')
      setBanner({ type: 'ok', text: 'Virtual host file deleted.' })
      await refreshVhosts()
      const vr = await fetch('/api/nginx/vhosts')
      if (vr.ok) {
        const { vhosts: nv } = (await vr.json()) as { vhosts: VhostRow[] }
        setVhosts(nv)
        setActiveId(nv[0]?.id ?? '__new__')
      } else {
        setActiveId('__new__')
      }
      await loadStatus()
    } catch (e) {
      setBanner({
        type: 'err',
        text: e instanceof Error ? e.message : 'Delete failed',
      })
    } finally {
      setDeleteBusy(false)
    }
  }

  const runNginxLocalProxyInstall = useCallback(async () => {
    if (!activeId || activeId === '__new__') {
      setBanner({ type: 'err', text: 'Select a virtual host file first.' })
      return
    }
    setBanner(null)
    try {
      const qs = new URLSearchParams({ vhostId: activeId })
      const res = await fetch(`/api/nginx/local-proxy-install-command?${qs.toString()}`)
      const data = (await res.json()) as {
        command?: string
        error?: string
        alreadyConfigured?: boolean
        message?: string
      }
      if (data.alreadyConfigured) {
        setBanner({ type: 'ok', text: data.message || 'Local proxy already present in this file.' })
        void loadStatus()
        setVhostContentEpoch((n) => n + 1)
        return
      }
      if (!res.ok || !data.command) {
        setBanner({ type: 'err', text: data.error || 'Could not build install script.' })
        return
      }
      nginxLocalInstallWatchRef.current = true
      runInTerminal(data.command, { label: 'nginx: Install HTTPS' })
    } catch (e) {
      setBanner({ type: 'err', text: e instanceof Error ? e.message : 'Request failed.' })
    }
  }, [activeId, loadStatus, runInTerminal])

  const createVhost = async () => {
    const name = newName.trim()
    if (!name || createVhostInFlight.current) return
    const layout = status?.layout === 'debian' ? 'debian' : 'confd'
    let effectiveId = name
    if (layout === 'confd' && !effectiveId.endsWith('.conf')) {
      effectiveId = `${effectiveId}.conf`
    }
    if (vhosts.some((v) => v.id === effectiveId)) {
      setBanner({ type: 'err', text: 'A virtual host file with this name already exists.' })
      return
    }
    createVhostInFlight.current = true
    setNewBusy(true)
    setBanner(null)
    try {
      const { res, data } = await fetchJsonWithElevation('/api/nginx/vhosts', 'POST', { name })
      const typed = data as { id?: string; error?: string; layout?: string }
      if (!res.ok) {
        setBanner({ type: 'err', text: typed.error || `Create failed (${res.status})` })
        return
      }
      setNewName('')
      await refreshVhosts()
      await loadStatus()
      if (typed.id) {
        setActiveId(typed.id)
      }
      setBanner({
        type: 'ok',
        text:
          typed.layout === 'debian'
            ? 'Virtual host file created and linked in sites-enabled.'
            : 'Virtual host file created.',
      })
    } catch (e) {
      setBanner({
        type: 'err',
        text: e instanceof Error ? e.message : 'Create failed',
      })
    } finally {
      createVhostInFlight.current = false
      setNewBusy(false)
    }
  }

  if (loading && !status) {
    return (
      <section className="panel nginx-panel">
        <p className="nginx-panel__loading">Checking web servers…</p>
      </section>
    )
  }

  if (statusError) {
    return (
      <section className="panel nginx-panel">
        <div className="nginx-panel__banner nginx-panel__banner--err">{statusError}</div>
        <button type="button" className="btn btn--primary" onClick={() => void loadStatus()}>
          Retry
        </button>
      </section>
    )
  }

  if (apacheInstalled) {
    return (
      <WebServerConflictGate
        targetName="Nginx"
        blockingName="Apache"
        blockingDetail="packages apache2 or httpd"
        uninstallCommandUrl="/api/apache/uninstall-command"
        runInTerminal={runInTerminal}
        showTerminal={showTerminal}
        onRefresh={loadStatus}
      />
    )
  }

  if (!status?.installed) {
    return (
      <section className="panel nginx-install">
        <div className="nginx-install__inner">
          <h2>nginx is not installed</h2>
          <p className="nginx-install__lead">
            Opens the in-app shell and runs the right install command for your OS (apt, dnf/yum, or Homebrew).
            Type your password or answer prompts directly in the terminal. When it finishes, use{' '}
            <strong>Refresh</strong> on the nginx page (reload this view) to detect nginx.
          </p>
          {banner ? (
            <div className={`nginx-panel__banner nginx-panel__banner--${banner.type}`}>{banner.text}</div>
          ) : null}
          <div className="nginx-install__actions">
            <button
              type="button"
              className="btn btn--primary nginx-install__btn"
              onClick={() => void startInstallInTerminal()}
            >
              Run install in terminal
            </button>
            <button type="button" className="btn btn--ghost" onClick={showTerminal}>
              Open shell only
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => void loadStatus()}>
              Refresh status
            </button>
          </div>
          <p className="nginx-install__hint">
            Tip: use the header <strong>Terminal</strong> button anytime. For full sudo TTY support, install{' '}
            <code className="host-editor__inline-code">build-essential</code> (and <code className="host-editor__inline-code">make</code>), then run{' '}
            <code className="host-editor__inline-code">bun add node-pty</code> and restart <code className="host-editor__inline-code">bun run dev</code>.
          </p>
        </div>
      </section>
    )
  }

  return (
    <>
      {modal ? (
        <ErrorModal title={modal.title} body={modal.body} onClose={() => setModal(null)} />
      ) : null}

      <section className="panel nginx-panel">
        <div className="nginx-panel__toolbar">
          <div className="nginx-panel__meta">
            <span className="nginx-panel__version">{status.version}</span>
            {status.configRoot ? (
              <code className="nginx-panel__root">{status.configRoot}</code>
            ) : null}
          </div>
          <div className="nginx-panel__toolbar-actions">
            <button type="button" className="btn btn--ghost" onClick={() => void runTest()} disabled={testBusy}>
              {testBusy ? 'Testing…' : 'Check config'}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void runRestart()}
              disabled={restartBusy}
            >
              {restartBusy ? 'Restarting…' : 'Restart nginx'}
            </button>
          </div>
        </div>

        {banner ? (
          <div className={`nginx-panel__banner nginx-panel__banner--${banner.type}`}>{banner.text}</div>
        ) : null}

        <WebServerVhostTabs
          vhosts={vhosts}
          activeId={activeId}
          onSelectTab={(id) => {
            setActiveId(id)
            setBanner(null)
          }}
          onSelectNew={() => {
            setActiveId('__new__')
            setBanner(null)
          }}
        />

        {activeId === '__new__' ? (
          <div className="nginx-new">
            <h3 className="nginx-new__title">Create virtual host file</h3>
            <p className="nginx-new__hint">
              Name only: letters, numbers, <code className="host-editor__inline-code">.</code>,{' '}
              <code className="host-editor__inline-code">_</code>,{' '}
              <code className="host-editor__inline-code">-</code>. For conf.d layouts,{' '}
              <code className="host-editor__inline-code">.conf</code> is added automatically.
            </p>
            {createNameCollides ? (
              <p className="nginx-new__duplicate" role="status">
                A file with this name already exists in the list.
              </p>
            ) : null}
            <div className="nginx-new__row">
              <input
                className="nginx-new__input"
                name="dev-manager-nginx-vhost-basename"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. myapp or myapp.conf"
                aria-label="New virtual host file name"
              />
              <button
                type="button"
                className="btn btn--primary"
                disabled={newBusy || !newName.trim() || createNameCollides}
                onClick={() => void createVhost()}
              >
                {newBusy ? 'Creating…' : 'Create'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setActiveId(vhosts[0]?.id ?? '__new__')
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="nginx-editor">
            <div className="nginx-editor__bar">
              <div className="nginx-editor__bar-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!activeId || editorLoading || saving || !dirty}
                  onClick={() => void save()}
                >
                  {saving ? 'Saving…' : 'Save file'}
                </button>
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={!activeId || editorLoading || deleteBusy}
                  onClick={() => void openDeleteVhostConfirm()}
                >
                  {deleteBusy ? 'Deleting…' : 'Delete file'}
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => void refreshVhosts()}>
                  Refresh list
                </button>
              </div>
              {status.platform !== 'win32' && activeId && activeId !== '__new__' ? (
                <button
                  type="button"
                  className="btn btn--secondary nginx-editor__install"
                  title="Local dev only: append HTTP/HTTPS using a hostname from the selected file name (e.g. myapp.test.conf becomes myapp.test), proxying to Vite. TLS files are per hostname under the nginx ssl/ directory. Installs mkcert when missing, runs mkcert -install, reloads nginx; falls back to openssl. Uses sudo in the terminal."
                  onClick={() => void runNginxLocalProxyInstall()}
                >
                  Install HTTPS
                </button>
              ) : null}
            </div>
            {editorLoading ? (
              <p className="nginx-panel__loading">Loading file…</p>
            ) : (
              <textarea
                className="nginx-editor__textarea"
                spellCheck={false}
                value={editorContent}
                onChange={(e) => {
                  setEditorContent(e.target.value)
                  setDirty(true)
                  setBanner(null)
                }}
                aria-label="Virtual host configuration"
              />
            )}
          </div>
        )}
      </section>

      <ConfirmDangerModal
        open={deleteVhostConfirmOpen}
        title="Delete virtual host file?"
        titleId="nginx-del-vhost-title"
        message={
          <>
            Delete <strong>{activeId}</strong> from disk? On Debian/Ubuntu the matching{' '}
            <code className="host-editor__inline-code">sites-enabled</code> link is removed too. This cannot be undone.
          </>
        }
        confirmLabel="Delete file"
        busy={deleteBusy}
        onCancel={() => !deleteBusy && setDeleteVhostConfirmOpen(false)}
        onConfirm={() => void performDeleteVhost()}
      />
    </>
  )
}

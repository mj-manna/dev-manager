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
  kind: string | null
  configRoot: string | null
  layout: string
  vhosts: VhostRow[]
  platform: string
}

const APACHE_STATUS_CACHE_KEY = 'dm:panel:apache-status'

function ErrorModal({
  title,
  body,
  onClose,
  titleId,
}: {
  title: string
  body: string
  onClose: () => void
  titleId: string
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal">
        <div className="modal__head">
          <h2 id={titleId}>{title}</h2>
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

/** Reuses `.nginx-panel*` styles — same layout as the Nginx screen. */
export function ApachePanel() {
  const { fetchJsonWithElevation } = useSudoElevation()
  const { runInTerminal, showTerminal } = useTerminal()
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /** Nginx must be absent before this Apache panel is usable. */
  const [nginxInstalled, setNginxInstalled] = useState(false)

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

  const loadStatus = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = Boolean(opts?.silent)
    if (!silent) {
      setStatusError(null)
      setLoading(true)
    }
    try {
      if (silent) {
        const hit = memoryCacheGet<{
          nginxInstalled: boolean
          apacheData: StatusPayload & { error?: string }
        }>(APACHE_STATUS_CACHE_KEY)
        if (hit) {
          setNginxInstalled(hit.nginxInstalled)
          setStatus(hit.apacheData)
          setVhosts(hit.apacheData.vhosts)
          return
        }
      }
      const [apacheRes, nginxRes] = await Promise.all([
        fetch('/api/apache/status'),
        fetch('/api/nginx/status'),
      ])
      const apacheData = (await apacheRes.json()) as StatusPayload & { error?: string }
      const nginxData = (await nginxRes.json()) as { installed?: boolean }
      setNginxInstalled(Boolean(nginxData.installed))

      if (!apacheRes.ok) {
        if (!silent) {
          setStatus(null)
          setStatusError(apacheData.error || `HTTP ${apacheRes.status}`)
        }
        return
      }
      setStatus(apacheData)
      setVhosts(apacheData.vhosts)
      memoryCacheSet(APACHE_STATUS_CACHE_KEY, {
        nginxInstalled: Boolean(nginxData.installed),
        apacheData,
      })
    } catch (e) {
      if (!silent) {
        setStatus(null)
        setNginxInstalled(false)
        setStatusError(e instanceof Error ? e.message : 'Failed to load Apache status')
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
      const res = await fetch('/api/apache/vhosts')
      if (!res.ok) return
      const data = (await res.json()) as { vhosts: VhostRow[] }
      setVhosts(data.vhosts)
    } catch {
      /* ignore */
    }
  }, [])

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
        const url = `/api/apache/vhosts/${encodeURIComponent(activeId)}`
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
  }, [status?.installed, activeId, fetchJsonWithElevation])

  const startInstallInTerminal = async () => {
    setBanner(null)
    try {
      const res = await fetch('/api/apache/install-command')
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
        `/api/apache/vhosts/${encodeURIComponent(activeId)}`,
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
      const res = await fetch('/api/apache/test', { method: 'POST' })
      const data = (await res.json()) as { ok: boolean; stdout: string; stderr: string }
      if (!data.ok) {
        const body = [data.stderr, data.stdout].filter(Boolean).join('\n---\n')
        setModal({
          title: 'Apache configuration test failed',
          body: body || 'configtest reported an error.',
        })
        return
      }
      setBanner({ type: 'ok', text: 'Configuration syntax OK (apachectl/httpd configtest).' })
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
      const res = await fetch('/api/apache/restart', { method: 'POST' })
      const data = (await res.json()) as { ok?: boolean; message?: string }
      if (!res.ok || !data.ok) {
        setModal({
          title: 'Restart failed',
          body: data.message || `HTTP ${res.status}`,
        })
        return
      }
      setBanner({ type: 'ok', text: data.message || 'Apache restarted.' })
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
        `/api/apache/vhosts/${encodeURIComponent(activeId)}`,
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
      const vr = await fetch('/api/apache/vhosts')
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
      const { res, data } = await fetchJsonWithElevation('/api/apache/vhosts', 'POST', { name })
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

  if (nginxInstalled) {
    return (
      <WebServerConflictGate
        targetName="Apache"
        blockingName="Nginx"
        blockingDetail="the nginx package or binary on PATH"
        uninstallCommandUrl="/api/nginx/uninstall-command"
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
          <h2>Apache is not installed</h2>
          <p className="nginx-install__lead">
            Opens the in-app shell and runs the right install command for your OS (apt installs{' '}
            <code className="host-editor__inline-code">apache2</code>, RHEL-family installs{' '}
            <code className="host-editor__inline-code">httpd</code>, Homebrew installs{' '}
            <code className="host-editor__inline-code">httpd</code>). When it finishes, use{' '}
            <strong>Refresh status</strong> to detect Apache.
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
            Editing configs may require running the dev server with permissions that can read{' '}
            <code className="host-editor__inline-code">/etc/apache2</code> or{' '}
            <code className="host-editor__inline-code">/etc/httpd</code>, or use{' '}
            <code className="host-editor__inline-code">sudo</code> in the terminal.
          </p>
        </div>
      </section>
    )
  }

  return (
    <>
      {modal ? (
        <ErrorModal
          title={modal.title}
          body={modal.body}
          onClose={() => setModal(null)}
          titleId="apache-modal-title"
        />
      ) : null}

      <section className="panel nginx-panel">
        <div className="nginx-panel__toolbar">
          <div className="nginx-panel__meta">
            <span className="nginx-panel__version">
              {status.version}
              {status.kind ? ` (${status.kind})` : ''}
            </span>
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
              {restartBusy ? 'Restarting…' : 'Restart Apache'}
            </button>
          </div>
        </div>

        {banner ? (
          <div className={`nginx-panel__banner nginx-panel__banner--${banner.type}`}>{banner.text}</div>
        ) : null}

        <WebServerVhostTabs
          vhosts={vhosts}
          activeId={activeId}
          tablistLabel="Apache virtual host files"
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
                name="dev-manager-apache-vhost-basename"
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
                aria-label="Apache virtual host configuration"
              />
            )}
          </div>
        )}
      </section>

      <ConfirmDangerModal
        open={deleteVhostConfirmOpen}
        title="Delete virtual host file?"
        titleId="apache-del-vhost-title"
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

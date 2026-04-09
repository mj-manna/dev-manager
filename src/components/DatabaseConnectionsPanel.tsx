import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { notifyAppStorageChanged, STORAGE_CHANGED_EVENT } from '../appData/storageRegistry'
import {
  type ConnectionKind,
  type DbConnection,
  defaultPort,
  kindLabel,
  loadConnections,
  newConnectionId,
  saveConnections,
} from '../database/connectionsStorage'
import { ConfirmDangerModal } from './ConfirmDangerModal'

const emptyForm = (kind: ConnectionKind): Omit<DbConnection, 'id'> => ({
  name: '',
  kind,
  host: '127.0.0.1',
  port: defaultPort(kind),
  username: '',
  database: '',
  password: '',
})

export function DatabaseConnectionsPanel() {
  const navigate = useNavigate()
  const [connections, setConnections] = useState<DbConnection[]>(loadConnections)
  const [banner, setBanner] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  /** When set, modal saves over this connection id instead of appending. */
  const [editingId, setEditingId] = useState<string | null>(null)
  /** Edit mode: empty password + untouched = keep stored password; touched empty = clear. */
  const [passwordTouched, setPasswordTouched] = useState(false)
  const [form, setForm] = useState(() => emptyForm('redis'))
  const [testBusy, setTestBusy] = useState(false)
  const [testHint, setTestHint] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [browseSqlPlanned, setBrowseSqlPlanned] = useState<'mysql' | null>(null)
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null)

  useEffect(() => {
    saveConnections(connections)
  }, [connections])

  useEffect(() => {
    const sync = () => setConnections(loadConnections())
    window.addEventListener(STORAGE_CHANGED_EVENT, sync)
    return () => window.removeEventListener(STORAGE_CHANGED_EVENT, sync)
  }, [])

  const openModal = useCallback(() => {
    setEditingId(null)
    setPasswordTouched(false)
    setForm(emptyForm('redis'))
    setBanner(null)
    setTestHint(null)
    setModalOpen(true)
  }, [])

  const openEditModal = useCallback((c: DbConnection) => {
    setEditingId(c.id)
    setPasswordTouched(false)
    setForm({
      name: c.name,
      kind: c.kind,
      host: c.host,
      port: c.port,
      username: c.username ?? '',
      database: c.database ?? '',
      password: '',
    })
    setBanner(null)
    setTestHint(null)
    setModalOpen(true)
  }, [])

  const closeModal = useCallback(() => {
    setModalOpen(false)
    setEditingId(null)
    setPasswordTouched(false)
    setTestHint(null)
  }, [])

  const testConnection = useCallback(async () => {
    const host = form.host.trim()
    if (!host) {
      setTestHint({ type: 'err', text: 'Enter a host to test.' })
      return
    }
    const port = Number(form.port) || defaultPort(form.kind)
    setTestBusy(true)
    setTestHint(null)
    try {
      const res = await fetch('/api/db/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: form.kind,
          host,
          port,
          username: form.username?.trim(),
          database: form.database?.trim(),
          password: form.password?.trim() || undefined,
        }),
      })
      const data = (await res.json()) as { ok?: boolean; detail?: string; error?: string }
      if (!res.ok) {
        setTestHint({ type: 'err', text: data.error || `HTTP ${res.status}` })
        return
      }
      if (data.ok) {
        setTestHint({ type: 'ok', text: data.detail || 'Connection OK.' })
      } else {
        setTestHint({ type: 'err', text: data.error || 'Connection failed.' })
      }
    } catch (e) {
      setTestHint({
        type: 'err',
        text: e instanceof Error ? e.message : 'Request failed.',
      })
    } finally {
      setTestBusy(false)
    }
  }, [form])

  const saveConnection = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      const name = form.name.trim()
      if (!name) {
        setBanner({ type: 'err', text: 'Enter a display name.' })
        return
      }
      const host = form.host.trim() || '127.0.0.1'
      const kind = form.kind
      const username = kind === 'redis' ? undefined : form.username?.trim() || undefined
      const database = kind === 'redis' ? undefined : form.database?.trim() || undefined
      const trimmedPw = form.password?.trim() ?? ''

      if (editingId) {
        setConnections((prev) => {
          const idx = prev.findIndex((c) => c.id === editingId)
          if (idx < 0) return prev
          const prevRow = prev[idx]!
          let password = prevRow.password
          if (passwordTouched) {
            password = trimmedPw || undefined
          }
          const next = [...prev]
          next[idx] = {
            ...prevRow,
            name,
            kind,
            host,
            port: Number(form.port) || defaultPort(kind),
            username,
            database,
            password,
          }
          return next
        })
        notifyAppStorageChanged()
        closeModal()
        setBanner({ type: 'ok', text: 'Updated.' })
        return
      }

      const row: DbConnection = {
        id: newConnectionId(),
        name,
        kind,
        host,
        port: Number(form.port) || defaultPort(kind),
        username,
        database,
        password: trimmedPw || undefined,
      }
      setConnections((prev) => [...prev, row])
      closeModal()
      setBanner({ type: 'ok', text: 'Saved.' })
    },
    [form, editingId, passwordTouched, closeModal],
  )

  const confirmRemoveConnection = useCallback(() => {
    if (!removeConfirmId) return
    const id = removeConfirmId
    setConnections((prev) => {
      const next = prev.filter((c) => c.id !== id)
      saveConnections(next)
      notifyAppStorageChanged()
      return next
    })
    setRemoveConfirmId(null)
    setBanner(null)
  }, [removeConfirmId])

  const removeTarget = removeConfirmId ? connections.find((c) => c.id === removeConfirmId) : undefined

  const openBrowse = useCallback(
    (c: DbConnection) => {
      if (c.kind === 'redis' || c.kind === 'postgresql') {
        const inst = crypto.randomUUID()
        const q = new URLSearchParams()
        q.set('tab', c.id)
        q.set('inst', inst)
        navigate(`/database?${q.toString()}`)
        return
      }
      if (c.kind === 'mysql') {
        setBrowseSqlPlanned('mysql')
      }
    },
    [navigate],
  )

  return (
    <section className="panel database-connections-panel">
      <div className="panel__head">
        <h2>Connections</h2>
        <button type="button" className="btn btn--primary" onClick={openModal}>
          Add connection
        </button>
      </div>

      <p className="database-connections-panel__sub database-connections-panel__sub--inline">
        <NavLink to="/database/postgresql-admin">PostgreSQL server admin</NavLink>
      </p>

      {banner ? (
        <div className={`host-editor__banner host-editor__banner--${banner.type}`}>{banner.text}</div>
      ) : null}

      <div className="database-connections-panel__body">
        {connections.length === 0 ? (
          <p className="database-connections-panel__empty">No connections yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Host:port</th>
                  <th scope="col">Details</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className="data-table__name">{c.name}</span>
                    </td>
                    <td>{kindLabel(c.kind)}</td>
                    <td>
                      <code className="host-editor__inline-code">
                        {c.host}:{c.port}
                      </code>
                    </td>
                    <td className="database-connections-panel__details">
                      {c.kind !== 'redis' ? (
                        <>
                          {c.username ? (
                            <span>
                              User <code className="host-editor__inline-code">{c.username}</code>
                            </span>
                          ) : null}
                          {c.database ? (
                            <span>
                              {' '}
                              · DB <code className="host-editor__inline-code">{c.database}</code>
                            </span>
                          ) : null}
                          {!c.username && !c.database ? '—' : null}
                        </>
                      ) : c.password ? (
                        <span className="database-connections-panel__muted">password set</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <div className="database-connections-panel__actions">
                        <button
                          type="button"
                          className="btn btn--ghost btn--xs"
                          onClick={() => openBrowse(c)}
                        >
                          Browse
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--xs"
                          onClick={() => openEditModal(c)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn--danger btn--xs"
                          onClick={() => setRemoveConfirmId(c.id)}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalOpen ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="db-conn-modal-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeModal()
          }}
        >
          <form className="modal database-connections-modal" onSubmit={saveConnection}>
            <div className="modal__head">
              <h2 id="db-conn-modal-title">{editingId ? 'Edit connection' : 'New connection'}</h2>
              <button
                type="button"
                className="modal__close"
                aria-label="Close"
                onClick={closeModal}
              >
                ×
              </button>
            </div>
            <div className="modal__body database-connections-modal__body">
              <div className="database-connections-panel__grid">
                <label className="database-connections-panel__field">
                  <span>Type</span>
                  <select
                    className="database-connections-panel__input"
                    value={form.kind}
                    disabled={editingId !== null}
                    title={editingId ? 'Type cannot be changed when editing' : undefined}
                    aria-disabled={editingId !== null}
                    onChange={(e) => {
                      const k = e.target.value as ConnectionKind
                      setForm((f) => ({
                        ...f,
                        kind: k,
                        port: defaultPort(k),
                      }))
                    }}
                  >
                    <option value="redis">Redis</option>
                    <option value="mysql">MySQL</option>
                    <option value="postgresql">PostgreSQL</option>
                  </select>
                </label>
                <label className="database-connections-panel__field">
                  <span>Name</span>
                  <input
                    className="database-connections-panel__input"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="Display name"
                    autoComplete="off"
                    autoFocus={!editingId}
                  />
                </label>
                <label className="database-connections-panel__field">
                  <span>Host</span>
                  <input
                    className="database-connections-panel__input"
                    value={form.host}
                    onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
                    placeholder="127.0.0.1"
                    autoComplete="off"
                  />
                </label>
                <label className="database-connections-panel__field">
                  <span>Port</span>
                  <input
                    className="database-connections-panel__input"
                    type="number"
                    min={1}
                    max={65535}
                    value={form.port}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, port: Number(e.target.value) || defaultPort(f.kind) }))
                    }
                  />
                </label>
                {form.kind !== 'redis' ? (
                  <>
                    <label className="database-connections-panel__field">
                      <span>User</span>
                      <input
                        className="database-connections-panel__input"
                        value={form.username}
                        onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                        placeholder={form.kind === 'mysql' ? 'root' : 'postgres'}
                        autoComplete="off"
                      />
                    </label>
                    <label className="database-connections-panel__field">
                      <span>Database</span>
                      <input
                        className="database-connections-panel__input"
                        value={form.database}
                        onChange={(e) => setForm((f) => ({ ...f, database: e.target.value }))}
                        placeholder="optional"
                        autoComplete="off"
                      />
                    </label>
                    <label className="database-connections-panel__field database-connections-panel__field--wide">
                      <span>Password (optional)</span>
                      <input
                        className="database-connections-panel__input"
                        type="password"
                        value={form.password}
                        placeholder={editingId ? 'Unchanged if empty' : undefined}
                        onChange={(e) => {
                          setPasswordTouched(true)
                          setForm((f) => ({ ...f, password: e.target.value }))
                        }}
                        autoComplete="new-password"
                      />
                    </label>
                  </>
                ) : (
                  <label className="database-connections-panel__field database-connections-panel__field--wide">
                    <span>Password (optional)</span>
                    <input
                      className="database-connections-panel__input"
                      type="password"
                      value={form.password}
                      placeholder={editingId ? 'Unchanged if empty' : undefined}
                      onChange={(e) => {
                        setPasswordTouched(true)
                        setForm((f) => ({ ...f, password: e.target.value }))
                      }}
                      autoComplete="new-password"
                    />
                  </label>
                )}
              </div>
              {testHint ? (
                <p
                  className={`database-connections-modal__test-hint database-connections-modal__test-hint--${testHint.type}`}
                  role="status"
                >
                  {testHint.text}
                </p>
              ) : null}
            </div>
            <div className="modal__foot modal__foot--split">
              <button
                type="button"
                className="btn btn--ghost"
                disabled={testBusy}
                onClick={() => void testConnection()}
              >
                {testBusy ? 'Testing…' : 'Test connection'}
              </button>
              <div className="modal__foot-actions">
                <button type="button" className="btn btn--ghost" onClick={closeModal}>
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary">
                  {editingId ? 'Save changes' : 'Save connection'}
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : null}

      {browseSqlPlanned === 'mysql' ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="db-browse-planned-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setBrowseSqlPlanned(null)
          }}
        >
          <div className="modal database-connections-modal db-browse-planned-modal">
            <div className="modal__head">
              <h2 id="db-browse-planned-title">MySQL</h2>
              <button
                type="button"
                className="modal__close"
                aria-label="Close"
                onClick={() => setBrowseSqlPlanned(null)}
              >
                ×
              </button>
            </div>
            <div className="modal__body database-connections-modal__body db-browse-planned-modal__body">
              <p>In-app browsing is not available for {kindLabel(browseSqlPlanned)} yet.</p>
            </div>
            <div className="modal__foot">
              <button type="button" className="btn btn--primary" onClick={() => setBrowseSqlPlanned(null)}>
                OK
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmDangerModal
        open={removeConfirmId !== null}
        title="Remove connection?"
        titleId="db-conn-remove-title"
        message={
          <>
            Remove <strong>{removeTarget?.name ?? 'this connection'}</strong>? This only affects this browser.
          </>
        }
        confirmLabel="Remove"
        onCancel={() => setRemoveConfirmId(null)}
        onConfirm={confirmRemoveConnection}
      />
    </section>
  )
}

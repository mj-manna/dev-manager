import { useCallback, useEffect, useRef, useState } from 'react'

const FIELDS_KEY = 'dev-manager-pg-admin-fields-v1'

type OverviewDb = { name: string; owner: string }
type OverviewRole = { name: string; canLogin: boolean; isSuper: boolean }

type PgAdminTab = 'connect' | 'databases' | 'access'

function loadSavedFields(): { host: string; port: string; username: string; database: string } {
  try {
    const raw = localStorage.getItem(FIELDS_KEY)
    if (!raw) return { host: '127.0.0.1', port: '5432', username: 'postgres', database: 'postgres' }
    const o = JSON.parse(raw) as Record<string, unknown>
    return {
      host: typeof o.host === 'string' ? o.host : '127.0.0.1',
      port: typeof o.port === 'string' ? o.port : String(o.port ?? '5432'),
      username: typeof o.username === 'string' ? o.username : 'postgres',
      database: typeof o.database === 'string' ? o.database : 'postgres',
    }
  } catch {
    return { host: '127.0.0.1', port: '5432', username: 'postgres', database: 'postgres' }
  }
}

function saveFields(f: { host: string; port: string; username: string; database: string }) {
  try {
    localStorage.setItem(FIELDS_KEY, JSON.stringify(f))
  } catch {
    /* ignore */
  }
}

function connBody(
  host: string,
  port: number,
  username: string,
  password: string,
  database: string,
) {
  return {
    host: host.trim(),
    port,
    username: username.trim() || 'postgres',
    password: password || undefined,
    database: database.trim() || 'postgres',
  }
}

export function PostgresLocalAdminPanel() {
  const saved = loadSavedFields()
  const [host, setHost] = useState(saved.host)
  const [port, setPort] = useState(saved.port)
  const [username, setUsername] = useState(saved.username)
  const [adminDatabase, setAdminDatabase] = useState(saved.database)
  const [password, setPassword] = useState('')

  const [tab, setTab] = useState<PgAdminTab>('connect')
  const catalogLoadedOnceRef = useRef(false)

  const [databases, setDatabases] = useState<OverviewDb[]>([])
  const [roles, setRoles] = useState<OverviewRole[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const [newDbName, setNewDbName] = useState('')
  const [newRoleName, setNewRoleName] = useState('')
  const [newRolePassword, setNewRolePassword] = useState('')
  const [newRoleLogin, setNewRoleLogin] = useState(true)

  const [grantDb, setGrantDb] = useState('')
  const [grantRole, setGrantRole] = useState('')

  const [pwdRole, setPwdRole] = useState('')
  const [pwdNew, setPwdNew] = useState('')

  useEffect(() => {
    saveFields({ host, port, username, database: adminDatabase })
  }, [host, port, username, adminDatabase])

  const showBanner = useCallback((type: 'ok' | 'err', text: string) => {
    setBanner({ type, text })
    if (type === 'ok') {
      window.setTimeout(() => setBanner(null), 5000)
    }
  }, [])

  const refresh = useCallback(async () => {
    const p = Number(port) || 5432
    if (!host.trim()) {
      showBanner('err', 'Enter host.')
      return
    }
    setBusy(true)
    setBanner(null)
    try {
      const res = await fetch('/api/db/postgres-admin/overview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(connBody(host, p, username, password, adminDatabase)),
      })
      const data = (await res.json()) as {
        ok?: boolean
        databases?: OverviewDb[]
        roles?: OverviewRole[]
        error?: string
      }
      if (!data.ok) {
        setLoaded(false)
        catalogLoadedOnceRef.current = false
        setDatabases([])
        setRoles([])
        showBanner('err', data.error || 'Could not load server overview.')
        return
      }
      setDatabases(data.databases ?? [])
      setRoles(data.roles ?? [])
      setLoaded(true)
      if (!catalogLoadedOnceRef.current) {
        catalogLoadedOnceRef.current = true
        setTab('databases')
      }
      setGrantDb((prev) => {
        if (prev) return prev
        return data.databases?.[0]?.name ?? ''
      })
      setGrantRole((prev) => {
        if (prev) return prev
        const list = data.roles ?? []
        const r = list.find((x) => x.canLogin) ?? list[0]
        return r?.name ?? ''
      })
      setPwdRole((prev) => {
        if (prev) return prev
        return data.roles?.[0]?.name ?? ''
      })
    } catch (e) {
      setLoaded(false)
      catalogLoadedOnceRef.current = false
      showBanner('err', e instanceof Error ? e.message : 'Request failed.')
    } finally {
      setBusy(false)
    }
  }, [host, port, username, password, adminDatabase, showBanner])

  const postAdmin = useCallback(
    async (path: string, extra: Record<string, unknown>) => {
      const p = Number(port) || 5432
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...connBody(host, p, username, password, adminDatabase),
          ...extra,
        }),
      })
      return (await res.json()) as { ok?: boolean; error?: string }
    },
    [host, port, username, password, adminDatabase],
  )

  const createDatabase = async () => {
    const name = newDbName.trim()
    if (!name) {
      showBanner('err', 'Enter a database name.')
      return
    }
    setBusy(true)
    setBanner(null)
    try {
      const data = await postAdmin('/api/db/postgres-admin/create-database', { newDatabase: name })
      if (!data.ok) {
        showBanner('err', data.error || 'Create failed.')
        return
      }
      setNewDbName('')
      showBanner('ok', `Database “${name}” created.`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const createRole = async () => {
    const name = newRoleName.trim()
    if (!name) {
      showBanner('err', 'Enter a role name.')
      return
    }
    if (newRoleLogin && !newRolePassword.trim()) {
      showBanner('err', 'Enter a password for a login role.')
      return
    }
    setBusy(true)
    setBanner(null)
    try {
      const data = await postAdmin('/api/db/postgres-admin/create-role', {
        newRole: name,
        newPassword: newRolePassword,
        login: newRoleLogin,
      })
      if (!data.ok) {
        showBanner('err', data.error || 'Create role failed.')
        return
      }
      setNewRoleName('')
      setNewRolePassword('')
      showBanner('ok', `Role “${name}” created.`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const changePassword = async () => {
    if (!pwdRole.trim()) {
      showBanner('err', 'Pick a role.')
      return
    }
    if (!pwdNew) {
      showBanner('err', 'Enter a new password.')
      return
    }
    setBusy(true)
    setBanner(null)
    try {
      const data = await postAdmin('/api/db/postgres-admin/alter-password', {
        roleName: pwdRole.trim(),
        newPassword: pwdNew,
      })
      if (!data.ok) {
        showBanner('err', data.error || 'Password change failed.')
        return
      }
      setPwdNew('')
      showBanner('ok', `Password updated for “${pwdRole}”.`)
    } finally {
      setBusy(false)
    }
  }

  const grantConnect = async () => {
    if (!grantDb.trim() || !grantRole.trim()) {
      showBanner('err', 'Select database and role.')
      return
    }
    setBusy(true)
    setBanner(null)
    try {
      const data = await postAdmin('/api/db/postgres-admin/grant-connect', {
        grantDatabase: grantDb.trim(),
        grantRole: grantRole.trim(),
      })
      if (!data.ok) {
        showBanner('err', data.error || 'Grant failed.')
        return
      }
      showBanner('ok', `CONNECT on “${grantDb}” granted to “${grantRole}”.`)
    } finally {
      setBusy(false)
    }
  }

  const connectionSummary = `${username || 'postgres'}@${host.trim() || '…'}:${port || '5432'}`
  const tabDisabled = !loaded

  return (
    <section className="panel pg-admin-panel">
      <div className="panel__head">
        <div>
          <h2>PostgreSQL server</h2>
          <p className="database-connections-panel__sub">
            Manage clusters you can reach from this machine: catalogs, roles, database access, and login passwords.
            Uses a single privileged session (often the <code className="host-editor__inline-code">postgres</code> user).
          </p>
        </div>
      </div>

      <p className="database-connections-panel__warn">
        Needs <code className="host-editor__inline-code">CREATEDB</code> / <code className="host-editor__inline-code">CREATEROLE</code>{' '}
        or superuser. Host and user are remembered in this browser; password is not saved.
      </p>

      {banner ? (
        <div className={`host-editor__banner host-editor__banner--${banner.type} pg-admin-panel__banner`}>
          {banner.text}
        </div>
      ) : null}

      <div className="pg-admin-panel__body">
        <div className="pg-admin-panel__chrome">
          <div className="pg-admin-panel__tabs" role="tablist" aria-label="PostgreSQL admin sections">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'connect'}
              className={`pg-admin-panel__tab${tab === 'connect' ? ' pg-admin-panel__tab--active' : ''}`}
              onClick={() => setTab('connect')}
            >
              <span className="pg-admin-panel__tab-step">1</span>
              Connect
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'databases'}
              disabled={tabDisabled}
              title={tabDisabled ? 'Connect successfully first' : undefined}
              className={`pg-admin-panel__tab${tab === 'databases' ? ' pg-admin-panel__tab--active' : ''}`}
              onClick={() => setTab('databases')}
            >
              <span className="pg-admin-panel__tab-step">2</span>
              Databases
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'access'}
              disabled={tabDisabled}
              title={tabDisabled ? 'Connect successfully first' : undefined}
              className={`pg-admin-panel__tab${tab === 'access' ? ' pg-admin-panel__tab--active' : ''}`}
              onClick={() => setTab('access')}
            >
              <span className="pg-admin-panel__tab-step">3</span>
              Roles &amp; access
            </button>
          </div>
          {loaded ? (
            <div className="pg-admin-panel__status" aria-live="polite">
              <span className="pg-admin-panel__status-dot" aria-hidden />
              <span className="pg-admin-panel__status-text">{connectionSummary}</span>
              <span className="pg-admin-panel__status-meta">
                {databases.length} databases · {roles.length} roles
              </span>
              <button type="button" className="btn btn--ghost btn--xs" disabled={busy} onClick={() => void refresh()}>
                Refresh catalog
              </button>
            </div>
          ) : null}
        </div>

        <div className="pg-admin-panel__panels">
          {tab === 'connect' ? (
            <div className="pg-admin-panel__tab-panel" role="tabpanel">
              <div className="pg-admin-panel__card">
                <h3 className="pg-admin-panel__card-title">Server &amp; session</h3>
                <p className="pg-admin-panel__lead">
                  Enter where PostgreSQL listens and which account to use for admin commands. The session attaches to the
                  database below (usually <code className="host-editor__inline-code">postgres</code>) to run catalog queries.
                </p>
                <div className="pg-admin-panel__field-groups">
                  <div className="pg-admin-panel__field-group">
                    <span className="pg-admin-panel__field-group-label">Network</span>
                    <div className="database-connections-panel__grid">
                      <label className="database-connections-panel__field">
                        <span>Host</span>
                        <input
                          className="database-connections-panel__input"
                          value={host}
                          onChange={(e) => setHost(e.target.value)}
                          autoComplete="off"
                        />
                      </label>
                      <label className="database-connections-panel__field">
                        <span>Port</span>
                        <input
                          className="database-connections-panel__input"
                          value={port}
                          onChange={(e) => setPort(e.target.value)}
                          inputMode="numeric"
                          autoComplete="off"
                        />
                      </label>
                    </div>
                  </div>
                  <div className="pg-admin-panel__field-group">
                    <span className="pg-admin-panel__field-group-label">Account</span>
                    <div className="database-connections-panel__grid">
                      <label className="database-connections-panel__field">
                        <span>User</span>
                        <input
                          className="database-connections-panel__input"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          autoComplete="username"
                        />
                      </label>
                      <label className="database-connections-panel__field">
                        <span>Session database</span>
                        <input
                          className="database-connections-panel__input"
                          value={adminDatabase}
                          onChange={(e) => setAdminDatabase(e.target.value)}
                          placeholder="postgres"
                          title="Initial database for the admin connection"
                          autoComplete="off"
                        />
                      </label>
                      <label className="database-connections-panel__field database-connections-panel__field--wide">
                        <span>Password</span>
                        <input
                          className="database-connections-panel__input"
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="Only kept in memory for this tab"
                          autoComplete="current-password"
                        />
                      </label>
                    </div>
                  </div>
                </div>
                <div className="pg-admin-panel__actions">
                  <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void refresh()}>
                    {busy ? 'Connecting…' : 'Connect and load catalog'}
                  </button>
                  {loaded ? (
                    <p className="pg-admin-panel__next-hint">
                      Catalog loaded — use <strong>Databases</strong> and <strong>Roles &amp; access</strong> tabs above.
                    </p>
                  ) : (
                    <p className="pg-admin-panel__next-hint pg-admin-panel__next-hint--muted">
                      After a successful connection you can create databases, roles, grants, and change passwords.
                    </p>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {tab === 'databases' && loaded ? (
            <div className="pg-admin-panel__tab-panel" role="tabpanel">
              <div className="pg-admin-panel__card">
                <h3 className="pg-admin-panel__card-title">Database catalog</h3>
                <p className="pg-admin-panel__lead">
                  Non-template databases on this server. Owner is the creating role (often used for ownership of objects
                  inside the DB).
                </p>
                <div className="table-wrap pg-admin-panel__table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Owner</th>
                      </tr>
                    </thead>
                    <tbody>
                      {databases.map((d) => (
                        <tr key={d.name}>
                          <td>
                            <code className="host-editor__inline-code">{d.name}</code>
                          </td>
                          <td className="database-connections-panel__muted">{d.owner || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="pg-admin-panel__card pg-admin-panel__card--accent">
                <h3 className="pg-admin-panel__card-title">Create a database</h3>
                <p className="pg-admin-panel__lead">
                  Name must match PostgreSQL rules (letter or underscore, then letters, digits, underscores; max 63
                  characters).
                </p>
                <div className="pg-admin-panel__create-row">
                  <label className="pg-admin-panel__create-label">
                    <span className="visually-hidden">New database name</span>
                    <input
                      className="database-connections-panel__input"
                      placeholder="e.g. myapp_dev"
                      value={newDbName}
                      onChange={(e) => setNewDbName(e.target.value)}
                      aria-label="New database name"
                    />
                  </label>
                  <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void createDatabase()}>
                    Create database
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {tab === 'access' && loaded ? (
            <div className="pg-admin-panel__tab-panel" role="tabpanel">
              <div className="pg-admin-panel__card">
                <h3 className="pg-admin-panel__card-title">Roles</h3>
                <p className="pg-admin-panel__lead">
                  Built-in <code className="host-editor__inline-code">pg_*</code> roles are hidden. <strong>Login</strong>{' '}
                  means the role can authenticate; <strong>Super</strong> is full cluster admin.
                </p>
                <div className="table-wrap pg-admin-panel__table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Login</th>
                        <th scope="col">Superuser</th>
                      </tr>
                    </thead>
                    <tbody>
                      {roles.map((r) => (
                        <tr key={r.name}>
                          <td>
                            <code className="host-editor__inline-code">{r.name}</code>
                          </td>
                          <td>{r.canLogin ? 'Yes' : 'No'}</td>
                          <td>{r.isSuper ? 'Yes' : 'No'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="pg-admin-panel__card pg-admin-panel__card--accent">
                <h3 className="pg-admin-panel__card-title">Create a role</h3>
                <p className="pg-admin-panel__lead">
                  Login roles need a password. Turn off <strong>Login</strong> for a group role (no direct sign-in).
                </p>
                <div className="pg-admin-panel__stack-form">
                  <div className="pg-admin-panel__row">
                    <input
                      className="database-connections-panel__input"
                      placeholder="role_name"
                      value={newRoleName}
                      onChange={(e) => setNewRoleName(e.target.value)}
                      aria-label="New role name"
                    />
                    <label className="pg-admin-panel__check">
                      <input
                        type="checkbox"
                        checked={newRoleLogin}
                        onChange={(e) => setNewRoleLogin(e.target.checked)}
                      />
                      Can log in
                    </label>
                  </div>
                  {newRoleLogin ? (
                    <input
                      className="database-connections-panel__input"
                      type="password"
                      placeholder="Password for this role"
                      value={newRolePassword}
                      onChange={(e) => setNewRolePassword(e.target.value)}
                      aria-label="New role password"
                    />
                  ) : null}
                  <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void createRole()}>
                    Create role
                  </button>
                </div>
              </div>

              <div className="pg-admin-panel__card">
                <h3 className="pg-admin-panel__card-title">Allow connecting to a database</h3>
                <p className="pg-admin-panel__lead">
                  Grants <code className="host-editor__inline-code">CONNECT</code> on the chosen database to the role.
                  Table and schema permissions are separate.
                </p>
                <div className="pg-admin-panel__grant-grid">
                  <label className="pg-admin-panel__grant-field">
                    <span>Database</span>
                    <select
                      className="database-connections-panel__input"
                      value={grantDb}
                      onChange={(e) => setGrantDb(e.target.value)}
                      aria-label="Database for grant"
                    >
                      <option value="">Choose database…</option>
                      {databases.map((d) => (
                        <option key={d.name} value={d.name}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="pg-admin-panel__grant-field">
                    <span>Role</span>
                    <select
                      className="database-connections-panel__input"
                      value={grantRole}
                      onChange={(e) => setGrantRole(e.target.value)}
                      aria-label="Role for grant"
                    >
                      <option value="">Choose role…</option>
                      {roles.map((r) => (
                        <option key={r.name} value={r.name}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="pg-admin-panel__grant-action">
                    <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void grantConnect()}>
                      Grant CONNECT
                    </button>
                  </div>
                </div>
              </div>

              <div className="pg-admin-panel__card">
                <h3 className="pg-admin-panel__card-title">Change a login password</h3>
                <p className="pg-admin-panel__lead">Runs <code className="host-editor__inline-code">ALTER ROLE … PASSWORD</code> for the selected role.</p>
                <div className="pg-admin-panel__grant-grid">
                  <label className="pg-admin-panel__grant-field">
                    <span>Role</span>
                    <select
                      className="database-connections-panel__input"
                      value={pwdRole}
                      onChange={(e) => setPwdRole(e.target.value)}
                      aria-label="Role to change password"
                    >
                      {roles.map((r) => (
                        <option key={r.name} value={r.name}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="pg-admin-panel__grant-field pg-admin-panel__grant-field--grow">
                    <span>New password</span>
                    <input
                      className="database-connections-panel__input"
                      type="password"
                      value={pwdNew}
                      onChange={(e) => setPwdNew(e.target.value)}
                      autoComplete="new-password"
                    />
                  </label>
                  <div className="pg-admin-panel__grant-action">
                    <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void changePassword()}>
                      Update password
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

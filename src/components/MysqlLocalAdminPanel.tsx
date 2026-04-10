import { useCallback, useEffect, useRef, useState } from 'react'

const FIELDS_KEY = 'dev-manager-mysql-admin-fields-v1'

type OverviewDb = { name: string }
type OverviewUser = { user: string; host: string }

type MysqlAdminTab = 'connect' | 'databases' | 'access'

function accountKey(u: OverviewUser): string {
  return `${u.user}\t${u.host}`
}

function loadSavedFields(): { host: string; port: string; username: string; database: string } {
  try {
    const raw = localStorage.getItem(FIELDS_KEY)
    if (!raw) return { host: '127.0.0.1', port: '3306', username: 'root', database: 'mysql' }
    const o = JSON.parse(raw) as Record<string, unknown>
    return {
      host: typeof o.host === 'string' ? o.host : '127.0.0.1',
      port: typeof o.port === 'string' ? o.port : String(o.port ?? '3306'),
      username: typeof o.username === 'string' ? o.username : 'root',
      database: typeof o.database === 'string' ? o.database : 'mysql',
    }
  } catch {
    return { host: '127.0.0.1', port: '3306', username: 'root', database: 'mysql' }
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
    username: username.trim() || 'root',
    password: password || undefined,
    database: database.trim() || 'mysql',
  }
}

export function MysqlLocalAdminPanel() {
  const saved = loadSavedFields()
  const [host, setHost] = useState(saved.host)
  const [port, setPort] = useState(saved.port)
  const [username, setUsername] = useState(saved.username)
  const [adminDatabase, setAdminDatabase] = useState(saved.database)
  const [password, setPassword] = useState('')

  const [tab, setTab] = useState<MysqlAdminTab>('connect')
  const catalogLoadedOnceRef = useRef(false)

  const [databases, setDatabases] = useState<OverviewDb[]>([])
  const [users, setUsers] = useState<OverviewUser[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const [newDbName, setNewDbName] = useState('')
  const [newUserName, setNewUserName] = useState('')
  const [newUserHost, setNewUserHost] = useState('%')
  const [newUserPassword, setNewUserPassword] = useState('')

  const [grantDb, setGrantDb] = useState('')
  const [grantAccount, setGrantAccount] = useState('')

  const [pwdAccount, setPwdAccount] = useState('')
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
    const p = Number(port) || 3306
    if (!host.trim()) {
      showBanner('err', 'Enter host.')
      return
    }
    setBusy(true)
    setBanner(null)
    try {
      const res = await fetch('/api/db/mysql-admin/overview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(connBody(host, p, username, password, adminDatabase)),
      })
      const data = (await res.json()) as {
        ok?: boolean
        databases?: OverviewDb[]
        users?: OverviewUser[]
        error?: string
      }
      if (!data.ok) {
        setLoaded(false)
        catalogLoadedOnceRef.current = false
        setDatabases([])
        setUsers([])
        showBanner('err', data.error || 'Could not load server overview.')
        return
      }
      const dbs = data.databases ?? []
      const ulist = data.users ?? []
      setDatabases(dbs)
      setUsers(ulist)
      setLoaded(true)
      if (!catalogLoadedOnceRef.current) {
        catalogLoadedOnceRef.current = true
        setTab('databases')
      }
      setGrantDb((prev) => {
        if (prev) return prev
        return dbs[0]?.name ?? ''
      })
      setGrantAccount((prev) => {
        if (prev) return prev
        return ulist[0] ? accountKey(ulist[0]) : ''
      })
      setPwdAccount((prev) => {
        if (prev) return prev
        return ulist[0] ? accountKey(ulist[0]) : ''
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
      const p = Number(port) || 3306
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
      const data = await postAdmin('/api/db/mysql-admin/create-database', { newDatabase: name })
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

  const createUser = async () => {
    const name = newUserName.trim()
    if (!name) {
      showBanner('err', 'Enter a user name.')
      return
    }
    if (!newUserPassword.trim()) {
      showBanner('err', 'Enter a password.')
      return
    }
    setBusy(true)
    setBanner(null)
    try {
      const data = await postAdmin('/api/db/mysql-admin/create-user', {
        newUser: name,
        newHost: newUserHost.trim() || '%',
        newPassword: newUserPassword,
      })
      if (!data.ok) {
        showBanner('err', data.error || 'Create user failed.')
        return
      }
      setNewUserName('')
      setNewUserPassword('')
      showBanner('ok', `User “${name}” @ “${newUserHost.trim() || '%'}” created.`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const changePassword = async () => {
    if (!pwdAccount.includes('\t')) {
      showBanner('err', 'Pick an account.')
      return
    }
    if (!pwdNew) {
      showBanner('err', 'Enter a new password.')
      return
    }
    const [u, h] = pwdAccount.split('\t')
    if (!u || h === undefined) {
      showBanner('err', 'Pick an account.')
      return
    }
    setBusy(true)
    setBanner(null)
    try {
      const data = await postAdmin('/api/db/mysql-admin/alter-password', {
        accountUser: u,
        accountHost: h,
        newPassword: pwdNew,
      })
      if (!data.ok) {
        showBanner('err', data.error || 'Password change failed.')
        return
      }
      setPwdNew('')
      showBanner('ok', `Password updated for “${u}”@“${h}”.`)
    } finally {
      setBusy(false)
    }
  }

  const grantDatabaseAccess = async () => {
    if (!grantDb.trim() || !grantAccount.includes('\t')) {
      showBanner('err', 'Select database and account.')
      return
    }
    const [u, h] = grantAccount.split('\t')
    if (!u || h === undefined) {
      showBanner('err', 'Select database and account.')
      return
    }
    setBusy(true)
    setBanner(null)
    try {
      const data = await postAdmin('/api/db/mysql-admin/grant-database', {
        grantDatabase: grantDb.trim(),
        grantUser: u,
        grantHost: h,
      })
      if (!data.ok) {
        showBanner('err', data.error || 'Grant failed.')
        return
      }
      showBanner('ok', `ALL PRIVILEGES on “${grantDb}”.* granted to “${u}”@“${h}”.`)
    } finally {
      setBusy(false)
    }
  }

  const connectionSummary = `${username || 'root'}@${host.trim() || '…'}:${port || '3306'}`
  const tabDisabled = !loaded

  return (
    <section className="panel pg-admin-panel">
      <div className="panel__head">
        <div>
          <h2>MySQL server</h2>
          <p className="database-connections-panel__sub">
            Manage instances you can reach from this machine: databases, accounts (<code className="host-editor__inline-code">user</code>@<code className="host-editor__inline-code">host</code>), grants, and passwords.
            Uses one privileged session (often <code className="host-editor__inline-code">root</code>).
          </p>
        </div>
      </div>

      <p className="database-connections-panel__warn">
        Needs global privileges such as <code className="host-editor__inline-code">CREATE USER</code>,{' '}
        <code className="host-editor__inline-code">CREATE</code>, and access to <code className="host-editor__inline-code">mysql</code> system tables.
        Host and user are remembered in this browser; password is not saved.
      </p>

      {banner ? (
        <div className={`host-editor__banner host-editor__banner--${banner.type} pg-admin-panel__banner`}>
          {banner.text}
        </div>
      ) : null}

      <div className="pg-admin-panel__body">
        <div className="pg-admin-panel__chrome">
          <div className="pg-admin-panel__tabs" role="tablist" aria-label="MySQL admin sections">
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
              Accounts &amp; access
            </button>
          </div>
          {loaded ? (
            <div className="pg-admin-panel__status" aria-live="polite">
              <span className="pg-admin-panel__status-dot" aria-hidden />
              <span className="pg-admin-panel__status-text">{connectionSummary}</span>
              <span className="pg-admin-panel__status-meta">
                {databases.length} databases · {users.length} accounts
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
                  Enter where MySQL listens and which account to use. The session uses the database below (often{' '}
                  <code className="host-editor__inline-code">mysql</code>) to read <code className="host-editor__inline-code">mysql.user</code> and run DDL.
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
                          placeholder="mysql"
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
                      Catalog loaded — use <strong>Databases</strong> and <strong>Accounts &amp; access</strong> tabs above.
                    </p>
                  ) : (
                    <p className="pg-admin-panel__next-hint pg-admin-panel__next-hint--muted">
                      After a successful connection you can create databases and users, grant access, and change passwords.
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
                  User schemas on this server (system schemas such as <code className="host-editor__inline-code">mysql</code> are hidden).
                </p>
                <div className="table-wrap pg-admin-panel__table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                      </tr>
                    </thead>
                    <tbody>
                      {databases.map((d) => (
                        <tr key={d.name}>
                          <td>
                            <code className="host-editor__inline-code">{d.name}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="pg-admin-panel__card pg-admin-panel__card--accent">
                <h3 className="pg-admin-panel__card-title">Create a database</h3>
                <p className="pg-admin-panel__lead">
                  Name: letter or underscore, then letters, digits, underscores (same style as saved connections); max 63 characters.
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
                <h3 className="pg-admin-panel__card-title">Accounts</h3>
                <p className="pg-admin-panel__lead">
                  Each row is a <code className="host-editor__inline-code">user</code>@<code className="host-editor__inline-code">host</code> login allowed by the server. Built-in{' '}
                  <code className="host-editor__inline-code">mysql.*</code> service users are omitted where possible.
                </p>
                <div className="table-wrap pg-admin-panel__table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">User</th>
                        <th scope="col">Host</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((r) => (
                        <tr key={accountKey(r)}>
                          <td>
                            <code className="host-editor__inline-code">{r.user}</code>
                          </td>
                          <td>
                            <code className="host-editor__inline-code">{r.host}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="pg-admin-panel__card pg-admin-panel__card--accent">
                <h3 className="pg-admin-panel__card-title">Create a user</h3>
                <p className="pg-admin-panel__lead">
                  Creates <code className="host-editor__inline-code">CREATE USER … IDENTIFIED BY …</code>. Use host{' '}
                  <code className="host-editor__inline-code">%</code> for any client (narrow in production).
                </p>
                <div className="pg-admin-panel__stack-form">
                  <div className="pg-admin-panel__row">
                    <input
                      className="database-connections-panel__input"
                      placeholder="user_name"
                      value={newUserName}
                      onChange={(e) => setNewUserName(e.target.value)}
                      aria-label="New user name"
                    />
                    <input
                      className="database-connections-panel__input"
                      placeholder="Host (e.g. % or localhost)"
                      value={newUserHost}
                      onChange={(e) => setNewUserHost(e.target.value)}
                      aria-label="Host pattern"
                      title="MySQL account host"
                    />
                  </div>
                  <input
                    className="database-connections-panel__input"
                    type="password"
                    placeholder="Password"
                    value={newUserPassword}
                    onChange={(e) => setNewUserPassword(e.target.value)}
                    aria-label="New user password"
                  />
                  <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void createUser()}>
                    Create user
                  </button>
                </div>
              </div>

              <div className="pg-admin-panel__card">
                <h3 className="pg-admin-panel__card-title">Grant database access</h3>
                <p className="pg-admin-panel__lead">
                  Runs <code className="host-editor__inline-code">GRANT ALL PRIVILEGES ON db.*</code> so the account can use that schema (similar in spirit to PostgreSQL CONNECT + working inside the DB). Fine-tune privileges in MySQL separately if needed.
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
                    <span>Account</span>
                    <select
                      className="database-connections-panel__input"
                      value={grantAccount}
                      onChange={(e) => setGrantAccount(e.target.value)}
                      aria-label="Account for grant"
                    >
                      <option value="">Choose user@host…</option>
                      {users.map((r) => (
                        <option key={accountKey(r)} value={accountKey(r)}>
                          {r.user}@{r.host}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="pg-admin-panel__grant-action">
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={busy}
                      onClick={() => void grantDatabaseAccess()}
                    >
                      Grant ALL on database
                    </button>
                  </div>
                </div>
              </div>

              <div className="pg-admin-panel__card">
                <h3 className="pg-admin-panel__card-title">Change password</h3>
                <p className="pg-admin-panel__lead">
                  Runs <code className="host-editor__inline-code">ALTER USER … IDENTIFIED BY …</code> for the selected account.
                </p>
                <div className="pg-admin-panel__grant-grid">
                  <label className="pg-admin-panel__grant-field">
                    <span>Account</span>
                    <select
                      className="database-connections-panel__input"
                      value={pwdAccount}
                      onChange={(e) => setPwdAccount(e.target.value)}
                      aria-label="Account to change password"
                    >
                      {users.map((r) => (
                        <option key={accountKey(r)} value={accountKey(r)}>
                          {r.user}@{r.host}
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

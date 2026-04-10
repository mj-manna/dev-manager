import { NavLink, Outlet, useLocation } from 'react-router-dom'

export function DatabaseServersIndex() {
  return (
    <section className="panel database-servers-hub">
      <div className="panel__head">
        <h2>Database servers</h2>
      </div>
      <p className="database-servers-hub__intro">
        Choose an engine to manage server-level tasks (catalogs, access). Saved connections and data browsing live under{' '}
        <NavLink to="/database" className="database-servers-hub__inline-link">
          Connections
        </NavLink>
        .
      </p>
      <ul className="database-servers-hub__grid" role="list">
        <li>
          <NavLink
            to="postgresql"
            className={({ isActive }) =>
              `database-servers-hub__card${isActive ? ' database-servers-hub__card--active' : ''}`
            }
          >
            <span className="database-servers-hub__card-kind database-servers-hub__card-kind--pg" aria-hidden />
            <span className="database-servers-hub__card-title">PostgreSQL</span>
            <span className="database-servers-hub__card-desc">
              Databases, roles, passwords, and CONNECT grants on a host you choose.
            </span>
          </NavLink>
        </li>
        <li>
          <NavLink
            to="mysql"
            className={({ isActive }) =>
              `database-servers-hub__card${isActive ? ' database-servers-hub__card--active' : ''}`
            }
          >
            <span className="database-servers-hub__card-kind database-servers-hub__card-kind--mysql" aria-hidden />
            <span className="database-servers-hub__card-title">MySQL</span>
            <span className="database-servers-hub__card-desc">
              Databases, accounts, passwords, and database-level grants on a host you choose.
            </span>
          </NavLink>
        </li>
      </ul>
    </section>
  )
}

export function DatabaseServersLayout() {
  const { pathname } = useLocation()
  const atHub = /\/database\/servers\/?$/.test(pathname)

  return (
    <div className="database-servers-layout">
      {!atHub ? (
        <nav className="database-servers-layout__nav" aria-label="Server section">
          <NavLink to="/database/servers" className="database-servers-layout__back">
            ← All database servers
          </NavLink>
        </nav>
      ) : null}
      <Outlet />
    </div>
  )
}

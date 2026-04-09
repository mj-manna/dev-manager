import { useEffect, useState } from 'react'
import { Link, matchPath, NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { HostEditor } from './components/HostEditor'
import { ApachePanel } from './components/ApachePanel'
import { NginxPanel } from './components/NginxPanel'
import { DatabaseConnectionsPanel } from './components/DatabaseConnectionsPanel'
import { RedisBrowserPage } from './components/RedisBrowserPage'
import { PostgresBrowserPage } from './components/PostgresBrowserPage'
import { PostgresLocalAdminPanel } from './components/PostgresLocalAdminPanel'
import { DeploymentsPanel } from './components/DeploymentsPanel'
import { SettingsPage } from './components/SettingsPage'
import { useTerminal } from './terminal/TerminalContext'
import './App.css'
import {
  applyThemePreference,
  getStoredThemePreference,
  setStoredThemePreference,
  type ThemePreference,
} from './theme/themePreference'

type NavItem = { id: string; label: string; icon: string }
type NavGroup = { label: string; items: readonly NavItem[] }

const navGroups: readonly NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
      { id: 'projects', label: 'Projects', icon: 'folder' },
      { id: 'deployments', label: 'Deployments', icon: 'rocket' },
    ],
  },
  {
    label: 'Environment',
    items: [{ id: 'environment-host', label: 'Host', icon: 'file-lines' }],
  },
  {
    label: 'Web Server',
    items: [
      { id: 'nginx', label: 'Nginx', icon: 'server' },
      { id: 'apache', label: 'Apache', icon: 'server' },
    ],
  },
  {
    label: 'Database',
    items: [
      { id: 'database', label: 'Connections', icon: 'database' },
      { id: 'database-config', label: 'PG server', icon: 'sliders' },
    ],
  },
  {
    label: 'Account',
    items: [
      { id: 'team', label: 'Team', icon: 'users' },
      { id: 'settings', label: 'Settings', icon: 'gear' },
    ],
  },
]

const pageMeta: Record<string, { title: string; sub: string }> = {
  dashboard: {
    title: 'Dashboard',
    sub: 'Overview of your environments and releases',
  },
  projects: { title: 'Projects', sub: 'Repositories and workspaces' },
  deployments: {
    title: 'Deployments',
    sub: 'Saved dev terminal groups — run pnpm dev per folder with optional PORT',
  },
  'environment-host': {
    title: 'Environment',
    sub: 'Local hosts file — edit and reload',
  },
  nginx: {
    title: 'Web Server',
    sub: 'Nginx — install, virtual hosts, test and restart',
  },
  apache: {
    title: 'Web Server',
    sub: 'Apache — install, vhosts, config test and restart',
  },
  database: {
    title: 'Database',
    sub: 'Redis, MySQL, and PostgreSQL connections',
  },
  'database-config': {
    title: 'PostgreSQL server',
    sub: 'Manage local databases, roles, CONNECT grants, and passwords',
  },
  team: { title: 'Team', sub: 'Members and access' },
  settings: { title: 'Settings', sub: 'Application preferences' },
}

const navItemPath: Record<string, string> = {
  dashboard: '/dashboard',
  projects: '/projects',
  deployments: '/deployments',
  'environment-host': '/environment-host',
  nginx: '/nginx',
  apache: '/apache',
  database: '/database',
  'database-config': '/database/postgresql-admin',
  team: '/team',
  settings: '/settings',
}

/** Connections: list + Redis/PG browsers — not PG server admin (separate nav item). */
function sidebarNavItemIsActive(itemId: string, pathname: string): boolean {
  const to = navItemPath[itemId] ?? '/dashboard'
  if (itemId === 'database') {
    if (pathname === '/database/postgresql-admin' || pathname.startsWith('/database/postgresql-admin/')) {
      return false
    }
    return matchPath({ path: '/database', end: false }, pathname) != null
  }
  if (itemId === 'database-config') {
    return matchPath({ path: '/database/postgresql-admin', end: true }, pathname) != null
  }
  return matchPath({ path: to, end: true }, pathname) != null
}

/** Avoid two `aria-current="page"` when Connections is visually active under a sub-route. */
function sidebarNavAriaCurrent(itemId: string, pathname: string, active: boolean): 'page' | undefined {
  if (!active) return undefined
  if (itemId === 'database') {
    const onListOnly = pathname === '/database' || pathname === '/database/'
    return onListOnly ? 'page' : undefined
  }
  return 'page'
}

function headerForPath(pathname: string): { title: string; sub: string } {
  if (pathname.startsWith('/database/redis/')) {
    return { title: 'Redis data', sub: 'Browse keys and values on this connection' }
  }
  if (pathname.startsWith('/database/postgresql/')) {
    return { title: 'PostgreSQL data', sub: 'Browse schemas, tables, and rows on this connection' }
  }
  if (pathname.startsWith('/database/postgresql-admin')) {
    return pageMeta['database-config']
  }
  const keyByPath: Record<string, keyof typeof pageMeta> = {
    '/dashboard': 'dashboard',
    '/projects': 'projects',
    '/deployments': 'deployments',
    '/environment-host': 'environment-host',
    '/nginx': 'nginx',
    '/apache': 'apache',
    '/database': 'database',
    '/database/postgresql-admin': 'database-config',
    '/team': 'team',
    '/settings': 'settings',
  }
  const k = keyByPath[pathname] ?? 'dashboard'
  return pageMeta[k] ?? pageMeta.dashboard
}

const stats = [
  { label: 'Active projects', value: '12', change: '+2', trend: 'up' as const },
  { label: 'Deployments (7d)', value: '48', change: '+12%', trend: 'up' as const },
  { label: 'Open issues', value: '7', change: '-3', trend: 'up' as const },
  { label: 'Avg. build time', value: '2m 14s', change: '-8%', trend: 'up' as const },
]

const projects = [
  { name: 'api-gateway', env: 'production', status: 'healthy', lastDeploy: '12 min ago' },
  { name: 'web-app', env: 'staging', status: 'building', lastDeploy: 'In progress' },
  { name: 'worker-queue', env: 'production', status: 'healthy', lastDeploy: '3 hr ago' },
  { name: 'analytics', env: 'preview', status: 'failed', lastDeploy: '1 day ago' },
  { name: 'docs-site', env: 'production', status: 'healthy', lastDeploy: '2 days ago' },
]

function NavIcon({ name }: { name: string }) {
  const common = { width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  switch (name) {
    case 'grid':
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      )
    case 'folder':
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
        </svg>
      )
    case 'rocket':
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden>
          <path d="M4.5 16.5c-1-1-1.5-4.5 0-7.5C7 5 12 4 12 4s5 1 7.5 5c1.5 3 1 6.5 0 7.5" />
          <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
          <path d="M8 20l2.5-3M16 20l-2.5-3" />
        </svg>
      )
    case 'users':
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      )
    case 'gear':
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      )
    case 'file-lines':
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
        </svg>
      )
    case 'server':
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden>
          <rect x="2" y="3" width="20" height="6" rx="1" />
          <rect x="2" y="15" width="20" height="6" rx="1" />
          <circle cx="6" cy="6" r="1" fill="currentColor" stroke="none" />
          <circle cx="6" cy="18" r="1" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'database':
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden>
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5v7c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
          <path d="M3 12v7c0 1.66 4.03 3 9 3s9-1.34 9-3v-7" />
        </svg>
      )
    case 'sliders':
      return (
        <svg {...common} viewBox="0 0 24 24" aria-hidden>
          <line x1="4" y1="21" x2="4" y2="14" />
          <line x1="4" y1="10" x2="4" y2="3" />
          <line x1="12" y1="21" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12" y2="3" />
          <line x1="20" y1="21" x2="20" y2="16" />
          <line x1="20" y1="12" x2="20" y2="3" />
          <line x1="1" y1="14" x2="7" y2="14" />
          <line x1="9" y1="8" x2="15" y2="8" />
          <line x1="17" y1="16" x2="23" y2="16" />
          <circle cx="4" cy="18" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="20" cy="6" r="2" />
        </svg>
      )
    default:
      return null
  }
}

function DashboardHome() {
  return (
    <>
      <section className="admin__stats" aria-label="Key metrics">
        {stats.map((s) => (
          <article key={s.label} className="stat-card">
            <div className="stat-card__label">{s.label}</div>
            <div className="stat-card__row">
              <span className="stat-card__value">{s.value}</span>
              <span className={`stat-card__change stat-card__change--${s.trend}`}>{s.change}</span>
            </div>
          </article>
        ))}
      </section>

      <section className="panel">
        <div className="panel__head">
          <h2>Recent projects</h2>
          <button type="button" className="btn btn--primary">
            New project
          </button>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Environment</th>
                <th scope="col">Status</th>
                <th scope="col">Last deploy</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.name}>
                  <td>
                    <span className="data-table__name">{p.name}</span>
                  </td>
                  <td>
                    <span className={`env-pill env-pill--${p.env}`}>{p.env}</span>
                  </td>
                  <td>
                    <span className={`status status--${p.status}`}>{p.status}</span>
                  </td>
                  <td className="data-table__muted">{p.lastDeploy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

function AdminLayout() {
  const { toggleTerminal } = useTerminal()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => getStoredThemePreference())
  const location = useLocation()
  const header = headerForPath(location.pathname)

  useEffect(() => {
    applyThemePreference(themePreference)
  }, [themePreference])

  useEffect(() => {
    if (themePreference !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => applyThemePreference('system')
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [themePreference])

  const chooseTheme = (next: ThemePreference) => {
    setStoredThemePreference(next)
    setThemePreference(next)
  }

  return (
    <div className="admin">
      <aside
        id="admin-sidebar"
        className={`admin__sidebar ${sidebarOpen ? 'admin__sidebar--open' : ''}`}
        aria-label="Main navigation"
      >
        <div className="admin__brand">
          <NavLink to="/dashboard" className="admin__brand-link" onClick={() => setSidebarOpen(false)}>
            <span className="admin__logo" aria-hidden />
            <span className="admin__brand-text">Dev Manager</span>
          </NavLink>
        </div>
        <nav className="admin__nav" aria-label="Primary">
          {navGroups.map((group) => (
            <div key={group.label} className="admin__nav-group">
              <div className="admin__nav-group-label" role="presentation">
                {group.label}
              </div>
              <div className="admin__nav-group-items">
                {group.items.map((item) => {
                  const to = navItemPath[item.id] ?? '/dashboard'
                  const active = sidebarNavItemIsActive(item.id, location.pathname)
                  return (
                    <Link
                      key={item.id}
                      to={to}
                      className={`admin__nav-item${active ? ' admin__nav-item--active' : ''}`}
                      aria-current={sidebarNavAriaCurrent(item.id, location.pathname, active)}
                      onClick={() => setSidebarOpen(false)}
                    >
                      <span className="admin__nav-icon">
                        <NavIcon name={item.icon} />
                      </span>
                      {item.label}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="admin__sidebar-footer">
          <div className="admin__user-pill">
            <span className="admin__avatar" aria-hidden>AK</span>
            <div>
              <div className="admin__user-name">Alex Kim</div>
              <div className="admin__user-role">Admin</div>
            </div>
          </div>
        </div>
      </aside>

      {sidebarOpen && (
        <button type="button" className="admin__backdrop" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />
      )}

      <div className="admin__main">
        <header className="admin__header">
          <button
            type="button"
            className="admin__menu-btn"
            aria-expanded={sidebarOpen}
            aria-controls="admin-sidebar"
            onClick={() => setSidebarOpen((o) => !o)}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="admin__header-title">
            <h1>{header.title}</h1>
            <p className="admin__header-sub">{header.sub}</p>
          </div>
          <div className="admin__header-actions">
            <div className="admin__theme-toggle" role="radiogroup" aria-label="Color theme">
              <button
                type="button"
                role="radio"
                aria-checked={themePreference === 'system'}
                aria-label="Use system color theme"
                className={`admin__theme-option${themePreference === 'system' ? ' admin__theme-option--active' : ''}`}
                title="Match system"
                onClick={() => chooseTheme('system')}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <path d="M8 21h8M12 17v4" />
                </svg>
                <span className="admin__theme-option-label">System</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={themePreference === 'light'}
                aria-label="Use light theme"
                className={`admin__theme-option${themePreference === 'light' ? ' admin__theme-option--active' : ''}`}
                title="Light theme"
                onClick={() => chooseTheme('light')}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                </svg>
                <span className="admin__theme-option-label">Light</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={themePreference === 'dark'}
                aria-label="Use dark theme"
                className={`admin__theme-option${themePreference === 'dark' ? ' admin__theme-option--active' : ''}`}
                title="Dark theme"
                onClick={() => chooseTheme('dark')}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
                <span className="admin__theme-option-label">Dark</span>
              </button>
            </div>
            <label className="admin__search">
              <span className="visually-hidden">Search</span>
              <svg className="admin__search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input type="search" placeholder="Search projects…" />
            </label>
            <button
              type="button"
              className="admin__icon-btn admin__icon-btn--labeled"
              onClick={toggleTerminal}
              aria-label="Toggle terminal"
              title="Toggle in-app shell (run commands, sudo passwords)"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <rect x="3" y="4" width="18" height="14" rx="2" />
                <path d="M7 9h6M7 13h10" />
              </svg>
              <span className="admin__terminal-label">Terminal</span>
            </button>
            <button type="button" className="admin__icon-btn" aria-label="Notifications">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              <span className="admin__badge" aria-hidden />
            </button>
          </div>
        </header>

        <main className="admin__content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<AdminLayout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardHome />} />
        <Route path="projects" element={<DashboardHome />} />
        <Route path="deployments" element={<DeploymentsPanel />} />
        <Route path="environment-host" element={<HostEditor />} />
        <Route path="nginx" element={<NginxPanel />} />
        <Route path="apache" element={<ApachePanel />} />
        <Route path="database" element={<DatabaseConnectionsPanel />} />
        <Route path="database/postgresql-admin" element={<PostgresLocalAdminPanel />} />
        <Route path="database/redis/:connectionId" element={<RedisBrowserPage />} />
        <Route path="database/postgresql/:connectionId" element={<PostgresBrowserPage />} />
        <Route path="team" element={<DashboardHome />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  )
}

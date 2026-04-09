import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { STORAGE_CHANGED_EVENT } from '../appData/storageRegistry'
import { getConnectionById, loadConnections } from '../database/connectionsStorage'
import {
  defaultInstanceKey,
  loadOpenConnTabs,
  saveOpenConnTabs,
  type OpenConnTab,
} from '../database/openTabsStorage'
import { DatabaseConnectionsPanel } from './DatabaseConnectionsPanel'
import { PostgresBrowserPage } from './PostgresBrowserPage'
import { RedisBrowserPage } from './RedisBrowserPage'

const TAB_PARAM = 'tab'
const INST_PARAM = 'inst'

function tabHref(t: OpenConnTab): string {
  const q = new URLSearchParams()
  q.set(TAB_PARAM, t.id)
  q.set(INST_PARAM, t.inst)
  return `/database?${q.toString()}`
}

function parseTabFromSearch(search: string): string | null {
  const q = new URLSearchParams(search)
  const raw = q.get(TAB_PARAM)
  if (raw == null || raw === '') return null
  return raw
}

function hasInstInSearch(search: string): boolean {
  const v = new URLSearchParams(search).get(INST_PARAM)
  return v != null && v !== ''
}

function resolveRoute(search: string): { type: 'list' } | { type: 'conn'; tab: OpenConnTab } {
  const q = new URLSearchParams(search)
  const tabId = q.get(TAB_PARAM)
  if (!tabId) return { type: 'list' }
  const conn = getConnectionById(tabId)
  if (!conn || (conn.kind !== 'postgresql' && conn.kind !== 'redis')) {
    return { type: 'list' }
  }
  let inst = q.get(INST_PARAM)?.trim() ?? ''
  if (!inst) {
    inst = defaultInstanceKey(tabId)
  }
  return { type: 'conn', tab: { kind: conn.kind, id: tabId, inst } }
}

function tabKey(t: OpenConnTab): string {
  return `${t.kind}:${t.id}:${t.inst}`
}

export function DatabaseTabsLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const [connTabs, setConnTabs] = useState<OpenConnTab[]>(() => loadOpenConnTabs())

  const route = useMemo(() => resolveRoute(location.search), [location.search])
  const listActive = route.type === 'list'

  useEffect(() => {
    saveOpenConnTabs(connTabs)
  }, [connTabs])

  useEffect(() => {
    const tabId = parseTabFromSearch(location.search)
    if (!tabId || !getConnectionById(tabId)) return
    if (hasInstInSearch(location.search)) return
    const q = new URLSearchParams(location.search)
    q.set(INST_PARAM, defaultInstanceKey(tabId))
    navigate({ pathname: location.pathname, search: q.toString() }, { replace: true })
  }, [location.pathname, location.search, navigate])

  useEffect(() => {
    if (route.type === 'conn') {
      setConnTabs((prev) => {
        const { tab } = route
        if (prev.some((t) => t.id === tab.id && t.inst === tab.inst && t.kind === tab.kind)) return prev
        return [...prev, tab]
      })
    }
  }, [route])

  useEffect(() => {
    const prune = () => {
      const ids = new Set(loadConnections().map((c) => c.id))
      setConnTabs((prev) => prev.filter((t) => ids.has(t.id)))
    }
    window.addEventListener(STORAGE_CHANGED_EVENT, prune)
    return () => window.removeEventListener(STORAGE_CHANGED_EVENT, prune)
  }, [])

  useEffect(() => {
    const id = parseTabFromSearch(location.search)
    if (id == null) return
    if (!getConnectionById(id)) {
      navigate('/database', { replace: true })
    }
  }, [location.search, navigate])

  const closeTab = useCallback(
    (tab: OpenConnTab, e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const idx = connTabs.findIndex((t) => t.id === tab.id && t.inst === tab.inst && t.kind === tab.kind)
      if (idx < 0) return
      const next = connTabs.filter((_, i) => i !== idx)
      const isActive =
        route.type === 'conn' &&
        route.tab.id === tab.id &&
        route.tab.inst === tab.inst &&
        route.tab.kind === tab.kind
      setConnTabs(next)
      if (isActive) {
        if (next.length === 0) navigate('/database')
        else navigate(tabHref(next[Math.min(idx, next.length - 1)]!))
      }
    },
    [navigate, route, connTabs],
  )

  return (
    <div className="database-workspace">
      <div className="database-tabs-bar" role="region" aria-label="Database workspace tabs">
        <div className="database-tabs-scroll" role="tablist" aria-orientation="horizontal">
          <button
            type="button"
            role="tab"
            aria-selected={listActive}
            className={`database-tab database-tab--list${listActive ? ' database-tab--active' : ''}`}
            onClick={() => navigate('/database')}
          >
            <svg
              className="database-tab__icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              <path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" />
            </svg>
            <span className="database-tab__label">Connections</span>
          </button>
          {connTabs.map((t) => {
            const conn = getConnectionById(t.id)
            const baseLabel = conn?.name ?? 'Connection'
            const sameConn = connTabs.filter((x) => x.id === t.id)
            const instRank = sameConn.findIndex((x) => x.inst === t.inst)
            const label =
              sameConn.length > 1 && instRank >= 0 ? `${baseLabel} (${instRank + 1})` : baseLabel
            const active =
              route.type === 'conn' &&
              route.tab.id === t.id &&
              route.tab.inst === t.inst &&
              route.tab.kind === t.kind
            return (
              <div
                key={tabKey(t)}
                className={`database-tab-cluster database-tab-cluster--${t.kind}${active ? ' database-tab-cluster--active' : ''}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={`${label} (${t.kind === 'postgresql' ? 'PostgreSQL' : 'Redis'})`}
                  className="database-tab database-tab--conn"
                  onClick={() => navigate(tabHref(t))}
                >
                  <span className="database-tab__kind" aria-hidden />
                  <span className="database-tab__label">{label}</span>
                </button>
                <button
                  type="button"
                  className="database-tab__close"
                  aria-label={`Close ${label}`}
                  title="Close tab"
                  onClick={(e) => closeTab(t, e)}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden
                  >
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )
          })}
        </div>
      </div>
      <div className="database-workspace__body">
        {route.type === 'list' ? (
          <DatabaseConnectionsPanel />
        ) : route.tab.kind === 'postgresql' ? (
          <PostgresBrowserPage key={route.tab.inst} connectionId={route.tab.id} />
        ) : (
          <RedisBrowserPage key={route.tab.inst} connectionId={route.tab.id} />
        )}
      </div>
    </div>
  )
}

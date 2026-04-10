import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildExportBundle,
  clearAllManagedStorage,
  parseImportBundle,
  applyImportBundle,
  notifyAppStorageChanged,
  MANAGED_LOCAL_STORAGE,
  DB_CONNECTIONS_BUNDLE_KEY,
} from '../appData/storageRegistry'
import { APP_DB_VERSION } from '../appData/appIndexedDb'
import { collectDeploymentSlotsForAutostart } from '../deployments/autostartSnapshot'
import { memoryCacheInvalidate, memoryCacheStats } from '../lib/memoryCache'
import {
  applyThemePreference,
  getStoredThemePreference,
  setStoredThemePreference,
  type ThemePreference,
} from '../theme/themePreference'
import {
  applyUiPreferences,
  getConfirmDangerActions,
  getSidebarCompactLabels,
  getTerminalFontScale,
  getUiDensity,
  getUiMotionPreference,
  setConfirmDangerActions,
  setSidebarCompactLabels,
  setTerminalFontScale,
  setUiDensity,
  setUiMotionPreference,
  type UiDensity,
  type UiMotionPreference,
} from '../theme/uiPreferences'
import { createEmptyGroup } from '../deployments/terminalGroupsStorage'
import { useWorkspace } from '../workspace/WorkspaceContext'
import { deleteWorkspaceCascade } from '../workspace/workspaceDeleteCascade'
import { ConfirmDangerModal } from './ConfirmDangerModal'

type LinuxAutostartGet =
  | { supported: false; platform: string; configured?: boolean }
  | {
      supported: true
      platform: string
      configured: boolean
      matchesCurrentProject?: boolean
      desktopFilePath?: string
      snapshotFilePath?: string
      launchScriptPath?: string
      projectRoot?: string
      configuredProjectRoot?: string | null
      detectedDevCommand?: string
      savedRunCommand?: string | null
      devCommand?: string
      appOrigin?: string
      snapshot?: { openBrowser?: boolean; deploymentSlots?: unknown[] } | null
    }
  | { error: true }

type SettingsSectionId =
  | 'appearance'
  | 'workspace'
  | 'data'
  | 'performance'
  | 'system'
  | 'advanced'
  | 'danger'

const SECTIONS: { id: SettingsSectionId; label: string; hint?: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'workspace', label: 'Workspaces' },
  { id: 'data', label: 'Data & backup' },
  { id: 'performance', label: 'Performance' },
  { id: 'system', label: 'System' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'danger', label: 'Danger zone', hint: 'Irreversible' },
]

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function SettingsPage() {
  const fileRef = useRef<HTMLInputElement>(null)
  const { groups, setGroups, setActiveGroupId, effectiveGroupId, activeGroup } = useWorkspace()

  const [section, setSection] = useState<SettingsSectionId>('appearance')
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge')
  const [banner, setBanner] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [cacheStats, setCacheStats] = useState(() => memoryCacheStats())

  const [clearDataOpen, setClearDataOpen] = useState(false)
  const [clearCacheOpen, setClearCacheOpen] = useState(false)
  const [deleteWorkspaceId, setDeleteWorkspaceId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const [themePreference, setThemePreference] = useState<ThemePreference>(() => getStoredThemePreference())
  const [density, setDensity] = useState<UiDensity>(() => getUiDensity())
  const [motion, setMotion] = useState<UiMotionPreference>(() => getUiMotionPreference())
  const [terminalScale, setTerminalScaleState] = useState(() => getTerminalFontScale())
  const [sidebarLabels, setSidebarLabels] = useState(() => getSidebarCompactLabels())
  const [confirmDanger, setConfirmDanger] = useState(() => getConfirmDangerActions())

  const [linuxAuto, setLinuxAuto] = useState<LinuxAutostartGet | null>(null)
  const [linuxAutoLoading, setLinuxAutoLoading] = useState(true)
  const [linuxAutostartEnabled, setLinuxAutostartEnabled] = useState(false)
  const [linuxOpenBrowser, setLinuxOpenBrowser] = useState(false)
  const [linuxAutostartBusy, setLinuxAutostartBusy] = useState(false)
  const [linuxRunCommand, setLinuxRunCommand] = useState('')

  const refreshCacheStats = useCallback(() => setCacheStats(memoryCacheStats()), [])

  useEffect(() => {
    applyThemePreference(themePreference)
  }, [themePreference])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await fetch('/api/linux-autostart')
        const data = (await res.json()) as LinuxAutostartGet
        if (!alive) return
        setLinuxAuto(data)
        if ('supported' in data && data.supported && 'configured' in data) {
          setLinuxAutostartEnabled(data.configured)
          const ob = data.snapshot && typeof data.snapshot === 'object' ? data.snapshot.openBrowser : false
          setLinuxOpenBrowser(!!ob)
        }
      } catch {
        if (alive) setLinuxAuto({ error: true })
      } finally {
        if (alive) setLinuxAutoLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!linuxAuto || !('supported' in linuxAuto) || !linuxAuto.supported) return
    const detected = linuxAuto.detectedDevCommand ?? linuxAuto.devCommand ?? 'pnpm dev'
    const saved = linuxAuto.savedRunCommand
    setLinuxRunCommand(saved != null && saved !== '' ? saved : detected)
  }, [linuxAuto])

  const persistLinuxAutostart = useCallback(
    async (enabled: boolean, openBrowserOverride?: boolean) => {
      const openBrowser = openBrowserOverride ?? linuxOpenBrowser
      const wasEnabled = linuxAutostartEnabled
      const trimmedCmd = linuxRunCommand.trim()
      setLinuxAutostartBusy(true)
      try {
        const res = await fetch('/api/linux-autostart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled,
            openBrowser: enabled && openBrowser,
            runCommand: trimmedCmd === '' ? undefined : trimmedCmd,
            snapshot: { deploymentSlots: collectDeploymentSlotsForAutostart() },
          }),
        })
        const data = (await res.json()) as { ok?: boolean; error?: string }
        if (!res.ok) {
          throw new Error(typeof data.error === 'string' ? data.error : 'Autostart request failed.')
        }
        setLinuxAutostartEnabled(enabled)
        if (!enabled) setLinuxOpenBrowser(false)
        const refresh = await fetch('/api/linux-autostart')
        setLinuxAuto((await refresh.json()) as LinuxAutostartGet)
        setBanner({
          type: 'ok',
          text: enabled
            ? wasEnabled
              ? 'Autostart launch script and snapshot updated with your run command.'
              : 'Linux autostart is configured. The dev server will start on next login (log out/in or reboot to test).'
            : 'Linux autostart entry removed from ~/.config/autostart.',
        })
      } catch (e) {
        setBanner({
          type: 'err',
          text: e instanceof Error ? e.message : 'Could not update Linux autostart.',
        })
      } finally {
        setLinuxAutostartBusy(false)
      }
    },
    [linuxOpenBrowser, linuxRunCommand, linuxAutostartEnabled],
  )

  const exportData = useCallback(async () => {
    try {
      const bundle = await buildExportBundle()
      const stamp = new Date().toISOString().slice(0, 10)
      downloadJson(`dev-manager-export-${stamp}.json`, bundle)
      setBanner({
        type: 'ok',
        text: 'Export downloaded. Keep this file private — it may include DB passwords.',
      })
    } catch (e) {
      setBanner({
        type: 'err',
        text: e instanceof Error ? e.message : 'Export failed.',
      })
    }
  }, [])

  const onPickImportFile = useCallback(() => fileRef.current?.click(), [])

  const onImportFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const text = typeof reader.result === 'string' ? reader.result : ''
        const parsed = parseImportBundle(text)
        if ('error' in parsed) {
          setBanner({ type: 'err', text: parsed.error })
          return
        }
        void (async () => {
          try {
            await applyImportBundle(parsed, importMode)
            applyThemePreference(getStoredThemePreference() as ThemePreference)
            applyUiPreferences()
            notifyAppStorageChanged()
            setThemePreference(getStoredThemePreference())
            setDensity(getUiDensity())
            setMotion(getUiMotionPreference())
            setTerminalScaleState(getTerminalFontScale())
            setSidebarLabels(getSidebarCompactLabels())
            setConfirmDanger(getConfirmDangerActions())
            setBanner({
              type: 'ok',
              text:
                importMode === 'replace'
                  ? 'Import applied (replace). Saved data was overwritten where the file had keys.'
                  : 'Import applied (merge). Existing keys were updated from the file.',
            })
          } catch (err) {
            setBanner({
              type: 'err',
              text: err instanceof Error ? err.message : 'Import failed.',
            })
          }
        })()
      }
      reader.readAsText(file)
    },
    [importMode],
  )

  const runClearAllData = useCallback(async () => {
    try {
      await clearAllManagedStorage()
      applyThemePreference(getStoredThemePreference() as ThemePreference)
      applyUiPreferences()
      notifyAppStorageChanged()
      setClearDataOpen(false)
      setBanner({
        type: 'ok',
        text: 'All Dev Manager saved data in this browser was removed. Theme may fall back to system.',
      })
    } catch (e) {
      setBanner({
        type: 'err',
        text: e instanceof Error ? e.message : 'Could not clear all storage.',
      })
    }
  }, [])

  const confirmClearAllData = useCallback(() => {
    void runClearAllData()
  }, [runClearAllData])

  const requestClearAllData = useCallback(() => {
    if (!getConfirmDangerActions()) void runClearAllData()
    else setClearDataOpen(true)
  }, [runClearAllData])

  const confirmClearMemoryCache = useCallback(() => {
    memoryCacheInvalidate()
    refreshCacheStats()
    setClearCacheOpen(false)
    setBanner({ type: 'ok', text: 'In-memory panel cache cleared.' })
  }, [refreshCacheStats])

  const requestClearMemoryCache = useCallback(() => {
    if (!getConfirmDangerActions()) {
      memoryCacheInvalidate()
      refreshCacheStats()
      setBanner({ type: 'ok', text: 'In-memory panel cache cleared.' })
    } else setClearCacheOpen(true)
  }, [refreshCacheStats])

  const managedList = useMemo(
    () =>
      MANAGED_LOCAL_STORAGE.filter((e) => e.key !== 'dev-manager-terminal-groups-v1').map((e) => (
        <li key={e.key}>
          <code className="host-editor__inline-code">{e.key}</code> — {e.label}
        </li>
      )),
    [],
  )

  const autostartSlotsPreview = collectDeploymentSlotsForAutostart()

  const pendingDelete = useMemo(
    () => (deleteWorkspaceId ? groups.find((g) => g.id === deleteWorkspaceId) : undefined),
    [deleteWorkspaceId, groups],
  )

  const addWorkspace = useCallback(() => {
    const g = createEmptyGroup(`Workspace ${groups.length + 1}`)
    setGroups((gs) => [...gs, g])
    setActiveGroupId(g.id)
    setBanner({ type: 'ok', text: 'Workspace created. Open Projects to add dev projects.' })
  }, [groups.length, setGroups, setActiveGroupId])

  const saveWorkspaceRename = useCallback(() => {
    if (!editingId) return
    const name = editingName.trim()
    if (!name) {
      setEditingId(null)
      return
    }
    setGroups((gs) => gs.map((g) => (g.id === editingId ? { ...g, name } : g)))
    setEditingId(null)
    setEditingName('')
  }, [editingId, editingName, setGroups])

  const requestDeleteWorkspace = useCallback(
    (id: string) => {
      if (!getConfirmDangerActions()) {
        deleteWorkspaceCascade({ workspaceId: id, groups, setGroups })
        setBanner({
          type: 'ok',
          text: 'Workspace removed. Linked database connections and deployment restore state for its projects were cleared.',
        })
        return
      }
      setDeleteWorkspaceId(id)
    },
    [groups, setGroups],
  )

  const confirmDeleteWorkspace = useCallback(() => {
    if (!deleteWorkspaceId) return
    deleteWorkspaceCascade({ workspaceId: deleteWorkspaceId, groups, setGroups })
    setDeleteWorkspaceId(null)
    setBanner({
      type: 'ok',
      text: 'Workspace removed. Linked database connections and deployment restore state for its projects were cleared.',
    })
  }, [deleteWorkspaceId, groups, setGroups])

  const chooseTheme = (next: ThemePreference) => {
    setStoredThemePreference(next)
    setThemePreference(next)
  }

  return (
    <>
      <section className="panel settings-page settings-page--layout">
        <div className="panel__head settings-page__head">
          <div>
            <h2>Settings</h2>
            <p className="settings-page__lede">
              Appearance, workspaces, backups, and advanced options — organized in sections.
            </p>
          </div>
        </div>

        {banner ? (
          <div className={`settings-page__toast host-editor__banner host-editor__banner--${banner.type}`}>
            {banner.text}
          </div>
        ) : null}

        <div className="settings-layout">
          <nav className="settings-layout__nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`settings-layout__nav-item${section === s.id ? ' settings-layout__nav-item--active' : ''}${s.id === 'danger' ? ' settings-layout__nav-item--danger' : ''}`}
                onClick={() => setSection(s.id)}
              >
                <span className="settings-layout__nav-label">{s.label}</span>
                {s.hint ? <span className="settings-layout__nav-hint">{s.hint}</span> : null}
              </button>
            ))}
          </nav>

          <div className="settings-layout__panels">
            {section === 'appearance' ? (
              <div className="settings-layout__panel">
                <p className="settings-page__kicker">Theme &amp; motion</p>
                <div className="settings-page__card">
                  <div className="settings-page__card-head">
                    <h3 id="settings-appearance-theme">Color theme</h3>
                    <p className="settings-page__card-desc">Matches the header toggle; stored in this browser.</p>
                  </div>
                  <div className="settings-page__card-body">
                    <div className="settings-page__theme-inline" role="radiogroup" aria-label="Color theme">
                      {(
                        [
                          { id: 'system' as const, label: 'System' },
                          { id: 'light' as const, label: 'Light' },
                          { id: 'dark' as const, label: 'Dark' },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          role="radio"
                          aria-checked={themePreference === opt.id}
                          className={`settings-page__theme-chip${themePreference === opt.id ? ' settings-page__theme-chip--active' : ''}`}
                          onClick={() => chooseTheme(opt.id)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="settings-page__card">
                  <div className="settings-page__card-head">
                    <h3>Interface density</h3>
                    <p className="settings-page__card-desc">Tighter spacing and slightly smaller type in compact mode.</p>
                  </div>
                  <div className="settings-page__card-body">
                    <div className="settings-page__segmented" role="group" aria-label="Density">
                      <button
                        type="button"
                        className={`settings-page__segment${density === 'comfortable' ? ' settings-page__segment--active' : ''}`}
                        onClick={() => {
                          setUiDensity('comfortable')
                          setDensity('comfortable')
                        }}
                      >
                        Comfortable
                      </button>
                      <button
                        type="button"
                        className={`settings-page__segment${density === 'compact' ? ' settings-page__segment--active' : ''}`}
                        onClick={() => {
                          setUiDensity('compact')
                          setDensity('compact')
                        }}
                      >
                        Compact
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settings-page__card">
                  <div className="settings-page__card-head">
                    <h3>Motion</h3>
                    <p className="settings-page__card-desc">Reduce transitions and animations for a calmer UI.</p>
                  </div>
                  <div className="settings-page__card-body">
                    <label className="settings-page__toggle-row">
                      <span className="settings-page__toggle-text">
                        <span className="settings-page__toggle-title">Reduce UI motion</span>
                        <span className="settings-page__toggle-sub">Overrides most animated transitions</span>
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        aria-checked={motion === 'reduce'}
                        checked={motion === 'reduce'}
                        onChange={(e) => {
                          const next: UiMotionPreference = e.target.checked ? 'reduce' : 'system'
                          setUiMotionPreference(next)
                          setMotion(next)
                        }}
                      />
                    </label>
                  </div>
                </div>

                <div className="settings-page__card">
                  <div className="settings-page__card-head">
                    <h3>Integrated terminal</h3>
                    <p className="settings-page__card-desc">Font size scale for the bottom drawer (0.8×–1.35×).</p>
                  </div>
                  <div className="settings-page__card-body">
                    <div className="settings-page__slider-row">
                      <input
                        type="range"
                        min={0.8}
                        max={1.35}
                        step={0.05}
                        value={terminalScale}
                        aria-valuetext={`${Math.round(terminalScale * 100)}%`}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value)
                          setTerminalFontScale(v)
                          setTerminalScaleState(getTerminalFontScale())
                        }}
                      />
                      <span className="settings-page__slider-value">{Math.round(terminalScale * 100)}%</span>
                    </div>
                  </div>
                </div>

                <div className="settings-page__card">
                  <div className="settings-page__card-head">
                    <h3>Sidebar</h3>
                    <p className="settings-page__card-desc">When the sidebar is collapsed, keep text labels visible.</p>
                  </div>
                  <div className="settings-page__card-body">
                    <label className="settings-page__toggle-row">
                      <span className="settings-page__toggle-text">
                        <span className="settings-page__toggle-title">Show labels when collapsed</span>
                        <span className="settings-page__toggle-sub">Wider rail; easier scanning</span>
                      </span>
                      <input
                        type="checkbox"
                        checked={sidebarLabels}
                        onChange={(e) => {
                          setSidebarCompactLabels(e.target.checked)
                          setSidebarLabels(getSidebarCompactLabels())
                        }}
                      />
                    </label>
                  </div>
                </div>
              </div>
            ) : null}

            {section === 'workspace' ? (
              <div className="settings-layout__panel">
                <p className="settings-page__kicker">Workspaces</p>
                <div className="settings-page__card">
                  <div className="settings-page__card-head settings-page__card-head--row">
                    <div>
                      <h3 id="settings-workspaces-heading">Manage workspaces</h3>
                      <p className="settings-page__card-desc">
                        Each workspace holds deployment projects. Deleting a workspace removes{' '}
                        <strong>all</strong> database connections tagged to it and clears saved “running” deployment
                        restore ids for its projects. Open terminals for those projects close automatically.
                      </p>
                    </div>
                    <button type="button" className="btn btn--primary" onClick={addWorkspace}>
                      Add workspace
                    </button>
                  </div>
                  <div className="settings-page__card-body settings-page__card-body--flush">
                    <ul className="settings-workspace-list" aria-labelledby="settings-workspaces-heading">
                      {groups.map((g) => {
                        const isActive = g.id === effectiveGroupId
                        const isEditing = editingId === g.id
                        return (
                          <li key={g.id} className="settings-workspace-list__row">
                            <div className="settings-workspace-list__main">
                              {isEditing ? (
                                <input
                                  type="text"
                                  className="settings-page__input settings-workspace-list__input"
                                  value={editingName}
                                  autoFocus
                                  aria-label="Workspace name"
                                  onChange={(e) => setEditingName(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') saveWorkspaceRename()
                                    if (e.key === 'Escape') {
                                      setEditingId(null)
                                      setEditingName('')
                                    }
                                  }}
                                />
                              ) : (
                                <>
                                  <span className="settings-workspace-list__name">{g.name}</span>
                                  {isActive ? (
                                    <span className="settings-workspace-list__badge">Active</span>
                                  ) : null}
                                  <span className="settings-workspace-list__meta">
                                    {g.slots.length} project{g.slots.length === 1 ? '' : 's'}
                                  </span>
                                </>
                              )}
                            </div>
                            <div className="settings-workspace-list__actions">
                              {isEditing ? (
                                <>
                                  <button type="button" className="btn btn--secondary" onClick={saveWorkspaceRename}>
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--ghost"
                                    onClick={() => {
                                      setEditingId(null)
                                      setEditingName('')
                                    }}
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="btn btn--ghost"
                                    onClick={() => {
                                      setEditingId(g.id)
                                      setEditingName(g.name)
                                    }}
                                  >
                                    Rename
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--ghost"
                                    onClick={() => setActiveGroupId(g.id)}
                                    disabled={isActive}
                                  >
                                    Make active
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--danger"
                                    onClick={() => requestDeleteWorkspace(g.id)}
                                  >
                                    Delete
                                  </button>
                                </>
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                    <p className="settings-page__muted settings-page__muted--tight settings-workspace-list__foot">
                      Active workspace is also available in the sidebar. Current:{' '}
                      <strong>{activeGroup?.name ?? '—'}</strong>.
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            {section === 'data' ? (
              <div className="settings-layout__panel">
                <p className="settings-page__kicker">Backup &amp; migration</p>
                <div className="settings-page__card">
                  <div className="settings-page__card-head">
                    <h3 id="settings-data-heading">Export &amp; import</h3>
                    <p className="settings-page__card-desc">
                      Deployments, DB connections (IndexedDB, included in export as{' '}
                      <code className="host-editor__inline-code">{DB_CONNECTIONS_BUNDLE_KEY}</code>), theme, and UI
                      preferences. <strong>Not</strong> running terminals.
                    </p>
                  </div>
                  <div className="settings-page__card-body">
                    <div className="settings-page__actions">
                      <button type="button" className="btn btn--primary" onClick={() => void exportData()}>
                        Export all data…
                      </button>
                      <input
                        ref={fileRef}
                        type="file"
                        accept="application/json,.json"
                        className="visually-hidden"
                        aria-hidden
                        onChange={onImportFile}
                      />
                      <button type="button" className="btn btn--secondary" onClick={onPickImportFile}>
                        Import from file…
                      </button>
                    </div>
                    <fieldset className="settings-page__fieldset">
                      <legend className="settings-page__legend">When importing</legend>
                      <label className="settings-page__radio">
                        <input
                          type="radio"
                          name="import-mode"
                          checked={importMode === 'merge'}
                          onChange={() => setImportMode('merge')}
                        />
                        Merge — only keys present in the file are written; other saved keys stay
                      </label>
                      <label className="settings-page__radio">
                        <input
                          type="radio"
                          name="import-mode"
                          checked={importMode === 'replace'}
                          onChange={() => setImportMode('replace')}
                        />
                        Replace — clear all listed app keys first, then apply the file
                      </label>
                    </fieldset>
                    <details className="settings-page__details">
                      <summary className="settings-page__details-summary">Storage keys in export</summary>
                      <ul className="settings-page__key-list">{managedList}</ul>
                    </details>
                  </div>
                </div>
              </div>
            ) : null}

            {section === 'performance' ? (
              <div className="settings-layout__panel">
                <p className="settings-page__kicker">Performance</p>
                <div className="settings-page__card">
                  <div className="settings-page__card-head">
                    <h3 id="settings-cache-heading">Panel cache</h3>
                    <p className="settings-page__card-desc">
                      Short-lived in-memory cache (~12s TTL) cuts duplicate nginx/apache status requests during background
                      refresh. Clears on reload.
                    </p>
                  </div>
                  <div className="settings-page__card-body">
                    <div className="settings-page__metric">
                      <span className="settings-page__metric-value">{cacheStats.size}</span>
                      <span className="settings-page__metric-label">entries in memory</span>
                      {cacheStats.keys.length > 0 ? (
                        <span className="settings-page__metric-hint" title={cacheStats.keys.join(', ')}>
                          {cacheStats.keys.length} key{cacheStats.keys.length === 1 ? '' : 's'}
                        </span>
                      ) : null}
                    </div>
                    <div className="settings-page__actions">
                      <button type="button" className="btn btn--ghost" onClick={refreshCacheStats}>
                        Refresh stats
                      </button>
                      <button type="button" className="btn btn--danger" onClick={requestClearMemoryCache}>
                        Clear memory cache
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settings-page__card">
                  <div className="settings-page__card-head">
                    <h3>Confirmations</h3>
                    <p className="settings-page__card-desc">
                      Turn off to skip modals for erase data, cache clear, and workspace delete (risky on shared machines).
                    </p>
                  </div>
                  <div className="settings-page__card-body">
                    <label className="settings-page__toggle-row">
                      <span className="settings-page__toggle-text">
                        <span className="settings-page__toggle-title">Confirm destructive actions</span>
                        <span className="settings-page__toggle-sub">Recommended: keep enabled</span>
                      </span>
                      <input
                        type="checkbox"
                        checked={confirmDanger}
                        onChange={(e) => {
                          setConfirmDangerActions(e.target.checked)
                          setConfirmDanger(getConfirmDangerActions())
                        }}
                      />
                    </label>
                  </div>
                </div>
              </div>
            ) : null}

            {section === 'system' ? (
              <div className="settings-layout__panel">
                <p className="settings-page__kicker">System · Linux</p>
                <div className="settings-page__card settings-page__card--accent">
                  <div className="settings-page__card-head settings-page__card-head--row">
                    <div>
                      <h3 id="settings-linux-autostart-heading">Start on login</h3>
                      <p className="settings-page__card-desc">
                        XDG autostart for this repo&apos;s dev server and an optional browser open.
                      </p>
                    </div>
                    {linuxAuto && 'supported' in linuxAuto && linuxAuto.supported ? (
                      <span
                        className={`settings-page__pill${linuxAutostartEnabled ? ' settings-page__pill--on' : ' settings-page__pill--off'}`}
                        aria-live="polite"
                      >
                        {linuxAutostartEnabled ? 'Enabled' : 'Disabled'}
                      </span>
                    ) : null}
                  </div>
                  <div className="settings-page__card-body">
                    {linuxAutoLoading ? (
                      <p className="settings-page__muted settings-page__muted--tight">Loading autostart status…</p>
                    ) : linuxAuto && 'error' in linuxAuto && linuxAuto.error ? (
                      <p className="settings-page__muted settings-page__muted--tight">
                        Could not reach the autostart API. Run <code className="host-editor__inline-code">pnpm dev</code>{' '}
                        and open Settings again.
                      </p>
                    ) : linuxAuto && 'supported' in linuxAuto && !linuxAuto.supported ? (
                      <p className="settings-page__muted settings-page__muted--tight">
                        This system is <code className="host-editor__inline-code">{linuxAuto.platform}</code>. Autostart is
                        only set up when Dev Manager runs on Linux (writes{' '}
                        <code className="host-editor__inline-code">~/.config/autostart/</code>).
                      </p>
                    ) : linuxAuto && 'supported' in linuxAuto && linuxAuto.supported ? (
                      <>
                        <p className="settings-page__muted settings-page__muted--tight">
                          Writes <code className="host-editor__inline-code">dev-manager.desktop</code> and a launch script
                          that <code className="host-editor__inline-code">cd</code>s to the project and runs your command
                          after graphical login. Snapshot JSON stores deployment paths and the command you save.
                        </p>
                        <div className="settings-page__field">
                          <label className="settings-page__field-label" htmlFor="settings-linux-run-command">
                            Run command
                          </label>
                          <p id="settings-linux-run-command-desc" className="settings-page__field-hint">
                            Executed from the project directory. Detected default:{' '}
                            <code className="host-editor__inline-code">
                              {linuxAuto.detectedDevCommand ?? linuxAuto.devCommand ?? 'pnpm dev'}
                            </code>
                            . Clear the field and enable or apply to use that default.
                          </p>
                          <div className="settings-page__field-row">
                            <input
                              id="settings-linux-run-command"
                              type="text"
                              className="settings-page__input"
                              autoComplete="off"
                              spellCheck={false}
                              value={linuxRunCommand}
                              disabled={linuxAutostartBusy}
                              onChange={(e) => setLinuxRunCommand(e.target.value)}
                              placeholder={linuxAuto.detectedDevCommand ?? linuxAuto.devCommand ?? 'pnpm dev'}
                              aria-describedby="settings-linux-run-command-desc"
                            />
                            <button
                              type="button"
                              className="btn btn--ghost"
                              disabled={linuxAutostartBusy}
                              onClick={() =>
                                setLinuxRunCommand(linuxAuto.detectedDevCommand ?? linuxAuto.devCommand ?? 'pnpm dev')
                              }
                            >
                              Use detected
                            </button>
                          </div>
                          {linuxAutostartEnabled ? (
                            <div className="settings-page__field-actions">
                              <button
                                type="button"
                                className="btn btn--secondary"
                                disabled={linuxAutostartBusy}
                                onClick={() => void persistLinuxAutostart(true)}
                              >
                                Apply command to autostart
                              </button>
                            </div>
                          ) : null}
                        </div>
                        {linuxAuto.configured && linuxAuto.matchesCurrentProject === false ? (
                          <p className="settings-page__alert settings-page__alert--warn" role="status">
                            Autostart points at another directory. Toggle off or re-enable from this checkout to update.
                            {linuxAuto.configuredProjectRoot ? (
                              <>
                                {' '}
                                Registered:{' '}
                                <code className="host-editor__inline-code">{linuxAuto.configuredProjectRoot}</code>
                              </>
                            ) : null}
                          </p>
                        ) : null}
                        <dl className="settings-page__dl">
                          {linuxAuto.projectRoot ? (
                            <div className="settings-page__dl-row">
                              <dt>Project</dt>
                              <dd>
                                <code className="host-editor__inline-code">{linuxAuto.projectRoot}</code>
                              </dd>
                            </div>
                          ) : null}
                          {linuxAuto.appOrigin ? (
                            <div className="settings-page__dl-row">
                              <dt>App URL</dt>
                              <dd>
                                <code className="host-editor__inline-code">{linuxAuto.appOrigin}</code>
                              </dd>
                            </div>
                          ) : null}
                          <div className="settings-page__dl-row">
                            <dt>Saved command</dt>
                            <dd>
                              <code className="host-editor__inline-code">
                                {linuxRunCommand.trim() ||
                                  linuxAuto.detectedDevCommand ||
                                  linuxAuto.devCommand ||
                                  'pnpm dev'}
                              </code>
                            </dd>
                          </div>
                          <div className="settings-page__dl-row">
                            <dt>Deployments in snapshot</dt>
                            <dd>
                              <strong>{autostartSlotsPreview.length}</strong> path
                              {autostartSlotsPreview.length === 1 ? '' : 's'}
                            </dd>
                          </div>
                          {linuxAuto.snapshotFilePath ? (
                            <div className="settings-page__dl-row">
                              <dt>Snapshot file</dt>
                              <dd>
                                <code className="host-editor__inline-code">{linuxAuto.snapshotFilePath}</code>
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                        <div className="settings-page__options">
                          <label className="settings-page__option">
                            <input
                              type="checkbox"
                              checked={linuxAutostartEnabled}
                              disabled={linuxAutostartBusy}
                              onChange={(e) => void persistLinuxAutostart(e.target.checked)}
                            />
                            <span className="settings-page__option-text">
                              <span className="settings-page__option-title">Autostart dev server at login</span>
                              <span className="settings-page__option-sub">Register with the desktop session</span>
                            </span>
                          </label>
                          <label
                            className={`settings-page__option${!linuxAutostartEnabled ? ' settings-page__option--disabled' : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={linuxOpenBrowser}
                              disabled={linuxAutostartBusy || !linuxAutostartEnabled}
                              onChange={(e) => {
                                const v = e.target.checked
                                setLinuxOpenBrowser(v)
                                if (linuxAutostartEnabled) void persistLinuxAutostart(true, v)
                              }}
                            />
                            <span className="settings-page__option-text">
                              <span className="settings-page__option-title">Open app in browser</span>
                              <span className="settings-page__option-sub">
                                <code className="host-editor__inline-code">xdg-open</code> after ~8s
                              </span>
                            </span>
                          </label>
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            {section === 'advanced' ? (
              <div className="settings-layout__panel">
                <p className="settings-page__kicker">Storage architecture</p>
                <div className="settings-page__card">
                  <div className="settings-page__card-head">
                    <h3>IndexedDB</h3>
                    <p className="settings-page__card-desc">
                      Database connection profiles (including saved passwords) live in IndexedDB so they are not limited by{' '}
                      <code className="host-editor__inline-code">localStorage</code> quotas. The app database version is{' '}
                      bumped only when new object stores or indexes are added — upgrades are additive so existing rows are
                      kept unless you erase data.
                    </p>
                  </div>
                  <div className="settings-page__card-body">
                    <dl className="settings-page__dl">
                      <div className="settings-page__dl-row">
                        <dt>App DB version</dt>
                        <dd>
                          <code className="host-editor__inline-code">{APP_DB_VERSION}</code>
                        </dd>
                      </div>
                      <div className="settings-page__dl-row">
                        <dt>Connections store</dt>
                        <dd>
                          <code className="host-editor__inline-code">dbConnections</code> (key: connection id)
                        </dd>
                      </div>
                    </dl>
                    <p className="settings-page__muted settings-page__muted--tight">
                      Legacy exports still use the key <code className="host-editor__inline-code">{DB_CONNECTIONS_BUNDLE_KEY}</code>{' '}
                      inside the JSON file; import merges or replaces that data into IndexedDB.
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            {section === 'danger' ? (
              <div className="settings-layout__panel">
                <p className="settings-page__kicker">Danger zone</p>
                <div className="settings-page__card settings-page__card--danger">
                  <div className="settings-page__card-head">
                    <h3 id="settings-danger-heading">Reset browser data</h3>
                    <p className="settings-page__card-desc">
                      Removes every Dev Manager value from <code className="host-editor__inline-code">localStorage</code> and
                      clears the IndexedDB connections store for this origin. Cannot be undone.
                    </p>
                  </div>
                  <div className="settings-page__card-body settings-page__card-body--row">
                    <button type="button" className="btn btn--danger" onClick={requestClearAllData}>
                      Erase all saved app data…
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <ConfirmDangerModal
        open={clearDataOpen}
        title="Erase all saved data?"
        titleId="settings-clear-data-title"
        message={
          <>
            This removes deployments, database connections (IndexedDB), theme, UI preferences, and other stored data for
            Dev Manager in this browser only.
          </>
        }
        confirmLabel="Erase everything"
        onCancel={() => setClearDataOpen(false)}
        onConfirm={confirmClearAllData}
      />

      <ConfirmDangerModal
        open={clearCacheOpen}
        title="Clear memory cache?"
        titleId="settings-clear-cache-title"
        message="Panel status responses cached in memory will be dropped. The next background refresh will fetch fresh data."
        confirmLabel="Clear cache"
        onCancel={() => setClearCacheOpen(false)}
        onConfirm={confirmClearMemoryCache}
      />

      <ConfirmDangerModal
        open={deleteWorkspaceId !== null}
        title="Delete workspace?"
        titleId="settings-del-workspace-title"
        message={
          <>
            This removes <strong>{pendingDelete?.name.trim() || 'this workspace'}</strong> and{' '}
            <strong>all database connections</strong> scoped to it, clears saved running-deployment ids for its projects,
            and closes any open terminal tabs tied to those projects.
          </>
        }
        confirmLabel="Delete workspace"
        onCancel={() => setDeleteWorkspaceId(null)}
        onConfirm={confirmDeleteWorkspace}
      />
    </>
  )
}

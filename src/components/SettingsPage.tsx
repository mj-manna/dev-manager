import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildExportBundle,
  clearAllManagedLocalStorage,
  parseImportBundle,
  applyImportBundle,
  notifyAppStorageChanged,
  MANAGED_LOCAL_STORAGE,
} from '../appData/storageRegistry'
import { collectDeploymentSlotsForAutostart } from '../deployments/autostartSnapshot'
import { memoryCacheInvalidate, memoryCacheStats } from '../lib/memoryCache'
import {
  applyThemePreference,
  getStoredThemePreference,
  type ThemePreference,
} from '../theme/themePreference'
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
      /** Lockfile-based default */
      detectedDevCommand?: string
      /** From autostart snapshot when it matches this project */
      savedRunCommand?: string | null
      /** @deprecated alias of detectedDevCommand */
      devCommand?: string
      appOrigin?: string
      snapshot?: { openBrowser?: boolean; deploymentSlots?: unknown[] } | null
    }
  | { error: true }

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
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge')
  const [banner, setBanner] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [cacheStats, setCacheStats] = useState(() => memoryCacheStats())

  const [clearDataOpen, setClearDataOpen] = useState(false)
  const [clearCacheOpen, setClearCacheOpen] = useState(false)

  const [linuxAuto, setLinuxAuto] = useState<LinuxAutostartGet | null>(null)
  const [linuxAutoLoading, setLinuxAutoLoading] = useState(true)
  const [linuxAutostartEnabled, setLinuxAutostartEnabled] = useState(false)
  const [linuxOpenBrowser, setLinuxOpenBrowser] = useState(false)
  const [linuxAutostartBusy, setLinuxAutostartBusy] = useState(false)
  const [linuxRunCommand, setLinuxRunCommand] = useState('')

  const refreshCacheStats = useCallback(() => setCacheStats(memoryCacheStats()), [])

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
    const detected =
      linuxAuto.detectedDevCommand ?? linuxAuto.devCommand ?? 'pnpm dev'
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

  const exportData = useCallback(() => {
    const bundle = buildExportBundle()
    const stamp = new Date().toISOString().slice(0, 10)
    downloadJson(`dev-manager-export-${stamp}.json`, bundle)
    setBanner({ type: 'ok', text: 'Export downloaded. Keep this file private — it may include DB passwords.' })
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
        try {
          applyImportBundle(parsed, importMode)
          applyThemePreference(getStoredThemePreference() as ThemePreference)
          notifyAppStorageChanged()
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
      }
      reader.readAsText(file)
    },
    [importMode],
  )

  const confirmClearAllData = useCallback(() => {
    clearAllManagedLocalStorage()
    applyThemePreference(getStoredThemePreference() as ThemePreference)
    notifyAppStorageChanged()
    setClearDataOpen(false)
    setBanner({
      type: 'ok',
      text: 'All Dev Manager saved data in this browser was removed. Theme may fall back to system.',
    })
  }, [])

  const confirmClearMemoryCache = useCallback(() => {
    memoryCacheInvalidate()
    refreshCacheStats()
    setClearCacheOpen(false)
    setBanner({ type: 'ok', text: 'In-memory panel cache cleared.' })
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

  return (
    <>
      <section className="panel settings-page">
        <div className="panel__head settings-page__head">
          <div>
            <h2>Settings</h2>
            <p className="settings-page__lede">
              Preferences and local data for this Dev Manager install — grouped by task.
            </p>
          </div>
        </div>

        {banner ? (
          <div className={`settings-page__toast host-editor__banner host-editor__banner--${banner.type}`}>{banner.text}</div>
        ) : null}

        <div className="settings-page__grid" role="presentation">
          <div className="settings-page__group">
            <p className="settings-page__kicker">Backup &amp; migration</p>
            <div className="settings-page__card">
              <div className="settings-page__card-head">
                <h3 id="settings-data-heading">Export &amp; import</h3>
                <p className="settings-page__card-desc">
                  Deployments, DB connections (including saved passwords), theme, and PostgreSQL UI state.{' '}
                  <strong>Not</strong> running terminals.
                </p>
              </div>
              <div className="settings-page__card-body">
                <div className="settings-page__actions">
                  <button type="button" className="btn btn--primary" onClick={exportData}>
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
                    Replace — clear all listed app keys first, then apply the file (missing keys stay empty)
                  </label>
                </fieldset>
                <details className="settings-page__details">
                  <summary className="settings-page__details-summary">localStorage keys included</summary>
                  <ul className="settings-page__key-list">{managedList}</ul>
                </details>
              </div>
            </div>
          </div>

          <div className="settings-page__group">
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
                  <button type="button" className="btn btn--danger" onClick={() => setClearCacheOpen(true)}>
                    Clear memory cache
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="settings-page__group settings-page__group--wide">
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
                    Could not reach the autostart API. Run <code className="host-editor__inline-code">pnpm dev</code> and
                    open Settings again.
                  </p>
                ) : linuxAuto && 'supported' in linuxAuto && !linuxAuto.supported ? (
                  <p className="settings-page__muted settings-page__muted--tight">
                    This system is <code className="host-editor__inline-code">{linuxAuto.platform}</code>. Autostart is only
                    set up when Dev Manager runs on Linux (writes{' '}
                    <code className="host-editor__inline-code">~/.config/autostart/</code>).
                  </p>
                ) : linuxAuto && 'supported' in linuxAuto && linuxAuto.supported ? (
                  <>
                    <p className="settings-page__muted settings-page__muted--tight">
                      Writes <code className="host-editor__inline-code">dev-manager.desktop</code> and a launch script that{' '}
                      <code className="host-editor__inline-code">cd</code>s to the project and runs your command after
                      graphical login. Snapshot JSON stores deployment paths and the command you save.
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
                            setLinuxRunCommand(
                              linuxAuto.detectedDevCommand ?? linuxAuto.devCommand ?? 'pnpm dev',
                            )
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
                            Registered: <code className="host-editor__inline-code">{linuxAuto.configuredProjectRoot}</code>
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
                          <strong>{autostartSlotsPreview.length}</strong> path{autostartSlotsPreview.length === 1 ? '' : 's'}
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

          <div className="settings-page__group settings-page__group--wide settings-page__group--danger">
            <p className="settings-page__kicker">Danger zone</p>
            <div className="settings-page__card settings-page__card--danger">
              <div className="settings-page__card-head">
                <h3 id="settings-danger-heading">Reset browser data</h3>
                <p className="settings-page__card-desc">
                  Removes every Dev Manager value from <code className="host-editor__inline-code">localStorage</code> for
                  this site. Cannot be undone.
                </p>
              </div>
              <div className="settings-page__card-body settings-page__card-body--row">
                <button type="button" className="btn btn--danger" onClick={() => setClearDataOpen(true)}>
                  Erase all saved app data…
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <ConfirmDangerModal
        open={clearDataOpen}
        title="Erase all saved data?"
        titleId="settings-clear-data-title"
        message={
          <>
            This removes deployments, database connections, theme choice, and other preferences stored for Dev Manager in
            this browser only.
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
    </>
  )
}

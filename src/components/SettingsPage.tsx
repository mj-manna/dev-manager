import { useCallback, useMemo, useRef, useState } from 'react'
import {
  buildExportBundle,
  clearAllManagedLocalStorage,
  parseImportBundle,
  applyImportBundle,
  notifyAppStorageChanged,
  MANAGED_LOCAL_STORAGE,
} from '../appData/storageRegistry'
import { memoryCacheInvalidate, memoryCacheStats } from '../lib/memoryCache'
import {
  applyThemePreference,
  getStoredThemePreference,
  type ThemePreference,
} from '../theme/themePreference'
import { ConfirmDangerModal } from './ConfirmDangerModal'

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

  const refreshCacheStats = useCallback(() => setCacheStats(memoryCacheStats()), [])

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

  return (
    <>
      <section className="panel settings-page">
        <div className="panel__head">
          <div>
            <h2>Settings</h2>
            <p className="settings-page__lede">
              Back up or restore saved browser data, and manage the optional in-memory cache used for quieter API
              refreshes.
            </p>
          </div>
        </div>

        {banner ? (
          <div className={`host-editor__banner host-editor__banner--${banner.type}`}>{banner.text}</div>
        ) : null}

        <div className="settings-page__sections">
          <section className="settings-page__section" aria-labelledby="settings-data-heading">
            <h3 id="settings-data-heading">Data export &amp; import</h3>
            <p className="settings-page__muted">
              Includes deployments, DB connection list (including passwords stored locally), theme, and PostgreSQL UI
              preferences. Does <strong>not</strong> include running terminals.
            </p>
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
            <p className="settings-page__muted settings-page__small">
              Keys covered:{' '}
              <ul className="settings-page__key-list">{managedList}</ul>
            </p>
          </section>

          <section className="settings-page__section" aria-labelledby="settings-cache-heading">
            <h3 id="settings-cache-heading">Advanced cache</h3>
            <p className="settings-page__muted">
              Short-lived in-memory cache (default TTL ~12s) avoids redundant nginx/apache status requests during
              background refresh. It is not persisted and clears when you reload the app.
            </p>
            <p className="settings-page__cache-meta">
              Current entries: <strong>{cacheStats.size}</strong>
              {cacheStats.keys.length > 0 ? (
                <span className="settings-page__cache-keys" title={cacheStats.keys.join(', ')}>
                  {' '}
                  ({cacheStats.keys.length} key{cacheStats.keys.length === 1 ? '' : 's'})
                </span>
              ) : null}
            </p>
            <div className="settings-page__actions">
              <button type="button" className="btn btn--ghost" onClick={refreshCacheStats}>
                Refresh stats
              </button>
              <button type="button" className="btn btn--danger" onClick={() => setClearCacheOpen(true)}>
                Clear memory cache
              </button>
            </div>
          </section>

          <section className="settings-page__section settings-page__section--danger" aria-labelledby="settings-danger-heading">
            <h3 id="settings-danger-heading">Reset browser data</h3>
            <p className="settings-page__muted">
              Removes every Dev Manager value from <code className="host-editor__inline-code">localStorage</code> for this
              site. Cannot be undone.
            </p>
            <button type="button" className="btn btn--danger" onClick={() => setClearDataOpen(true)}>
              Erase all saved app data…
            </button>
          </section>
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

import { useCallback, useEffect, useState } from 'react'
import { useSudoElevation } from '../elevation/SudoElevationContext'

type HostsGetResponse = {
  path: string
  platform: string
  content: string
  writable: boolean
}

type HostsErrorBody = {
  error: string
  code?: string
  path?: string
  platform?: string
  hint?: string
}

const platformLabel = (p: string) => {
  if (p === 'win32') return 'Windows'
  if (p === 'darwin') return 'macOS'
  if (p === 'linux') return 'Linux'
  return p
}

export function HostEditor() {
  const { fetchJsonWithElevation } = useSudoElevation()
  const [content, setContent] = useState('')
  const [path, setPath] = useState('')
  const [platform, setPlatform] = useState('')
  const [writable, setWritable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [dirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setMessage(null)
    try {
      const res = await fetch('/api/hosts')
      const data = (await res.json()) as HostsGetResponse & HostsErrorBody
      if (!res.ok) {
        setMessage({
          type: 'err',
          text: data.error || `HTTP ${res.status}`,
        })
        setPath(data.path ?? '')
        setPlatform(data.platform ?? '')
        setContent('')
        return
      }
      setPath(data.path)
      setPlatform(data.platform)
      setContent(data.content)
      setWritable(data.writable)
      setDirty(false)
    } catch (e) {
      setMessage({
        type: 'err',
        text: e instanceof Error ? e.message : 'Could not reach /api/hosts (is the dev server running?)',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const { res, data } = await fetchJsonWithElevation('/api/hosts', 'PUT', { content })
      const typed = data as { ok?: boolean; error?: string; hint?: string }
      if (!res.ok) {
        const text = [typed.error || `HTTP ${res.status}`, typed.hint].filter(Boolean).join(' — ')
        setMessage({ type: 'err', text })
        return
      }
      setDirty(false)
      setMessage({ type: 'ok', text: 'Hosts file saved.' })
      void load()
    } catch (e) {
      setMessage({
        type: 'err',
        text: e instanceof Error ? e.message : 'Save failed',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="panel host-editor">
      <div className="panel__head">
        <div>
          <h2>Host Editor</h2>
          <p className="host-editor__sub">
            Local system hosts file
            {platform ? (
              <>
                {' '}
                · <span className="host-editor__mono">{platformLabel(platform)}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="host-editor__actions">
          <button type="button" className="btn btn--ghost" onClick={() => void load()} disabled={loading}>
            Reload
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void save()}
            disabled={loading || saving || !dirty}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {path ? (
        <div className="host-editor__path">
          <span className="host-editor__path-label">File</span>
          <code className="host-editor__path-value">{path}</code>
          {!writable ? (
            <span className="host-editor__badge host-editor__badge--warn" title="Save may require elevated permissions">
              Read-only
            </span>
          ) : (
            <span className="host-editor__badge host-editor__badge--ok">Writable</span>
          )}
        </div>
      ) : null}

      {message ? (
        <div
          className={`host-editor__banner host-editor__banner--${message.type}`}
          role="status"
        >
          {message.text}
        </div>
      ) : null}

      <div className="host-editor__textarea-wrap">
        {loading ? (
          <p className="host-editor__loading">Loading hosts file…</p>
        ) : (
          <textarea
            className="host-editor__textarea"
            spellCheck={false}
            value={content}
            onChange={(e) => {
              setContent(e.target.value)
              setDirty(true)
              setMessage(null)
            }}
            aria-label="Hosts file contents"
          />
        )}
      </div>

      <p className="host-editor__hint">
        Editing the wrong entries can break DNS resolution. Keep a backup. On Windows use Run as administrator;
        on macOS/Linux you may need <code className="host-editor__inline-code">sudo npm run dev</code> to save.
      </p>
    </section>
  )
}

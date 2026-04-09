import { useCallback, useEffect, useState } from 'react'
import type { DbConnection } from '../database/connectionsStorage'

type RedisKeyRow = { key: string; type: string }

type RedisValueResponse =
  | { ok: true; key: string; redisType: 'string'; stringValue: string | null }
  | { ok: true; key: string; redisType: 'hash'; hashEntries: Record<string, string> }
  | {
      ok: true
      key: string
      redisType: 'list'
      listItems: string[]
      listLength: number
    }
  | { ok: true; key: string; redisType: 'set'; setMembers: string[] }
  | {
      ok: true
      key: string
      redisType: 'zset'
      zsetMembers: { score: number; member: string }[]
      zsetLength: number
    }
  | {
      ok: true
      key: string
      redisType: 'stream'
      streamEntries: { id: string; message: Record<string, unknown> }[]
    }
  | { ok: true; key: string; redisType: string; unsupported: true }
  | { ok: false; error?: string }

type RedisValueOk = Extract<RedisValueResponse, { ok: true }>
type RedisValueSupported = Exclude<RedisValueOk, { unsupported: true }>

function formatStringPreview(raw: string | null): { mode: 'json' | 'text'; body: string } {
  if (raw == null) return { mode: 'text', body: '(nil)' }
  const t = raw.trim()
  if (!t) return { mode: 'text', body: '' }
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return { mode: 'json', body: JSON.stringify(JSON.parse(t), null, 2) }
    } catch {
      /* fall through */
    }
  }
  return { mode: 'text', body: raw }
}

export function RedisDataBrowser({ connection }: { connection: DbConnection }) {
  const [keys, setKeys] = useState<RedisKeyRow[]>([])
  const [cursor, setCursor] = useState<string>('0')
  const [hasMore, setHasMore] = useState(false)
  const [matchDraft, setMatchDraft] = useState('')
  const [matchApplied, setMatchApplied] = useState('')
  const [keysLoading, setKeysLoading] = useState(false)
  const [keysError, setKeysError] = useState<string | null>(null)

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [valueData, setValueData] = useState<RedisValueResponse | null>(null)
  const [valueLoading, setValueLoading] = useState(false)
  const [valueError, setValueError] = useState<string | null>(null)

  const host = connection.host
  const port = connection.port
  const password = connection.password?.trim() || undefined

  const fetchKeyBatch = useCallback(
    async (scanCursor: string, append: boolean) => {
      setKeysLoading(true)
      setKeysError(null)
      try {
        const res = await fetch('/api/db/redis/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            host,
            port,
            password,
            cursor: scanCursor === '0' && !append ? undefined : scanCursor,
            match: matchApplied || undefined,
          }),
        })
        const data = (await res.json()) as {
          ok?: boolean
          keys?: RedisKeyRow[]
          cursor?: string
          hasMore?: boolean
          error?: string
        }
        if (!data.ok) {
          setKeysError(data.error || 'Failed to list keys.')
          if (!append) {
            setKeys([])
            setCursor('0')
            setHasMore(false)
          }
          return
        }
        const next = data.keys ?? []
        setKeys((prev) => (append ? [...prev, ...next] : next))
        setCursor(data.cursor ?? '0')
        setHasMore(Boolean(data.hasMore))
      } catch (e) {
        setKeysError(e instanceof Error ? e.message : 'Request failed.')
        if (!append) {
          setKeys([])
          setCursor('0')
          setHasMore(false)
        }
      } finally {
        setKeysLoading(false)
      }
    },
    [host, port, password, matchApplied],
  )

  useEffect(() => {
    setSelectedKey(null)
    setValueData(null)
    void fetchKeyBatch('0', false)
  }, [connection.id, matchApplied, fetchKeyBatch])

  const applyMatch = useCallback(() => {
    setMatchApplied(matchDraft.trim())
  }, [matchDraft])

  const loadValue = useCallback(
    async (key: string) => {
      setSelectedKey(key)
      setValueLoading(true)
      setValueError(null)
      setValueData(null)
      try {
        const res = await fetch('/api/db/redis/value', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host, port, password, key }),
        })
        const data = (await res.json()) as RedisValueResponse
        if (!data.ok) {
          setValueError((data as { error?: string }).error || 'Failed to read value.')
          return
        }
        setValueData(data)
      } catch (e) {
        setValueError(e instanceof Error ? e.message : 'Request failed.')
      } finally {
        setValueLoading(false)
      }
    },
    [host, port, password],
  )

  return (
    <section className="panel redis-data-browser-page db-browser" aria-label="Redis data browser">
      <h2 className="visually-hidden">Redis — {connection.name}</h2>
      <div className="redis-data-browser-page__body db-browser__body">
        <div className="redis-data-browser__panes db-browser__panes">
          <div className="redis-data-browser__list-pane db-browser__pane db-browser__pane--sidebar">
            <div className="db-browser__pane-header">
              <span className="db-browser__pane-title">Keys</span>
              {keys.length > 0 ? (
                <span className="db-browser__pane-stat">{keys.length} loaded</span>
              ) : null}
            </div>
            <div className="redis-data-browser__toolbar db-browser__toolbar">
                <input
                  className="redis-data-browser__match"
                  type="text"
                  value={matchDraft}
                  onChange={(e) => setMatchDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyMatch()
                  }}
                  placeholder="Filter pattern (e.g. user:*)"
                  aria-label="Key pattern filter"
                />
                <button type="button" className="btn btn--ghost btn--xs" onClick={() => applyMatch()}>
                  Apply
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--xs"
                  disabled={keysLoading}
                  onClick={() => void fetchKeyBatch('0', false)}
                >
                  Refresh
                </button>
              </div>
              {keysError ? (
                <div className="host-editor__banner host-editor__banner--err redis-data-browser__banner">
                  {keysError}
                </div>
              ) : null}
              <ul className="redis-data-browser__key-list" role="listbox" aria-label="Redis keys">
                {keys.map((row) => (
                  <li key={row.key}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selectedKey === row.key}
                      className={`redis-data-browser__key-row${selectedKey === row.key ? ' redis-data-browser__key-row--active' : ''}`}
                      onClick={() => void loadValue(row.key)}
                    >
                      <span className="redis-data-browser__key-name" title={row.key}>
                        {row.key}
                      </span>
                      <span className={`redis-data-browser__type-pill redis-data-browser__type-pill--${row.type}`}>
                        {row.type}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="redis-data-browser__list-foot db-browser__list-foot">
                {keysLoading ? (
                  <span className="db-browser__inline-loading">
                    <span className="db-browser__spinner" aria-hidden />
                    Scanning…
                  </span>
                ) : null}
                {hasMore ? (
                  <button
                    type="button"
                    className="btn btn--primary btn--xs"
                    disabled={keysLoading}
                    onClick={() => void fetchKeyBatch(cursor, true)}
                  >
                    Load more keys
                  </button>
                ) : keys.length > 0 && !keysLoading ? (
                  <span className="redis-data-browser__muted">End of scan</span>
                ) : null}
              </div>
            </div>
            <div className="redis-data-browser__detail-pane db-browser__pane db-browser__pane--main">
              <div className="db-browser__pane-header">
                <span className="db-browser__pane-title">Value</span>
                {selectedKey ? (
                  <span className="db-browser__pane-stat db-browser__pane-stat--mono" title={selectedKey}>
                    {selectedKey}
                  </span>
                ) : null}
              </div>
              <div className="db-browser__detail-body">
                {!selectedKey ? (
                  <div className="db-browser__empty" role="status">
                    <div className="db-browser__empty-icon" aria-hidden />
                    <p className="db-browser__empty-title">Pick a key</p>
                    <p className="db-browser__empty-text">
                      Select any key from the list to load its Redis type and payload here.
                    </p>
                  </div>
                ) : valueLoading ? (
                  <div className="db-browser__loading" role="status">
                    <span className="db-browser__spinner" aria-hidden />
                    Loading value…
                  </div>
                ) : valueError ? (
                  <div className="host-editor__banner host-editor__banner--err db-browser__banner">{valueError}</div>
                ) : valueData?.ok ? (
                  <RedisValueView
                    data={valueData}
                    host={host}
                    port={port}
                    password={password}
                    onReload={() => {
                      if (selectedKey) void loadValue(selectedKey)
                    }}
                  />
                ) : null}
              </div>
            </div>
          </div>
      </div>
    </section>
  )
}

function RedisStringEditor({
  redisKey,
  stringValue,
  host,
  port,
  password,
  onReload,
}: {
  redisKey: string
  stringValue: string | null
  host: string
  port: number
  password?: string
  onReload: () => void
}) {
  const [draft, setDraft] = useState(stringValue ?? '')
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)

  useEffect(() => {
    setDraft(stringValue ?? '')
    setSaveErr(null)
  }, [redisKey, stringValue])

  const save = async () => {
    setSaving(true)
    setSaveErr(null)
    try {
      const res = await fetch('/api/db/redis/set-string', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port, password, key: redisKey, value: draft }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!data.ok) {
        setSaveErr(data.error || 'Failed to save.')
        return
      }
      onReload()
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : 'Request failed.')
    } finally {
      setSaving(false)
    }
  }

  const fmt = formatStringPreview(draft === '' && stringValue == null ? null : draft)
  return (
    <div className="redis-data-browser__detail-inner redis-data-browser__value-shell">
      <div className="redis-data-browser__detail-head">
        <span className="redis-data-browser__detail-key" title={redisKey}>
          {redisKey}
        </span>
        <span className="redis-data-browser__type-pill redis-data-browser__type-pill--string">string</span>
      </div>
      <div className="redis-data-browser__edit-bar">
        <button type="button" className="btn btn--primary btn--xs" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save value'}
        </button>
        {saveErr ? <span className="redis-data-browser__edit-err">{saveErr}</span> : null}
      </div>
      <textarea
        className={`redis-data-browser__pre redis-data-browser__string-editor${fmt.mode === 'json' ? ' redis-data-browser__pre--json' : ''}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        aria-label="Redis string value"
        rows={Math.min(24, Math.max(6, draft.split('\n').length + 1))}
      />
    </div>
  )
}

function RedisHashFieldRow({
  redisKey,
  field,
  initialValue,
  host,
  port,
  password,
  onSaved,
}: {
  redisKey: string
  field: string
  initialValue: string
  host: string
  port: number
  password?: string
  onSaved: () => void
}) {
  const [draft, setDraft] = useState(initialValue)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setDraft(initialValue)
    setErr(null)
  }, [redisKey, field, initialValue])

  const dirty = draft !== initialValue

  const save = async () => {
    setSaving(true)
    setErr(null)
    try {
      const res = await fetch('/api/db/redis/hash-set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port, password, key: redisKey, field, value: draft }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!data.ok) {
        setErr(data.error || 'Failed to save field.')
        return
      }
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Request failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr>
      <td>
        <code className="host-editor__inline-code">{field}</code>
      </td>
      <td className="redis-data-browser__cell-value redis-data-browser__hash-cell">
        <input
          type="text"
          className="redis-data-browser__hash-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={`Value for ${field}`}
        />
        {dirty ? (
          <button type="button" className="btn btn--primary btn--xs" disabled={saving} onClick={() => void save()}>
            {saving ? '…' : 'Save'}
          </button>
        ) : null}
        {err ? <span className="redis-data-browser__edit-err">{err}</span> : null}
      </td>
    </tr>
  )
}

function RedisValueView({
  data,
  host,
  port,
  password,
  onReload,
}: {
  data: RedisValueOk
  host: string
  port: number
  password?: string
  onReload: () => void
}) {
  if ('unsupported' in data && data.unsupported) {
    return (
      <div className="redis-data-browser__detail-inner redis-data-browser__value-shell">
        <div className="redis-data-browser__detail-head">
          <span className="redis-data-browser__detail-key" title={data.key}>
            {data.key}
          </span>
          <span className={`redis-data-browser__type-pill redis-data-browser__type-pill--${data.redisType}`}>
            {data.redisType}
          </span>
        </div>
        <p className="redis-data-browser__placeholder">
          This type is not supported in the browser yet. Use redis-cli for full access.
        </p>
      </div>
    )
  }

  const d = data as RedisValueSupported

  if (d.redisType === 'string') {
    return (
      <RedisStringEditor
        redisKey={d.key}
        stringValue={d.stringValue}
        host={host}
        port={port}
        password={password}
        onReload={onReload}
      />
    )
  }
  if (d.redisType === 'hash') {
    const entries = Object.entries(d.hashEntries)
    return (
      <div className="redis-data-browser__detail-inner redis-data-browser__value-shell">
        <div className="redis-data-browser__detail-head">
          <span className="redis-data-browser__detail-key" title={d.key}>
            {d.key}
          </span>
          <span className="redis-data-browser__type-pill redis-data-browser__type-pill--hash">hash</span>
          <span className="redis-data-browser__muted">{entries.length} fields · edit values and Save per row</span>
        </div>
        <div className="table-wrap redis-data-browser__table-wrap">
          <table className="data-table redis-data-browser__table">
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([k, v]) => (
                <RedisHashFieldRow
                  key={k}
                  redisKey={d.key}
                  field={k}
                  initialValue={String(v)}
                  host={host}
                  port={port}
                  password={password}
                  onSaved={onReload}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }
  if (d.redisType === 'list') {
    return (
      <div className="redis-data-browser__detail-inner redis-data-browser__value-shell">
        <div className="redis-data-browser__detail-head">
          <span className="redis-data-browser__detail-key" title={d.key}>
            {d.key}
          </span>
          <span className="redis-data-browser__type-pill redis-data-browser__type-pill--list">list</span>
          <span className="redis-data-browser__muted">
            showing {d.listItems.length} of {d.listLength}
          </span>
        </div>
        <ul className="redis-data-browser__index-list">
          {d.listItems.map((item, i) => (
            <li key={i}>
              <code className="redis-data-browser__list-idx">{i}</code>
              <span className="redis-data-browser__cell-value">{item}</span>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  if (d.redisType === 'set') {
    const sorted = [...d.setMembers].sort((a, b) => a.localeCompare(b))
    return (
      <div className="redis-data-browser__detail-inner redis-data-browser__value-shell">
        <div className="redis-data-browser__detail-head">
          <span className="redis-data-browser__detail-key" title={d.key}>
            {d.key}
          </span>
          <span className="redis-data-browser__type-pill redis-data-browser__type-pill--set">set</span>
          <span className="redis-data-browser__muted">{sorted.length} members</span>
        </div>
        <ul className="redis-data-browser__bullet-list">
          {sorted.map((m) => (
            <li key={m}>
              <span className="redis-data-browser__cell-value">{m}</span>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  if (d.redisType === 'zset') {
    return (
      <div className="redis-data-browser__detail-inner redis-data-browser__value-shell">
        <div className="redis-data-browser__detail-head">
          <span className="redis-data-browser__detail-key" title={d.key}>
            {d.key}
          </span>
          <span className="redis-data-browser__type-pill redis-data-browser__type-pill--zset">zset</span>
          <span className="redis-data-browser__muted">
            showing {d.zsetMembers.length} of {d.zsetLength}
          </span>
        </div>
        <div className="table-wrap redis-data-browser__table-wrap">
          <table className="data-table redis-data-browser__table">
            <thead>
              <tr>
                <th scope="col">Score</th>
                <th scope="col">Member</th>
              </tr>
            </thead>
            <tbody>
              {d.zsetMembers.map((row, i) => (
                <tr key={`${row.member}-${i}`}>
                  <td>
                    <code className="host-editor__inline-code">{String(row.score)}</code>
                  </td>
                  <td className="redis-data-browser__cell-value">{row.member}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }
  if (d.redisType === 'stream') {
    return (
      <div className="redis-data-browser__detail-inner redis-data-browser__value-shell">
        <div className="redis-data-browser__detail-head">
          <span className="redis-data-browser__detail-key" title={d.key}>
            {d.key}
          </span>
          <span className="redis-data-browser__type-pill redis-data-browser__type-pill--stream">stream</span>
          <span className="redis-data-browser__muted">first {d.streamEntries.length} entries</span>
        </div>
        <div className="table-wrap redis-data-browser__table-wrap">
          <table className="data-table redis-data-browser__table">
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Fields</th>
              </tr>
            </thead>
            <tbody>
              {d.streamEntries.map((ent) => (
                <tr key={ent.id}>
                  <td>
                    <code className="host-editor__inline-code">{ent.id}</code>
                  </td>
                  <td>
                    <pre className="redis-data-browser__pre redis-data-browser__pre--inline">
                      {JSON.stringify(ent.message ?? {}, null, 2)}
                    </pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }
  return (
    <div className="redis-data-browser__value-shell redis-data-browser__value-shell--message">
      <p className="redis-data-browser__placeholder">
        Unsupported or unknown value layout for this key. Use redis-cli for full access.
      </p>
    </div>
  )
}

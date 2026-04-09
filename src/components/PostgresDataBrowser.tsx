import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DbConnection } from '../database/connectionsStorage'

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number]

const PAGE_SIZE_STORAGE_KEY = 'dev-manager-postgres-page-size'

function readStoredPageSize(): PageSizeOption {
  try {
    const n = Number(localStorage.getItem(PAGE_SIZE_STORAGE_KEY))
    if (PAGE_SIZE_OPTIONS.includes(n as PageSizeOption)) return n as PageSizeOption
  } catch {
    /* ignore */
  }
  return 100
}

function pgConnBody(c: DbConnection) {
  return {
    host: c.host,
    port: c.port,
    username: c.username?.trim() || 'postgres',
    database: c.database?.trim() || 'postgres',
    password: c.password?.trim() || undefined,
  }
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'object') {
    if (Array.isArray(v)) return JSON.stringify(v)
    const o = v as Record<string, unknown>
    if (o.type === 'Buffer' && Array.isArray(o.data)) {
      const u8 = new Uint8Array(o.data as number[])
      let s = ''
      const max = Math.min(u8.length, 48)
      for (let i = 0; i < max; i++) s += u8[i]!.toString(16).padStart(2, '0')
      return u8.length > 48 ? `${s}… (${u8.length} bytes)` : s || '(empty)'
    }
    return JSON.stringify(v)
  }
  return String(v)
}

function cellEditText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (o.type === 'Buffer' && Array.isArray(o.data)) return formatCell(value)
    return JSON.stringify(value)
  }
  return String(value)
}

function isProbablyBinaryCell(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return o.type === 'Buffer' && Array.isArray(o.data)
}

function stableRowKey(row: Record<string, unknown>, pkCols: string[], ri: number): string {
  if (pkCols.length === 0) return `r-${ri}`
  return pkCols.map((c) => JSON.stringify(row[c])).join('\u001f')
}

export function PostgresDataBrowser({ connection, onBack }: { connection: DbConnection; onBack: () => void }) {
  const base = useMemo(() => pgConnBody(connection), [
    connection.host,
    connection.port,
    connection.username,
    connection.database,
    connection.password,
  ])

  const [schemas, setSchemas] = useState<string[]>([])
  const [schemasLoading, setSchemasLoading] = useState(false)
  const [schemasError, setSchemasError] = useState<string | null>(null)
  const [selectedSchema, setSelectedSchema] = useState<string | null>(null)

  const [tables, setTables] = useState<{ name: string; type: string }[]>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  const [tablesError, setTablesError] = useState<string | null>(null)
  const [selectedTable, setSelectedTable] = useState<string | null>(null)

  const [columns, setColumns] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [rowsLoading, setRowsLoading] = useState(false)
  const [rowsError, setRowsError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSize] = useState<PageSizeOption>(() => readStoredPageSize())
  const [hasMore, setHasMore] = useState(false)
  const [tableType, setTableType] = useState<string | null>(null)
  const [primaryKeyColumns, setPrimaryKeyColumns] = useState<string[]>([])
  const [editing, setEditing] = useState<{ rowIndex: number; column: string } | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editMultiline, setEditMultiline] = useState(false)
  const [cellSaveError, setCellSaveError] = useState<string | null>(null)
  const [cellSaving, setCellSaving] = useState(false)
  const editBaselineRef = useRef('')
  const cellInputRef = useRef<HTMLInputElement | null>(null)
  const cellTextareaRef = useRef<HTMLTextAreaElement | null>(null)

  const loadSchemas = useCallback(async () => {
    setSchemasLoading(true)
    setSchemasError(null)
    try {
      const res = await fetch('/api/db/postgres/schemas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(base),
      })
      const data = (await res.json()) as { ok?: boolean; schemas?: string[]; error?: string }
      if (!data.ok) {
        setSchemasError(data.error || 'Failed to list schemas.')
        setSchemas([])
        setSelectedSchema(null)
        return
      }
      const list = data.schemas ?? []
      setSchemas(list)
      setSelectedSchema((prev) => (prev && list.includes(prev) ? prev : list[0] ?? null))
    } catch (e) {
      setSchemasError(e instanceof Error ? e.message : 'Request failed.')
      setSchemas([])
      setSelectedSchema(null)
    } finally {
      setSchemasLoading(false)
    }
  }, [base])

  useEffect(() => {
    setSelectedTable(null)
    setColumns([])
    setRows([])
    setOffset(0)
    setHasMore(false)
    void loadSchemas()
  }, [connection.id, loadSchemas])

  const loadTables = useCallback(
    async (schema: string) => {
      setTablesLoading(true)
      setTablesError(null)
      try {
        const res = await fetch('/api/db/postgres/tables', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...base, schema }),
        })
        const data = (await res.json()) as {
          ok?: boolean
          tables?: { name: string; type: string }[]
          error?: string
        }
        if (!data.ok) {
          setTablesError(data.error || 'Failed to list tables.')
          setTables([])
          setSelectedTable(null)
          return
        }
        const list = data.tables ?? []
        setTables(list)
        setSelectedTable(null)
      } catch (e) {
        setTablesError(e instanceof Error ? e.message : 'Request failed.')
        setTables([])
        setSelectedTable(null)
      } finally {
        setTablesLoading(false)
      }
    },
    [base],
  )

  useEffect(() => {
    if (!selectedSchema) {
      setTables([])
      setSelectedTable(null)
      return
    }
    void loadTables(selectedSchema)
  }, [selectedSchema, loadTables])

  const loadRows = useCallback(
    async (schema: string, table: string, off: number) => {
      setRowsLoading(true)
      setRowsError(null)
      try {
        const res = await fetch('/api/db/postgres/rows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...base,
            schema,
            table,
            limit: pageSize,
            offset: off,
          }),
        })
        const data = (await res.json()) as {
          ok?: boolean
          columns?: string[]
          rows?: Record<string, unknown>[]
          hasMore?: boolean
          error?: string
          tableType?: string | null
          primaryKeyColumns?: string[]
        }
        if (!data.ok) {
          setRowsError(data.error || 'Failed to load rows.')
          setColumns([])
          setRows([])
          setHasMore(false)
          setTableType(null)
          setPrimaryKeyColumns([])
          return
        }
        setColumns(data.columns ?? [])
        setRows(data.rows ?? [])
        setHasMore(Boolean(data.hasMore))
        setOffset(off)
        setTableType(typeof data.tableType === 'string' ? data.tableType : null)
        setPrimaryKeyColumns(Array.isArray(data.primaryKeyColumns) ? data.primaryKeyColumns : [])
        setEditing(null)
        setEditDraft('')
        setCellSaveError(null)
        setEditMultiline(false)
      } catch (e) {
        setRowsError(e instanceof Error ? e.message : 'Request failed.')
        setColumns([])
        setRows([])
        setHasMore(false)
        setTableType(null)
        setPrimaryKeyColumns([])
      } finally {
        setRowsLoading(false)
      }
    },
    [base, pageSize],
  )

  useEffect(() => {
    if (!selectedSchema || !selectedTable) {
      setColumns([])
      setRows([])
      setOffset(0)
      setHasMore(false)
      setTableType(null)
      setPrimaryKeyColumns([])
      return
    }
    void loadRows(selectedSchema, selectedTable, 0)
  }, [selectedSchema, selectedTable, pageSize, loadRows])

  useEffect(() => {
    setEditing(null)
    setEditDraft('')
    setEditMultiline(false)
    setCellSaveError(null)
  }, [selectedSchema, selectedTable, connection.id])

  const canEditTable = tableType === 'BASE TABLE' && primaryKeyColumns.length > 0

  const cancelCellEdit = useCallback(() => {
    setEditing(null)
    setEditDraft('')
    setEditMultiline(false)
  }, [])

  const commitCellEdit = useCallback(async () => {
    if (!editing || !selectedSchema || !selectedTable || cellSaving) return
    const row = rows[editing.rowIndex]
    if (!row) return
    setCellSaving(true)
    setCellSaveError(null)
    const primaryKey = Object.fromEntries(primaryKeyColumns.map((k) => [k, row[k]]))
    try {
      const res = await fetch('/api/db/postgres/update-cell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...base,
          schema: selectedSchema,
          table: selectedTable,
          column: editing.column,
          primaryKey,
          valueText: editDraft,
        }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!data.ok) {
        setCellSaveError(data.error || 'Update failed.')
        return
      }
      cancelCellEdit()
      await loadRows(selectedSchema, selectedTable, offset)
    } catch (e) {
      setCellSaveError(e instanceof Error ? e.message : 'Request failed.')
    } finally {
      setCellSaving(false)
    }
  }, [
    editing,
    selectedSchema,
    selectedTable,
    cellSaving,
    rows,
    primaryKeyColumns,
    editDraft,
    base,
    cancelCellEdit,
    loadRows,
    offset,
  ])

  const beginCellEdit = useCallback(
    (rowIndex: number, column: string, row: Record<string, unknown>) => {
      if (!canEditTable) return
      if (primaryKeyColumns.includes(column)) return
      const v = row[column]
      if (isProbablyBinaryCell(v)) return
      setCellSaveError(null)
      const text = cellEditText(v)
      setEditing({ rowIndex, column })
      setEditDraft(text)
      setEditMultiline(text.includes('\n'))
      editBaselineRef.current = text
    },
    [canEditTable, primaryKeyColumns],
  )

  const pickTable = (name: string) => {
    setSelectedTable(name)
    setOffset(0)
  }

  const host = connection.host
  const port = connection.port

  const pageNumber = Math.floor(offset / pageSize) + 1
  const rowStart = rows.length === 0 ? 0 : offset + 1
  const rowEnd = offset + rows.length

  useEffect(() => {
    if (!editing) return
    const el = editMultiline ? cellTextareaRef.current : cellInputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [editing, editMultiline])

  return (
    <section className="panel postgres-data-browser-page db-browser" aria-labelledby="pg-browser-title">
      <header className="panel__head postgres-data-browser-page__head db-browser__head">
        <div className="db-browser__head-left">
          <nav className="db-browser__nav" aria-label="Breadcrumb">
            <button
              type="button"
              className="db-browser__back-link"
              onClick={onBack}
              aria-label="Back to database connections"
            >
              <span className="db-browser__back-icon" aria-hidden>
                ←
              </span>
              <span className="db-browser__back-label">Connections</span>
            </button>
          </nav>
        </div>
        <div className="db-browser__head-right">
          <div className="db-browser__title-line">
            <h2 id="pg-browser-title" className="db-browser__page-title">
              Data browser
            </h2>
            <span className="db-browser__badge db-browser__badge--postgres">PostgreSQL</span>
            <div className="db-browser__meta" aria-label="Connection details">
              <span className="db-browser__chip db-browser__chip--name" title={connection.name}>
                <strong>{connection.name}</strong>
              </span>
              <span className="db-browser__chip db-browser__chip--mono" title={`${host}:${port}`}>
                {host}:{port}
              </span>
              <span className="db-browser__chip db-browser__chip--mono" title={base.database}>
                db {base.database}
              </span>
            </div>
          </div>
        </div>
      </header>
      <div className="postgres-data-browser-page__body db-browser__body">
        <div className="postgres-data-browser__panes db-browser__panes">
          <div className="postgres-data-browser__list-pane db-browser__pane db-browser__pane--sidebar">
            <div className="postgres-data-browser__section postgres-data-browser__section--schemas">
              <label className="postgres-data-browser__field-label" htmlFor="pg-schema-select">
                Schema
              </label>
              {schemasError ? (
                <div className="host-editor__banner host-editor__banner--err postgres-data-browser__banner">
                  {schemasError}
                </div>
              ) : null}
              {schemasLoading ? (
                <div className="db-browser__section-loading" role="status">
                  <span className="db-browser__spinner" aria-hidden />
                  Loading schemas…
                </div>
              ) : schemas.length === 0 ? (
                <p className="postgres-data-browser__muted">No schemas available.</p>
              ) : (
                <select
                  id="pg-schema-select"
                  className="postgres-data-browser__schema-select"
                  aria-label="Database schema"
                  value={selectedSchema ?? schemas[0] ?? ''}
                  onChange={(e) => setSelectedSchema(e.target.value || null)}
                >
                  {schemas.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="postgres-data-browser__section postgres-data-browser__section--tables">
              <h3 className="postgres-data-browser__section-title">Tables &amp; views</h3>
              {!selectedSchema ? (
                <p className="postgres-data-browser__muted">Choose a schema from the menu above.</p>
              ) : tablesError ? (
                <div className="host-editor__banner host-editor__banner--err postgres-data-browser__banner">
                  {tablesError}
                </div>
              ) : tablesLoading ? (
                <div className="db-browser__section-loading" role="status">
                  <span className="db-browser__spinner" aria-hidden />
                  Loading tables…
                </div>
              ) : tables.length === 0 ? (
                <p className="postgres-data-browser__muted">No tables in this schema.</p>
              ) : (
                <ul className="postgres-data-browser__mini-list" aria-label="Tables">
                  {tables.map((t) => (
                    <li key={t.name}>
                      <button
                        type="button"
                        className={`postgres-data-browser__pick postgres-data-browser__pick--table${selectedTable === t.name ? ' postgres-data-browser__pick--active' : ''}`}
                        onClick={() => pickTable(t.name)}
                      >
                        <span className="postgres-data-browser__table-name">{t.name}</span>
                        {t.type === 'VIEW' ? (
                          <span className="postgres-data-browser__type-pill postgres-data-browser__type-pill--view">
                            view
                          </span>
                        ) : (
                          <span className="postgres-data-browser__type-pill postgres-data-browser__type-pill--table">
                            table
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <div className="postgres-data-browser__grid-pane db-browser__pane db-browser__pane--main">
            <div className="db-browser__detail-body postgres-data-browser__grid-body">
            {!selectedTable ? (
              <div className="db-browser__empty" role="status">
                <div className="db-browser__empty-icon db-browser__empty-icon--grid" aria-hidden />
                <p className="db-browser__empty-title">Select a table</p>
                <p className="db-browser__empty-text">
                  Pick a schema from the dropdown, then a table or view, to load rows. Base tables with a primary key
                  support in-cell editing (double-click a cell).
                </p>
              </div>
            ) : rowsLoading && rows.length === 0 ? (
              <div className="db-browser__loading" role="status">
                <span className="db-browser__spinner" aria-hidden />
                Loading rows…
              </div>
            ) : rowsError ? (
              <div className="host-editor__banner host-editor__banner--err db-browser__banner">{rowsError}</div>
            ) : (
              <>
                <div className="postgres-data-browser__grid-toolbar db-browser__data-toolbar">
                  <div className="db-browser__fqn" title={`${selectedSchema}.${selectedTable}`}>
                    <span className="db-browser__fqn-schema">{selectedSchema}</span>
                    <span className="db-browser__fqn-dot">.</span>
                    <span className="db-browser__fqn-table">{selectedTable}</span>
                  </div>
                  <div className="db-browser__pager db-browser__pager--rich" role="navigation" aria-label="Table pagination">
                    <div className="db-browser__pager-summary" aria-live="polite">
                      {rows.length === 0 && !rowsLoading ? (
                        <span className="db-browser__pager-range">
                          No rows on this page
                          <span className="db-browser__pager-dot">·</span>
                          <span className="db-browser__pager-per-page">{pageSize} per page</span>
                        </span>
                      ) : (
                        <span className="db-browser__pager-range">
                          Rows <strong>{rowStart}</strong>
                          <span className="db-browser__pager-range-sep">–</span>
                          <strong>{rowEnd}</strong>
                          <span className="db-browser__pager-dot">·</span>
                          <span className="db-browser__pager-page">Page {pageNumber}</span>
                          <span className="db-browser__pager-dot">·</span>
                          <span className="db-browser__pager-per-page">{pageSize} per page</span>
                        </span>
                      )}
                      {rowsLoading ? (
                        <span className="db-browser__spinner db-browser__spinner--inline" aria-hidden />
                      ) : null}
                    </div>
                    <div className="postgres-data-browser__page-size">
                      <label htmlFor="pg-rows-per-page" className="postgres-data-browser__page-size-label">
                        Per page
                      </label>
                      <select
                        id="pg-rows-per-page"
                        className="postgres-data-browser__page-size-select"
                        aria-label="Rows per page"
                        value={pageSize}
                        disabled={rowsLoading || cellSaving}
                        onChange={(e) => {
                          const next = Number(e.target.value) as PageSizeOption
                          if (!PAGE_SIZE_OPTIONS.includes(next)) return
                          try {
                            localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(next))
                          } catch {
                            /* ignore */
                          }
                          setPageSize(next)
                        }}
                      >
                        {PAGE_SIZE_OPTIONS.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="db-browser__pager-actions">
                      <button
                        type="button"
                        className="btn btn--ghost btn--xs"
                        title="First page"
                        disabled={rowsLoading || cellSaving || offset === 0}
                        onClick={() => {
                          if (!selectedSchema || !selectedTable) return
                          void loadRows(selectedSchema, selectedTable, 0)
                        }}
                      >
                        « First
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--xs"
                        title="Previous page"
                        disabled={rowsLoading || cellSaving || offset === 0}
                        onClick={() => {
                          if (!selectedSchema || !selectedTable) return
                          const next = Math.max(0, offset - pageSize)
                          void loadRows(selectedSchema, selectedTable, next)
                        }}
                      >
                        ‹ Prev
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--xs"
                        title="Next page"
                        disabled={rowsLoading || cellSaving || !hasMore}
                        onClick={() => {
                          if (!selectedSchema || !selectedTable) return
                          void loadRows(selectedSchema, selectedTable, offset + pageSize)
                        }}
                      >
                        Next ›
                      </button>
                    </div>
                  </div>
                </div>
                {cellSaveError ? (
                  <div className="host-editor__banner host-editor__banner--err postgres-data-browser__cell-banner">
                    {cellSaveError}
                  </div>
                ) : null}
                <div className="table-wrap postgres-data-browser__table-wrap">
                  <table className="data-table postgres-data-browser__data-table">
                    <thead>
                      <tr>
                        {columns.map((col) => (
                          <th
                            key={col}
                            scope="col"
                            className={primaryKeyColumns.includes(col) ? 'postgres-data-browser__th--pk' : undefined}
                          >
                            {col}
                            {primaryKeyColumns.includes(col) ? (
                              <span className="postgres-data-browser__pk-mark" title="Primary key">
                                PK
                              </span>
                            ) : null}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, ri) => (
                        <tr key={stableRowKey(row, primaryKeyColumns, ri)}>
                          {columns.map((col) => {
                            const isPk = primaryKeyColumns.includes(col)
                            const isEditing = editing?.rowIndex === ri && editing?.column === col
                            const editable =
                              canEditTable && !isPk && !isProbablyBinaryCell(row[col])
                            return (
                              <td
                                key={col}
                                className={`postgres-data-browser__cell${isEditing ? ' postgres-data-browser__cell--editing' : ''}${editable ? ' postgres-data-browser__cell--editable' : ''}${isPk ? ' postgres-data-browser__cell--pk' : ''}`}
                                onDoubleClick={() => beginCellEdit(ri, col, row)}
                                title={
                                  editable
                                    ? 'Double-click to edit · Enter save · Esc cancel'
                                    : isPk
                                      ? 'Primary key (not editable here)'
                                      : undefined
                                }
                              >
                                {isEditing ? (
                                  editMultiline ? (
                                    <textarea
                                      ref={cellTextareaRef}
                                      className="postgres-data-browser__cell-input postgres-data-browser__cell-input--multi"
                                      rows={4}
                                      value={editDraft}
                                      disabled={cellSaving}
                                      onChange={(e) => setEditDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Escape') {
                                          e.preventDefault()
                                          cancelCellEdit()
                                        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                          e.preventDefault()
                                          void commitCellEdit()
                                        }
                                      }}
                                      onBlur={() => {
                                        if (cellSaving) return
                                        if (editDraft === editBaselineRef.current) cancelCellEdit()
                                        else void commitCellEdit()
                                      }}
                                      aria-label={`Edit ${col}`}
                                    />
                                  ) : (
                                    <input
                                      ref={cellInputRef}
                                      type="text"
                                      className="postgres-data-browser__cell-input"
                                      value={editDraft}
                                      disabled={cellSaving}
                                      onChange={(e) => setEditDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Escape') {
                                          e.preventDefault()
                                          cancelCellEdit()
                                        } else if (e.key === 'Enter') {
                                          e.preventDefault()
                                          void commitCellEdit()
                                        }
                                      }}
                                      onBlur={() => {
                                        if (cellSaving) return
                                        if (editDraft === editBaselineRef.current) cancelCellEdit()
                                        else void commitCellEdit()
                                      }}
                                      aria-label={`Edit ${col}`}
                                    />
                                  )
                                ) : (
                                  formatCell(row[col])
                                )}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

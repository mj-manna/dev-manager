import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DbConnection } from '../database/connectionsStorage'
import { toast } from '../toast/toastBus'

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number]

const PAGE_SIZE_STORAGE_KEY = 'dev-manager-postgres-page-size'
/** Matches vite-plugin-postgres-browser-api MAX_OFFSET for last-page navigation. */
const PG_BROWSER_MAX_OFFSET = 1_000_000

const PG_FILTER_OPS = [
  { value: '=', label: '= equals' },
  { value: '!=', label: '≠ not equal' },
  { value: '<', label: '< less' },
  { value: '>', label: '> greater' },
  { value: '<=', label: '≤ less or equal' },
  { value: '>=', label: '≥ greater or equal' },
  { value: 'LIKE', label: 'LIKE pattern' },
  { value: 'ILIKE', label: 'ILIKE case-insensitive' },
  { value: 'IS_NULL', label: 'IS NULL' },
  { value: 'IS_NOT_NULL', label: 'IS NOT NULL' },
] as const

type PgFilterOp = (typeof PG_FILTER_OPS)[number]['value']

type PgRowFilter = { column: string; op: PgFilterOp; value: string }

function PostgresReloadAllGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  )
}

function pgRowFilterNeedsValue(op: PgFilterOp): boolean {
  return op !== 'IS_NULL' && op !== 'IS_NOT_NULL'
}

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

/** Stable id for multi-select; includes page offset when there is no PK so indices do not collide across pages. */
function rowSelectionKey(
  row: Record<string, unknown>,
  pkCols: string[],
  ri: number,
  pageOffset: number,
): string {
  if (pkCols.length === 0) return `${pageOffset}\u001f${ri}`
  return stableRowKey(row, pkCols, ri)
}

function primaryKeySnapshot(
  row: Record<string, unknown>,
  pkCols: string[],
): Record<string, unknown> | null {
  if (pkCols.length === 0) return null
  return Object.fromEntries(pkCols.map((c) => [c, row[c]]))
}

function dedupePrimaryKeyRows(
  rows: Record<string, unknown>[],
  pkCols: string[],
): Record<string, unknown>[] {
  const seen = new Set<string>()
  const out: Record<string, unknown>[] = []
  for (const row of rows) {
    const sig = pkCols.map((c) => JSON.stringify(row[c])).join('\u001f')
    if (seen.has(sig)) continue
    seen.add(sig)
    out.push(row)
  }
  return out
}

export function PostgresDataBrowser({ connection }: { connection: DbConnection }) {
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
  const [tableListSearch, setTableListSearch] = useState('')

  const [columns, setColumns] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [rowsLoading, setRowsLoading] = useState(false)
  const [rowsError, setRowsError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSize] = useState<PageSizeOption>(() => readStoredPageSize())
  const [hasMore, setHasMore] = useState(false)
  const [totalRowCount, setTotalRowCount] = useState<number | null>(null)
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
  const selectAllCheckboxRef = useRef<HTMLInputElement | null>(null)

  /** Map: selection key → PK column snapshot (null if table has no PK). */
  const [rowSelection, setRowSelection] = useState<
    Map<string, Record<string, unknown> | null>
  >(() => new Map())
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const [appliedFilters, setAppliedFilters] = useState<PgRowFilter[]>([])
  const [appliedGlobalSearch, setAppliedGlobalSearch] = useState('')
  const [globalSearchDraft, setGlobalSearchDraft] = useState('')
  const [advOpen, setAdvOpen] = useState(false)
  const [draftFilters, setDraftFilters] = useState<PgRowFilter[]>([])
  const [filterHint, setFilterHint] = useState<string | null>(null)
  const [refreshBusy, setRefreshBusy] = useState(false)

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
    async (schema: string, options?: { preserveTable?: string | null }): Promise<string | null> => {
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
          return null
        }
        const list = data.tables ?? []
        setTables(list)
        const keep = options?.preserveTable
        if (keep != null && keep !== '') {
          const next = list.some((t) => t.name === keep) ? keep : null
          setSelectedTable(next)
          return next
        }
        setSelectedTable(null)
        return null
      } catch (e) {
        setTablesError(e instanceof Error ? e.message : 'Request failed.')
        setTables([])
        setSelectedTable(null)
        return null
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

  useEffect(() => {
    setTableListSearch('')
  }, [selectedSchema])

  const displayTables = useMemo(() => {
    const q = tableListSearch.trim().toLowerCase()
    if (!q) return tables
    const matched = tables.filter((t) => t.name.toLowerCase().includes(q))
    if (!selectedTable) return matched
    const selectedRow = tables.find((t) => t.name === selectedTable)
    if (selectedRow && !matched.some((t) => t.name === selectedTable)) {
      return [selectedRow, ...matched]
    }
    return matched
  }, [tables, tableListSearch, selectedTable])

  const loadRows = useCallback(
    async (schema: string, table: string, off: number) => {
      const filters = appliedFilters
      const globalSearch = appliedGlobalSearch
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
            filters: filters.map((f) =>
              f.op === 'IS_NULL' || f.op === 'IS_NOT_NULL'
                ? { column: f.column, op: f.op }
                : { column: f.column, op: f.op, value: f.value },
            ),
            globalSearch: globalSearch.trim() || undefined,
          }),
        })
        const data = (await res.json()) as {
          ok?: boolean
          columns?: string[]
          rows?: Record<string, unknown>[]
          hasMore?: boolean
          totalCount?: number
          error?: string
          tableType?: string | null
          primaryKeyColumns?: string[]
        }
        if (!data.ok) {
          setRowsError(data.error || 'Failed to load rows.')
          setColumns([])
          setRows([])
          setHasMore(false)
          setTotalRowCount(null)
          setTableType(null)
          setPrimaryKeyColumns([])
          return
        }
        setColumns(data.columns ?? [])
        setRows(data.rows ?? [])
        setHasMore(Boolean(data.hasMore))
        const tc = data.totalCount
        setTotalRowCount(
          typeof tc === 'number' && Number.isFinite(tc) ? Math.max(0, Math.floor(tc)) : 0,
        )
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
        setTotalRowCount(null)
        setTableType(null)
        setPrimaryKeyColumns([])
      } finally {
        setRowsLoading(false)
      }
    },
    [base, pageSize, appliedFilters, appliedGlobalSearch],
  )

  useEffect(() => {
    setAppliedFilters([])
    setAppliedGlobalSearch('')
    setGlobalSearchDraft('')
    setDraftFilters([])
    setAdvOpen(false)
    setFilterHint(null)
  }, [connection.id, selectedSchema, selectedTable])

  useEffect(() => {
    if (!selectedSchema || !selectedTable) {
      setColumns([])
      setRows([])
      setOffset(0)
      setHasMore(false)
      setTotalRowCount(null)
      setTableType(null)
      setPrimaryKeyColumns([])
      return
    }
    setTotalRowCount(null)
    void loadRows(selectedSchema, selectedTable, 0)
  }, [selectedSchema, selectedTable, pageSize, appliedFilters, appliedGlobalSearch, loadRows])

  useEffect(() => {
    setEditing(null)
    setEditDraft('')
    setEditMultiline(false)
    setCellSaveError(null)
  }, [selectedSchema, selectedTable, connection.id])

  useEffect(() => {
    setRowSelection(new Map())
    setDeleteError(null)
  }, [connection.id, selectedSchema, selectedTable])

  const pageRowKeys = useMemo(
    () =>
      rows.map((row, ri) => rowSelectionKey(row, primaryKeyColumns, ri, offset)),
    [rows, primaryKeyColumns, offset],
  )

  const selectedOnPageCount = useMemo(
    () => pageRowKeys.filter((k) => rowSelection.has(k)).length,
    [pageRowKeys, rowSelection],
  )

  const deletablePrimaryKeyRows = useMemo(() => {
    const list: Record<string, unknown>[] = []
    for (const pk of rowSelection.values()) {
      if (pk != null) list.push(pk)
    }
    return dedupePrimaryKeyRows(list, primaryKeyColumns)
  }, [rowSelection, primaryKeyColumns])

  const allOnPageSelected = rows.length > 0 && selectedOnPageCount === rows.length
  const someOnPageSelected = selectedOnPageCount > 0 && !allOnPageSelected

  useEffect(() => {
    const el = selectAllCheckboxRef.current
    if (el) el.indeterminate = someOnPageSelected
  }, [someOnPageSelected, rows.length])

  const toggleRowSelected = useCallback(
    (key: string, row: Record<string, unknown>) => {
      setRowSelection((prev) => {
        const next = new Map(prev)
        if (next.has(key)) next.delete(key)
        else next.set(key, primaryKeySnapshot(row, primaryKeyColumns))
        return next
      })
    },
    [primaryKeyColumns],
  )

  const toggleSelectAllOnPage = useCallback(() => {
    setRowSelection((prev) => {
      const next = new Map(prev)
      const allSelected = rows.length > 0 && pageRowKeys.every((k) => next.has(k))
      if (allSelected) {
        for (const k of pageRowKeys) next.delete(k)
      } else {
        rows.forEach((row, ri) => {
          const k = pageRowKeys[ri]
          if (k != null) next.set(k, primaryKeySnapshot(row, primaryKeyColumns))
        })
      }
      return next
    })
  }, [rows, pageRowKeys, primaryKeyColumns])

  const clearRowSelection = useCallback(() => {
    setRowSelection(new Map())
    setDeleteError(null)
  }, [])

  const canEditTable = tableType === 'BASE TABLE' && primaryKeyColumns.length > 0

  const deleteSelectedRows = useCallback(async () => {
    if (!selectedSchema || !selectedTable || deleteBusy || !canEditTable) return
    const toDelete = deletablePrimaryKeyRows
    if (toDelete.length === 0) return
    setDeleteError(null)
    if (
      !window.confirm(
        `Delete ${toDelete.length} row${toDelete.length === 1 ? '' : 's'} from "${selectedTable}"? This cannot be undone.`,
      )
    ) {
      return
    }
    setDeleteBusy(true)
    try {
      const res = await fetch('/api/db/postgres/delete-rows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...base,
          schema: selectedSchema,
          table: selectedTable,
          primaryKeys: toDelete,
        }),
      })
      const data = (await res.json()) as {
        ok?: boolean
        deleted?: number
        error?: string
      }
      if (!data.ok) {
        const msg = data.error || 'Delete failed.'
        setDeleteError(msg)
        toast.error('Delete failed', { description: msg })
        return
      }
      const deleted = typeof data.deleted === 'number' ? data.deleted : 0
      if (deleted < toDelete.length) {
        const partial = `Only ${deleted} of ${toDelete.length} row${toDelete.length === 1 ? '' : 's'} were removed (others may already be gone).`
        setDeleteError(partial)
        toast.warning('Partial delete', { description: partial })
      } else {
        toast.success(
          `Deleted ${deleted} row${deleted === 1 ? '' : 's'}`,
          { description: `${selectedSchema}.${selectedTable}` },
        )
      }
      setRowSelection(new Map())
      await loadRows(selectedSchema, selectedTable, offset)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Request failed.'
      setDeleteError(msg)
      toast.error('Delete failed', { description: msg })
    } finally {
      setDeleteBusy(false)
    }
  }, [
    base,
    selectedSchema,
    selectedTable,
    deleteBusy,
    deletablePrimaryKeyRows,
    loadRows,
    offset,
    canEditTable,
  ])

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
        const msg = data.error || 'Update failed.'
        setCellSaveError(msg)
        toast.error('Update failed', { description: msg })
        return
      }
      cancelCellEdit()
      toast.success('Cell updated', { description: editing.column })
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

  const pageNumber = Math.floor(offset / pageSize) + 1
  const rowStart = rows.length === 0 ? 0 : offset + 1
  const rowEnd = offset + rows.length
  const totalPages =
    totalRowCount != null ? Math.max(1, Math.ceil(totalRowCount / pageSize)) : null
  const lastPageOffset =
    totalRowCount != null && totalRowCount > 0
      ? Math.min(PG_BROWSER_MAX_OFFSET, (Math.max(1, Math.ceil(totalRowCount / pageSize)) - 1) * pageSize)
      : 0
  const paginationNextDisabled =
    rowsLoading ||
    cellSaving ||
    (totalRowCount != null
      ? totalRowCount === 0 || offset + pageSize >= totalRowCount
      : !hasMore)
  const paginationLastDisabled =
    rowsLoading ||
    cellSaving ||
    totalRowCount == null ||
    totalRowCount === 0 ||
    offset >= lastPageOffset

  useEffect(() => {
    if (!editing) return
    const el = editMultiline ? cellTextareaRef.current : cellInputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [editing, editMultiline])

  const openAdvancedPanel = useCallback(() => {
    setFilterHint(null)
    setAdvOpen(true)
    setDraftFilters(
      appliedFilters.length > 0
        ? appliedFilters.map((f) => ({ ...f }))
        : [{ column: columns[0] ?? '', op: 'ILIKE', value: '' }],
    )
  }, [appliedFilters, columns])

  const applyGlobalSearch = useCallback(() => {
    setFilterHint(null)
    setAppliedGlobalSearch(globalSearchDraft.trim())
  }, [globalSearchDraft])

  const clearAllFilters = useCallback(() => {
    setFilterHint(null)
    setAppliedFilters([])
    setAppliedGlobalSearch('')
    setGlobalSearchDraft('')
    setDraftFilters([])
    setAdvOpen(false)
  }, [])

  const applyAdvancedFilters = useCallback(() => {
    if (columns.length === 0) {
      setFilterHint('Load the table first, then add filters.')
      return
    }
    const next: PgRowFilter[] = []
    for (const row of draftFilters) {
      const col = row.column.trim()
      if (!col || !columns.includes(col)) continue
      if (
        pgRowFilterNeedsValue(row.op) &&
        row.value === '' &&
        row.op !== '=' &&
        row.op !== '!=' &&
        row.op !== 'LIKE' &&
        row.op !== 'ILIKE'
      ) {
        setFilterHint(`Enter a value for “${col}” (${row.op}), or remove that row.`)
        return
      }
      next.push({
        column: col,
        op: row.op,
        value: row.value,
      })
    }
    setFilterHint(null)
    setAppliedFilters(next)
    setAdvOpen(false)
  }, [columns, draftFilters])

  const refreshCurrentRows = useCallback(() => {
    if (!selectedSchema || !selectedTable) return
    void loadRows(selectedSchema, selectedTable, offset)
  }, [loadRows, offset, selectedSchema, selectedTable])

  const reloadAll = useCallback(async () => {
    if (refreshBusy) return
    setRefreshBusy(true)
    setFilterHint(null)
    try {
      await loadSchemas()
      const schema = selectedSchema
      const table = selectedTable
      if (!schema) return
      const kept = await loadTables(schema, { preserveTable: table })
      if (kept) {
        void loadRows(schema, kept, 0)
      }
    } finally {
      setRefreshBusy(false)
    }
  }, [loadSchemas, loadTables, loadRows, refreshBusy, selectedSchema, selectedTable])

  const hasActiveFilters = appliedFilters.length > 0 || appliedGlobalSearch.length > 0

  return (
    <section className="panel postgres-data-browser-page db-browser" aria-label="PostgreSQL data browser">
      <h2 className="visually-hidden">PostgreSQL — {connection.name}</h2>
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
              {schemasError ? (
                <div className="postgres-data-browser__schema-row postgres-data-browser__schema-row--trailing">
                  <button
                    type="button"
                    className="btn btn--ghost btn--xs postgres-data-browser__schema-reload-btn"
                    title="Reload schemas, table list, and data from page 1"
                    aria-label="Reload all"
                    disabled={refreshBusy || schemasLoading || tablesLoading}
                    onClick={() => void reloadAll()}
                  >
                    <PostgresReloadAllGlyph className="postgres-data-browser__schema-reload-svg" />
                  </button>
                </div>
              ) : null}
              {schemasLoading ? (
                <div className="db-browser__section-loading" role="status">
                  <span className="db-browser__spinner" aria-hidden />
                  Loading schemas…
                </div>
              ) : schemas.length === 0 ? (
                <>
                  <p className="postgres-data-browser__muted">No schemas available.</p>
                  <div className="postgres-data-browser__schema-row postgres-data-browser__schema-row--trailing">
                    <button
                      type="button"
                      className="btn btn--ghost btn--xs postgres-data-browser__schema-reload-btn"
                      title="Reload schemas, table list, and data from page 1"
                      aria-label="Reload all"
                      disabled={refreshBusy || schemasLoading || tablesLoading}
                      onClick={() => void reloadAll()}
                    >
                      <PostgresReloadAllGlyph className="postgres-data-browser__schema-reload-svg" />
                    </button>
                  </div>
                </>
              ) : (
                <div className="postgres-data-browser__schema-row">
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
                  <button
                    type="button"
                    className="btn btn--ghost btn--xs postgres-data-browser__schema-reload-btn"
                    title="Reload schemas, table list, and data from page 1"
                    aria-label="Reload all"
                    disabled={refreshBusy || schemasLoading || tablesLoading}
                    onClick={() => void reloadAll()}
                  >
                    <PostgresReloadAllGlyph className="postgres-data-browser__schema-reload-svg" />
                  </button>
                </div>
              )}
            </div>
            <div className="postgres-data-browser__section postgres-data-browser__section--tables">
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
                <>
                  <div className="postgres-data-browser__table-search">
                    <input
                      id="pg-table-filter"
                      type="search"
                      className="postgres-data-browser__table-search-input"
                      placeholder="Search by name…"
                      value={tableListSearch}
                      onChange={(e) => setTableListSearch(e.target.value)}
                      aria-label="Filter tables and views by name"
                    />
                  </div>
                  {displayTables.length === 0 ? (
                    <p className="postgres-data-browser__muted">No tables match this filter.</p>
                  ) : (
                    <ul className="postgres-data-browser__mini-list" aria-label="Tables">
                      {displayTables.map((t) => (
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
                </>
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
                <div className="postgres-data-browser__grid-toolbar db-browser__data-toolbar postgres-data-browser__grid-toolbar--stacked">
                  <div className="postgres-pgbar" role="toolbar" aria-label="Table pagination">
                    <div className="postgres-pgbar__left">
                      <div className="postgres-pgbar__title-row">
                        <button
                          type="button"
                          className="postgres-pgbar__icon-btn"
                          title="Refresh this page"
                          aria-label="Refresh current page"
                          disabled={rowsLoading || cellSaving || refreshBusy}
                          onClick={refreshCurrentRows}
                        >
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden
                          >
                            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                            <path d="M3 3v5h5" />
                            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                            <path d="M16 21h5v-5" />
                          </svg>
                        </button>
                        {selectedSchema && selectedTable ? (
                          <span
                            className="postgres-pgbar__table-id"
                            title={`${selectedSchema}.${selectedTable}`}
                          >
                            {selectedSchema}.{selectedTable}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="postgres-pgbar__right">
                      <div className="postgres-pgbar__meta" aria-live="polite">
                        <span className="postgres-pgbar__total">
                          {rowsLoading && totalRowCount === null ? (
                            <span className="postgres-pgbar__muted">…</span>
                          ) : totalRowCount != null ? (
                            <>{totalRowCount.toLocaleString()} rows</>
                          ) : (
                            <span className="postgres-pgbar__muted">—</span>
                          )}
                          {rowsLoading && totalRowCount !== null ? (
                            <span className="db-browser__spinner db-browser__spinner--inline postgres-pgbar__spin" aria-hidden />
                          ) : null}
                        </span>
                        <span className="postgres-pgbar__range">
                          {rows.length > 0 ? (
                            <>
                              {rowStart.toLocaleString()}–{rowEnd.toLocaleString()}
                            </>
                          ) : !rowsLoading ? (
                            <span className="postgres-pgbar__muted">No rows</span>
                          ) : null}
                        </span>
                        <span className="postgres-pgbar__page">
                          Page <strong>{pageNumber}</strong>
                          {totalPages != null ? (
                            <>
                              {' '}
                              / <strong>{totalPages}</strong>
                            </>
                          ) : null}
                        </span>
                      </div>
                      <label className="postgres-pgbar__perpage">
                        <span className="postgres-pgbar__perpage-label">Per page</span>
                        <select
                          id="pg-rows-per-page"
                          className="postgres-pgbar__select"
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
                      </label>
                      <div className="postgres-pgbar__nav" role="group" aria-label="Page navigation">
                        <button
                          type="button"
                          className="postgres-pgbar__nav-btn"
                          title="First page"
                          aria-label="First page"
                          disabled={rowsLoading || cellSaving || offset === 0}
                          onClick={() => {
                            if (!selectedSchema || !selectedTable) return
                            void loadRows(selectedSchema, selectedTable, 0)
                          }}
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="m11 17-5-5 5-5" />
                            <path d="m18 17-5-5 5-5" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="postgres-pgbar__nav-btn"
                          title="Previous page"
                          aria-label="Previous page"
                          disabled={rowsLoading || cellSaving || offset === 0}
                          onClick={() => {
                            if (!selectedSchema || !selectedTable) return
                            void loadRows(selectedSchema, selectedTable, Math.max(0, offset - pageSize))
                          }}
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="m15 18-6-6 6-6" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="postgres-pgbar__nav-btn"
                          title="Next page"
                          aria-label="Next page"
                          disabled={paginationNextDisabled}
                          onClick={() => {
                            if (!selectedSchema || !selectedTable) return
                            void loadRows(selectedSchema, selectedTable, offset + pageSize)
                          }}
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="m9 18 6-6-6-6" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="postgres-pgbar__nav-btn"
                          title="Last page"
                          aria-label="Last page"
                          disabled={paginationLastDisabled}
                          onClick={() => {
                            if (!selectedSchema || !selectedTable) return
                            void loadRows(selectedSchema, selectedTable, lastPageOffset)
                          }}
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="m6 17 5-5-5-5" />
                            <path d="m13 17 5-5-5-5" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="postgres-data-browser__toolbar-row postgres-data-browser__toolbar-row--search" role="search">
                    <input
                      id="pg-global-search"
                      type="search"
                      className="postgres-data-browser__search-input"
                      placeholder="Text in any column…"
                      value={globalSearchDraft}
                      disabled={rowsLoading || cellSaving || refreshBusy}
                      onChange={(e) => setGlobalSearchDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') applyGlobalSearch()
                      }}
                      aria-label="Search across all columns"
                    />
                    <button
                      type="button"
                      className="btn btn--primary btn--xs postgres-data-browser__icon-btn"
                      title="Apply search"
                      aria-label="Apply search"
                      disabled={rowsLoading || cellSaving || refreshBusy}
                      onClick={applyGlobalSearch}
                    >
                      <svg
                        className="postgres-data-browser__icon-btn-svg"
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className={`btn btn--ghost btn--xs postgres-data-browser__icon-btn${advOpen ? ' postgres-data-browser__icon-btn--adv-open' : ''}`}
                      title={
                        appliedFilters.length > 0
                          ? `Advanced filters (${appliedFilters.length} condition${appliedFilters.length === 1 ? '' : 's'})`
                          : 'Advanced filters'
                      }
                      aria-label={
                        appliedFilters.length > 0
                          ? `Advanced filters, ${appliedFilters.length} condition${appliedFilters.length === 1 ? '' : 's'}`
                          : 'Advanced filters'
                      }
                      disabled={columns.length === 0}
                      onClick={() => {
                        if (advOpen) {
                          setAdvOpen(false)
                          setFilterHint(null)
                        } else {
                          openAdvancedPanel()
                        }
                      }}
                    >
                      <svg
                        className="postgres-data-browser__icon-btn-svg"
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
                      </svg>
                      {appliedFilters.length > 0 ? (
                        <span className="postgres-data-browser__icon-btn-badge" aria-hidden>
                          {appliedFilters.length}
                        </span>
                      ) : null}
                    </button>
                    {hasActiveFilters ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--xs postgres-data-browser__icon-btn"
                        title="Clear all filters"
                        aria-label="Clear all filters"
                        disabled={rowsLoading || cellSaving || refreshBusy}
                        onClick={clearAllFilters}
                      >
                        <svg
                          className="postgres-data-browser__icon-btn-svg"
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden
                        >
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    ) : null}
                  </div>
                  {advOpen ? (
                    <div className="postgres-data-browser__adv-panel">
                      <p className="postgres-data-browser__adv-help">
                        Conditions are combined with <strong>AND</strong>. Use <code className="host-editor__inline-code">%</code> in LIKE / ILIKE as a wildcard.
                      </p>
                      {draftFilters.map((row, idx) => (
                        <div key={idx} className="postgres-data-browser__adv-row">
                          <select
                            className="postgres-data-browser__adv-select"
                            aria-label={`Filter ${idx + 1} column`}
                            value={
                              columns.includes(row.column) ? row.column : (columns[0] ?? '')
                            }
                            onChange={(e) => {
                              const v = e.target.value
                              setDraftFilters((prev) =>
                                prev.map((p, j) => (j === idx ? { ...p, column: v } : p)),
                              )
                            }}
                          >
                            {columns.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                          <select
                            className="postgres-data-browser__adv-select"
                            aria-label={`Filter ${idx + 1} operator`}
                            value={row.op}
                            onChange={(e) => {
                              const v = e.target.value as PgFilterOp
                              setDraftFilters((prev) =>
                                prev.map((p, j) => (j === idx ? { ...p, op: v } : p)),
                              )
                            }}
                          >
                            {PG_FILTER_OPS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                          <input
                            type="text"
                            className="postgres-data-browser__adv-value"
                            placeholder={
                              pgRowFilterNeedsValue(row.op) ? 'Value' : '(not used)'
                            }
                            disabled={!pgRowFilterNeedsValue(row.op)}
                            value={row.value}
                            onChange={(e) => {
                              const v = e.target.value
                              setDraftFilters((prev) =>
                                prev.map((p, j) => (j === idx ? { ...p, value: v } : p)),
                              )
                            }}
                            aria-label={`Filter ${idx + 1} value`}
                          />
                          <button
                            type="button"
                            className="btn btn--ghost btn--xs postgres-data-browser__adv-remove"
                            aria-label={`Remove filter row ${idx + 1}`}
                            onClick={() => {
                              setDraftFilters((prev) =>
                                prev.length <= 1
                                  ? [{ column: columns[0] ?? '', op: 'ILIKE', value: '' }]
                                  : prev.filter((_, j) => j !== idx),
                              )
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                      <div className="postgres-data-browser__adv-footer">
                        <button
                          type="button"
                          className="btn btn--ghost btn--xs"
                          onClick={() => {
                            setDraftFilters((prev) => [
                              ...prev,
                              { column: columns[0] ?? '', op: '=', value: '' },
                            ])
                          }}
                        >
                          Add condition
                        </button>
                        <div className="postgres-data-browser__adv-apply-group">
                          <button
                            type="button"
                            className="btn btn--primary btn--xs"
                            disabled={rowsLoading || cellSaving || refreshBusy}
                            onClick={applyAdvancedFilters}
                          >
                            Apply filters
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--xs"
                            onClick={() => {
                              setAdvOpen(false)
                              setFilterHint(null)
                            }}
                          >
                            Close
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {filterHint ? (
                    <div className="host-editor__banner host-editor__banner--err postgres-data-browser__filter-hint">
                      {filterHint}
                    </div>
                  ) : null}
                  {hasActiveFilters && !filterHint ? (
                    <p className="postgres-data-browser__filter-summary">
                      {appliedGlobalSearch ? (
                        <>
                          Matching <strong>{appliedGlobalSearch}</strong> in any column
                          {appliedFilters.length > 0 ? '; ' : '.'}
                        </>
                      ) : null}
                      {appliedFilters.length > 0 ? (
                        <>
                          {appliedFilters.length} advanced condition
                          {appliedFilters.length === 1 ? '' : 's'}.
                        </>
                      ) : null}
                    </p>
                  ) : null}
                </div>
                {rowSelection.size > 0 ? (
                  <div className="postgres-data-browser__selection-bar" role="status" aria-live="polite">
                    <span className="postgres-data-browser__selection-bar-text">
                      {rowSelection.size} row{rowSelection.size === 1 ? '' : 's'} selected
                    </span>
                    <div className="postgres-data-browser__selection-bar-actions">
                      <button
                        type="button"
                        className="btn btn--danger btn--xs postgres-data-browser__selection-icon-btn"
                        title={
                          !canEditTable
                            ? 'Delete is only available for base tables with a primary key'
                            : deletablePrimaryKeyRows.length === 0
                              ? 'Selected rows have no primary key to delete by'
                              : `Delete ${deletablePrimaryKeyRows.length} row${deletablePrimaryKeyRows.length === 1 ? '' : 's'}`
                        }
                        aria-label={
                          deletablePrimaryKeyRows.length > 0
                            ? `Delete ${deletablePrimaryKeyRows.length} selected row${deletablePrimaryKeyRows.length === 1 ? '' : 's'}`
                            : 'Delete selected rows (unavailable)'
                        }
                        disabled={
                          deleteBusy ||
                          rowsLoading ||
                          cellSaving ||
                          refreshBusy ||
                          !canEditTable ||
                          deletablePrimaryKeyRows.length === 0
                        }
                        onClick={() => void deleteSelectedRows()}
                      >
                        <svg
                          className="postgres-data-browser__selection-icon-btn-svg"
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden
                        >
                          <path d="M3 6h18" />
                          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                          <line x1="10" x2="10" y1="11" y2="17" />
                          <line x1="14" x2="14" y1="11" y2="17" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--xs"
                        onClick={clearRowSelection}
                      >
                        Clear selection
                      </button>
                    </div>
                  </div>
                ) : null}
                {deleteError ? (
                  <div className="host-editor__banner host-editor__banner--err postgres-data-browser__delete-banner">
                    <span className="postgres-data-browser__delete-banner-text">{deleteError}</span>
                    <button
                      type="button"
                      className="btn btn--ghost btn--xs"
                      onClick={() => setDeleteError(null)}
                    >
                      Dismiss
                    </button>
                  </div>
                ) : null}
                {cellSaveError ? (
                  <div className="host-editor__banner host-editor__banner--err postgres-data-browser__cell-banner">
                    {cellSaveError}
                  </div>
                ) : null}
                <div className="table-wrap postgres-data-browser__table-wrap">
                  <table className="data-table postgres-data-browser__data-table">
                    <thead>
                      <tr>
                        <th
                          scope="col"
                          className="postgres-data-browser__th--select"
                          aria-label="Select rows on this page"
                        >
                          <input
                            ref={selectAllCheckboxRef}
                            type="checkbox"
                            className="postgres-data-browser__row-checkbox"
                            checked={allOnPageSelected}
                            disabled={rows.length === 0 || rowsLoading || cellSaving || deleteBusy}
                            onChange={() => toggleSelectAllOnPage()}
                            title={allOnPageSelected ? 'Deselect all on this page' : 'Select all on this page'}
                            aria-label={
                              allOnPageSelected ? 'Deselect all rows on this page' : 'Select all rows on this page'
                            }
                          />
                        </th>
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
                      {rows.map((row, ri) => {
                        const selKey = rowSelectionKey(row, primaryKeyColumns, ri, offset)
                        const isRowSelected = rowSelection.has(selKey)
                        return (
                        <tr
                          key={stableRowKey(row, primaryKeyColumns, ri)}
                          className={isRowSelected ? 'postgres-data-browser__tr--selected' : undefined}
                          aria-selected={isRowSelected}
                        >
                          <td className="postgres-data-browser__select-cell">
                            <input
                              type="checkbox"
                              className="postgres-data-browser__row-checkbox"
                              checked={isRowSelected}
                              disabled={rowsLoading || cellSaving || deleteBusy}
                              onChange={() => toggleRowSelected(selKey, row)}
                              aria-label={`Select row ${offset + ri + 1}`}
                            />
                          </td>
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
                        )
                      })}
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

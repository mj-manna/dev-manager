import { useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalJob, TerminalJobStatus } from '../terminal/TerminalContext'
import { useTerminal } from '../terminal/TerminalContext'

function statusLabel(s: TerminalJobStatus): string {
  switch (s) {
    case 'running':
      return 'Running'
    case 'success':
      return 'Success'
    case 'failed':
      return 'Failed'
    case 'stopped':
      return 'Stopped'
    default:
      return s
  }
}

function statusClass(s: TerminalJobStatus): string {
  switch (s) {
    case 'running':
      return 'admin__job-status admin__job-status--running'
    case 'success':
      return 'admin__job-status admin__job-status--success'
    case 'failed':
      return 'admin__job-status admin__job-status--failed'
    case 'stopped':
      return 'admin__job-status admin__job-status--stopped'
    default:
      return 'admin__job-status'
  }
}

function formatShortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function JobRow({
  job,
  tabAlive,
  onActivate,
}: {
  job: TerminalJob
  tabAlive: boolean
  onActivate: () => void
}) {
  const inner = (
    <>
      <div className="admin__job-row-top">
        <span className={statusClass(job.status)}>
          {job.status === 'running' ? <span className="admin__job-spinner" aria-hidden /> : null}
          {statusLabel(job.status)}
        </span>
        <span className="admin__job-kind">{job.category === 'run' ? 'Run' : 'Task'}</span>
      </div>
      <span className="admin__job-row-title">{job.label}</span>
      {job.detail ? <span className="admin__job-row-detail">{job.detail}</span> : null}
      <span className="admin__job-row-time">{formatShortTime(job.startedAt)}</span>
    </>
  )

  if (tabAlive) {
    return (
      <button
        type="button"
        className="admin__job-row admin__job-row--clickable"
        title="Open in terminal"
        aria-label={`Open terminal: ${job.label}`}
        onClick={onActivate}
      >
        {inner}
      </button>
    )
  }

  return <div className="admin__job-row admin__job-row--static">{inner}</div>
}

export function HeaderJobsMenu() {
  const { terminalJobs, focusTerminalTab, tabs } = useTerminal()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const runningCount = useMemo(() => terminalJobs.filter((j) => j.status === 'running').length, [terminalJobs])

  const sortedJobs = useMemo(
    () => [...terminalJobs].sort((a, b) => b.startedAt - a.startedAt),
    [terminalJobs],
  )

  const tabIdSet = useMemo(() => new Set(tabs.map((t) => t.id)), [tabs])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="admin__jobs-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`admin__icon-btn${runningCount ? ' admin__icon-btn--pulse' : ''}`}
        aria-label="Jobs"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Terminal jobs"
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M9 11V6a3 3 0 0 1 6 0v5" />
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M9 16h.01M15 16h.01" strokeLinecap="round" />
        </svg>
        {runningCount > 0 ? (
          <span className="admin__jobs-badge" aria-hidden>
            {runningCount > 9 ? '9+' : runningCount}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="admin__jobs-popover" role="dialog" aria-label="Jobs">
          {terminalJobs.length === 0 ? (
            <p className="admin__jobs-empty">No jobs yet. Start a project or run a script from Projects.</p>
          ) : (
            <div className="admin__jobs-list">
              {sortedJobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  tabAlive={tabIdSet.has(job.tabId)}
                  onActivate={() => {
                    focusTerminalTab(job.tabId)
                    setOpen(false)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { TERMINAL_WS_PATH } from './constants'
import type { TerminalExitPayload, TerminalTab } from './TerminalContext'
import { useTerminal } from './TerminalContext'
import { proTerminalFont, proTerminalTheme, proTermPromptArrow } from './xtermProTheme'
import '@xterm/xterm/css/xterm.css'

function escapeBashSingleQuotedSegment(s: string): string {
  return s.replace(/'/g, `'\\''`)
}

/**
 * Bash `cd` word: keep `~` outside quotes so the shell expands it (a fully quoted path does not).
 */
function bashCdWordForPath(dir: string): string {
  const esc = escapeBashSingleQuotedSegment
  const sq = (s: string) => `'${esc(s)}'`
  if (dir === '~') return '~'
  if (dir.startsWith('~/')) {
    const tail = dir.slice(2)
    return tail ? `~/${sq(tail)}` : '~/'
  }
  const namedRest = dir.match(/^~([a-zA-Z0-9._-]+)\/(.+)$/)
  if (namedRest) return `~${namedRest[1]}/${sq(namedRest[2])}`
  const namedOnly = dir.match(/^~([a-zA-Z0-9._-]+)$/)
  if (namedOnly) return `~${namedOnly[1]}`
  return sq(dir)
}

/**
 * Run `command` after `cd` into `cwd` so dev tasks always execute in the project folder
 * (spawn cwd can be ignored by login shells or invalid paths on the server).
 */
export function wrapTerminalCommandWithCd(cwd: string, command: string): string {
  const dir = cwd.trim()
  if (!dir) return command
  return `cd ${bashCdWordForPath(dir)} && ${command}`
}

function TerminalTabSession({
  tab,
  isActive,
  drawerOpen,
  onClearPending,
  setLastReadyBanner,
  reportShellExit,
}: {
  tab: TerminalTab
  isActive: boolean
  /** When the drawer is expanded, refit xterm to the visible viewport. */
  drawerOpen: boolean
  onClearPending: () => void
  setLastReadyBanner: (msg: string | null) => void
  reportShellExit: (p: TerminalExitPayload, tabId?: string) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [shellReady, setShellReady] = useState(false)
  /** After `ready` control message; used to detect disconnect vs client-initiated close. */
  const sessionRef = useRef<'connecting' | 'ready' | 'dead'>('connecting')
  const intentionalCloseRef = useRef(false)

  const injectRun = useCallback(
    (ws: WebSocket, term: Terminal, cmd: string) => {
      const line = wrapTerminalCommandWithCd(tab.cwd, cmd)
      term.writeln(
        `\r\n${proTermPromptArrow} \x1b[38;2;47;249;255m\x1b[1m${line.replace(/\r?\n/g, ' ')}\x1b[0m\r\n`,
      )
      ws.send(JSON.stringify({ type: 'run', command: line }))
      onClearPending()
    },
    [onClearPending, tab.cwd],
  )

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return

    setShellReady(false)

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 3,
      fontSize: 14,
      lineHeight: 1.25,
      fontFamily: proTerminalFont,
      fontWeight: '400',
      fontWeightBold: '600',
      letterSpacing: 0.2,
      drawBoldTextInBrightColors: true,
      scrollback: 8000,
      theme: proTerminalTheme,
    })
    termRef.current = term
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.open(el)
    fit.fit()

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const cwdQ = tab.cwd.trim() ? `?cwd=${encodeURIComponent(tab.cwd.trim())}` : ''
    const ws = new WebSocket(`${protocol}//${window.location.host}${TERMINAL_WS_PATH}${cwdQ}`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    sessionRef.current = 'connecting'
    intentionalCloseRef.current = false

    const sendResize = () => {
      const f = fitRef.current
      const w = wsRef.current
      if (!f || !w) return
      f.fit()
      const dims = f.proposeDimensions()
      if (dims && w.readyState === WebSocket.OPEN) {
        w.send(
          JSON.stringify({
            type: 'resize',
            cols: dims.cols,
            rows: dims.rows,
          }),
        )
      }
    }

    const fallbackTimer = window.setTimeout(() => {
      sendResize()
    }, 500)

    ws.onopen = () => {
      sendResize()
    }

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const j = JSON.parse(ev.data) as {
            type?: string
            message?: string
            exitCode?: number | null
            signal?: number | null
            backend?: string
          }
          if (j.type === 'error' && j.message) {
            term.writeln(
              `\r\n\x1b[38;2;255;59;107m\x1b[1m✖\x1b[0m \x1b[38;2;255;47;227m[terminal]\x1b[0m \x1b[38;2;255;230;0m${j.message}\x1b[0m\r\n`,
            )
            return
          }
          if (j.type === 'ready') {
            if (j.backend === 'pipe' && j.message) setLastReadyBanner(j.message)
            else setLastReadyBanner(null)
            sessionRef.current = 'ready'
            setShellReady(true)
            sendResize()
            return
          }
          if (j.type === 'exit') {
            sessionRef.current = 'dead'
            reportShellExit(
              {
                exitCode: j.exitCode ?? null,
                signal: j.signal ?? null,
              },
              tab.id,
            )
            return
          }
        } catch {
          term.write(ev.data)
        }
        return
      }
      if (ev.data instanceof ArrayBuffer) {
        term.write(new TextDecoder().decode(ev.data))
      }
    }

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })

    const ro = new ResizeObserver(() => {
      sendResize()
    })
    ro.observe(el)

    ws.onclose = () => {
      if (intentionalCloseRef.current) return
      if (sessionRef.current === 'ready') {
        sessionRef.current = 'dead'
        term.writeln('\r\n\x1b[38;2;251;191;36m[terminal]\x1b[0m Session closed (connection lost).\r\n')
        reportShellExit({ exitCode: null, signal: null }, tab.id)
      }
    }

    return () => {
      intentionalCloseRef.current = true
      window.clearTimeout(fallbackTimer)
      ro.disconnect()
      wsRef.current = null
      termRef.current = null
      fitRef.current = null
      ws.onclose = null
      ws.close()
      term.dispose()
    }
  }, [tab.id, tab.cwd, setLastReadyBanner, reportShellExit])

  useEffect(() => {
    if (!shellReady || !tab.pendingCommand) return
    const ws = wsRef.current
    const term = termRef.current
    if (!ws || !term || ws.readyState !== WebSocket.OPEN) return
    injectRun(ws, term, tab.pendingCommand)
  }, [shellReady, tab.pendingCommand, injectRun])

  useEffect(() => {
    if (!drawerOpen || !isActive || !shellReady) return
    const w = wsRef.current
    const f = fitRef.current
    if (!w || !f || w.readyState !== WebSocket.OPEN) return
    requestAnimationFrame(() => {
      f.fit()
      const dims = f.proposeDimensions()
      if (dims && w.readyState === WebSocket.OPEN) {
        w.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
      }
    })
  }, [drawerOpen, isActive, shellReady])

  return (
    <div
      ref={wrapRef}
      className={`app-terminal__xterm-layer${isActive ? ' app-terminal__xterm-layer--active' : ''}`}
      aria-hidden={!isActive}
    />
  )
}

export function TerminalPane() {
  const {
    open,
    heightPx,
    setHeightPx,
    hideTerminal,
    setLastReadyBanner,
    reportShellExit,
    lastExit,
    clearLastExit,
    lastReadyBanner,
    tabs,
    activeTabId,
    selectTerminalTab,
    removeTerminalTab,
    clearTabPendingCommand,
    addTerminalTab,
    ensureAtLeastOneTab,
  } = useTerminal()

  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  useEffect(() => {
    if (open && tabs.length === 0) ensureAtLeastOneTab()
  }, [open, tabs.length, ensureAtLeastOneTab])

  const onResizeMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault()
      dragRef.current = { startY: e.clientY, startH: heightPx }
      const onMove = (ev: MouseEvent) => {
        const d = dragRef.current
        if (!d) return
        const delta = d.startY - ev.clientY
        const next = Math.min(560, Math.max(160, d.startH + delta))
        setHeightPx(next)
      }
      const onUp = () => {
        dragRef.current = null
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [heightPx, setHeightPx],
  )

  if (tabs.length === 0) return null

  return (
    <>
      <div
        className={`app-terminal${open ? '' : ' app-terminal--background'}`}
        style={open ? { height: heightPx } : undefined}
        aria-hidden={!open}
      >
      <button
        type="button"
        className="app-terminal__resize-handle"
        aria-label="Resize terminal height"
        onMouseDown={onResizeMouseDown}
      />
      <div className="app-terminal__chrome">
        <span className="app-terminal__brand">
          <span className="app-terminal__live" title="WebSocket connected when open" aria-hidden />
          <span className="app-terminal__title">Integrated shell</span>
          <span className="app-terminal__chip">PTY</span>
        </span>
        {lastReadyBanner ? (
          <span className="app-terminal__warn" title={lastReadyBanner}>
            Limited mode — see tooltip
          </span>
        ) : null}
        {lastExit ? (
          <span className="app-terminal__exit">
            Exited: code {lastExit.exitCode ?? '—'}
            {lastExit.signal != null ? ` signal ${lastExit.signal}` : ''}
            <button type="button" className="app-terminal__dismiss" onClick={clearLastExit}>
              Dismiss
            </button>
          </span>
        ) : null}
        <div className="app-terminal__spacer" />
        <button
          type="button"
          className="btn btn--ghost btn--xs"
          onClick={hideTerminal}
          title="Hide panel — shell keeps running"
        >
          Hide
        </button>
      </div>

      <div className="app-terminal__tabs" role="tablist" aria-label="Terminal sessions">
        {tabs.map((tab) => (
          <div key={tab.id} className="app-terminal__tab-wrap">
            <button
              type="button"
              role="tab"
              className={`app-terminal__tab${tab.id === activeTabId ? ' app-terminal__tab--active' : ''}`}
              aria-selected={tab.id === activeTabId}
              onClick={() => selectTerminalTab(tab.id)}
            >
              <span className="app-terminal__tab-label">{tab.label}</span>
              {tab.cwd ? (
                <span className="app-terminal__tab-cwd" title={tab.cwd}>
                  {tab.cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop()}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              className="app-terminal__tab-close"
              aria-label={`Close ${tab.label}`}
              onClick={(e) => {
                e.stopPropagation()
                removeTerminalTab(tab.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="app-terminal__tab app-terminal__tab--add"
          aria-label="New shell tab"
          onClick={() => addTerminalTab({ label: 'Shell', cwd: '' })}
        >
          +
        </button>
      </div>

      <div className="app-terminal__xterm-stack">
        <div className="app-terminal__xterm-stack-inner">
          {tabs.map((tab) => (
            <TerminalTabSession
              key={`${tab.id}\0${tab.cwd}`}
              tab={tab}
              isActive={tab.id === activeTabId}
              drawerOpen={open}
              onClearPending={() => clearTabPendingCommand(tab.id)}
              setLastReadyBanner={setLastReadyBanner}
              reportShellExit={reportShellExit}
            />
          ))}
        </div>
      </div>
    </div>
    </>
  )
}

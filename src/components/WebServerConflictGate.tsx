import { useCallback, useState } from 'react'

type Props = {
  /** Server this panel is for (what the user opened). */
  targetName: string
  /** Installed server that must be removed first. */
  blockingName: string
  blockingDetail: string
  uninstallCommandUrl: string
  runInTerminal: (command: string, opts?: { cwd?: string; label?: string }) => void
  showTerminal: () => void
  onRefresh: () => void
}

/**
 * Shown when the *other* web server is still installed — Dev Manager allows managing only one stack at a time.
 */
export function WebServerConflictGate({
  targetName,
  blockingName,
  blockingDetail,
  uninstallCommandUrl,
  runInTerminal,
  showTerminal,
  onRefresh,
}: Props) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const runUninstall = useCallback(async () => {
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch(uninstallCommandUrl)
      const data = (await res.json()) as { command?: string; error?: string; hint?: string }
      if (!res.ok || !data.command) {
        setNote({ type: 'err', text: data.error || 'No uninstall command for this system.' })
        return
      }
      if (data.hint) {
        setNote({ type: 'ok', text: data.hint })
      }
      runInTerminal(data.command)
    } catch (e) {
      setNote({
        type: 'err',
        text: e instanceof Error ? e.message : 'Failed to load uninstall command',
      })
    } finally {
      setBusy(false)
    }
  }, [uninstallCommandUrl, runInTerminal])

  return (
    <section className="panel webserver-conflict" aria-labelledby="webserver-conflict-title">
      <div className="webserver-conflict__card">
        <div className="webserver-conflict__badge">One server at a time</div>
        <h2 id="webserver-conflict-title" className="webserver-conflict__title">
          {blockingName} is still installed
        </h2>
        <p className="webserver-conflict__lead">
          This workspace is set up to manage <strong>{targetName}</strong> or <strong>{blockingName}</strong>, not both.
          Uninstall <strong>{blockingName}</strong> first ({blockingDetail}), then you can install and edit{' '}
          <strong>{targetName}</strong> here.
        </p>
        {note ? (
          <div
            className={`webserver-conflict__note webserver-conflict__note--${note.type}`}
            role={note.type === 'err' ? 'alert' : 'status'}
          >
            {note.text}
          </div>
        ) : null}
        <div className="webserver-conflict__actions">
          <button
            type="button"
            className="btn btn--primary webserver-conflict__btn-uninstall"
            disabled={busy}
            onClick={() => void runUninstall()}
          >
            {busy ? 'Loading…' : `Uninstall ${blockingName} in terminal`}
          </button>
          <button type="button" className="btn btn--ghost" onClick={showTerminal}>
            Open terminal
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void onRefresh()}>
            Refresh status
          </button>
        </div>
        <p className="webserver-conflict__fineprint">
          Uninstall removes packages for this OS (apt, dnf/yum, or Homebrew). Confirm prompts in the terminal; when
          finished, use <strong>Refresh status</strong> so this page can continue.
        </p>
      </div>
    </section>
  )
}

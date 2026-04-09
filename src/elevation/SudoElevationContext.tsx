import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'

/** Shared with vhost panels for GET→POST read elevation. */
// eslint-disable-next-line react-refresh/only-export-components -- colocated with Provider
export function needsElevationPrompt(data: unknown, status: number): boolean {
  if (status !== 403) return false
  const d = data as { code?: string; needsElevation?: boolean }
  return (
    d.code === 'EACCES' ||
    d.code === 'EPERM' ||
    d.needsElevation === true ||
    d.code === 'ELEVATION_FAILED'
  )
}

type ElevationContextValue = {
  fetchJsonWithElevation: (
    url: string,
    method: 'PUT' | 'POST' | 'DELETE',
    body: Record<string, unknown>,
  ) => Promise<{ res: Response; data: unknown }>
  clearStoredSudoPassword: () => void
}

const SudoElevationContext = createContext<ElevationContextValue | null>(null)

/** @internal exported for panels; keep Provider in this module. */
// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with Provider
export function useSudoElevation(): ElevationContextValue {
  const ctx = useContext(SudoElevationContext)
  if (!ctx) {
    throw new Error('useSudoElevation must be used within SudoElevationProvider')
  }
  return ctx
}

export function SudoElevationProvider({ children }: { children: ReactNode }) {
  const [sessionPassword, setSessionPassword] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [hint, setHint] = useState('')
  const [field, setField] = useState('')
  const [remember, setRemember] = useState(false)
  const resolverRef = useRef<((v: { password: string; remember: boolean } | null) => void) | null>(
    null,
  )

  const clearStoredSudoPassword = useCallback(() => setSessionPassword(null), [])

  const requestSudoPassword = useCallback((message?: string) => {
    setHint(
      message?.trim() ||
        'Enter your system password (the one you use for sudo on this machine) so Dev Manager can write under /etc.',
    )
    setField('')
    setRemember(false)
    setModalOpen(true)
    return new Promise<{ password: string; remember: boolean } | null>((resolve) => {
      resolverRef.current = resolve
    })
  }, [])

  const closeModal = useCallback(() => {
    setModalOpen(false)
    setField('')
  }, [])

  const onSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      const resolve = resolverRef.current
      resolverRef.current = null
      const p = field
      closeModal()
      if (!p) {
        resolve?.(null)
        return
      }
      resolve?.({ password: p, remember })
    },
    [field, remember, closeModal],
  )

  const onCancel = useCallback(() => {
    resolverRef.current?.(null)
    resolverRef.current = null
    closeModal()
  }, [closeModal])

  const fetchJsonWithElevation = useCallback(
    async (url: string, method: 'PUT' | 'POST' | 'DELETE', body: Record<string, unknown>) => {
      const headers = { 'Content-Type': 'application/json' }

      const run = async (payload: Record<string, unknown>) => {
        const res = await fetch(url, {
          method,
          headers,
          body: JSON.stringify(payload),
        })
        const data = await res.json().catch(() => ({}))
        return { res, data }
      }

      let payload: Record<string, unknown> = { ...body }
      if (sessionPassword && payload.sudoPassword === undefined) {
        payload = { ...body, sudoPassword: sessionPassword }
      }

      let { res, data } = await run(payload)
      if (res.ok) {
        return { res, data }
      }

      let attempts = 0
      while (needsElevationPrompt(data, res.status) && attempts < 5) {
        attempts += 1
        if (payload.sudoPassword) {
          setSessionPassword(null)
        }
        const answered = await requestSudoPassword(
          (data as { error?: string }).error ||
            'Permission denied. Enter the password for sudo on this machine.',
        )
        if (!answered?.password) {
          return { res, data }
        }
        payload = { ...body, sudoPassword: answered.password }
        ;({ res, data } = await run(payload))
        if (res.ok) {
          if (answered.remember) {
            setSessionPassword(answered.password)
          }
          return { res, data }
        }
        if ((data as { code?: string }).code !== 'ELEVATION_FAILED') {
          break
        }
      }

      return { res, data }
    },
    [sessionPassword, requestSudoPassword],
  )

  const value = useMemo(
    () => ({
      fetchJsonWithElevation,
      clearStoredSudoPassword,
    }),
    [fetchJsonWithElevation, clearStoredSudoPassword],
  )

  return (
    <SudoElevationContext.Provider value={value}>
      {children}
      {modalOpen ? (
        <div
          className="modal-backdrop sudo-elevation-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sudo-elevation-title"
        >
          <form
            className="modal sudo-elevation-modal"
            autoComplete="off"
            onSubmit={onSubmit}
          >
            <div className="modal__head">
              <h2 id="sudo-elevation-title">Enter system password</h2>
              <button type="button" className="modal__close" aria-label="Close" onClick={onCancel}>
                ×
              </button>
            </div>
            <div className="sudo-elevation-modal__body">
              <p className="sudo-elevation-modal__hint">{hint}</p>
              <label className="sudo-elevation-modal__label" htmlFor="sudo-elevation-password">
                System password (sudo)
              </label>
              <input
                id="sudo-elevation-password"
                className="sudo-elevation-modal__input"
                type="password"
                name="dev-manager-sudo-once"
                autoComplete="off"
                value={field}
                onChange={(e) => setField(e.target.value)}
                autoFocus
              />
              <label className="sudo-elevation-modal__remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember for this session (stored only in memory until you reload the page)
              </label>
              <p className="sudo-elevation-modal__security">
                Sent only to your local dev server for this request to run sudo. It is not appended
                to config files or stored on disk by Dev Manager.
              </p>
            </div>
            <div className="modal__foot sudo-elevation-modal__foot">
              <button type="button" className="btn btn--ghost" onClick={onCancel}>
                Cancel
              </button>
              <button type="submit" className="btn btn--primary">
                Continue
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </SudoElevationContext.Provider>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { registerToastSink, type ToastRecord } from './toastBus'

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastRecord[]>([])
  const timersRef = useRef<Map<string, number>>(new Map())

  const dismiss = useCallback((id: string) => {
    const t = timersRef.current.get(id)
    if (t != null) {
      window.clearTimeout(t)
      timersRef.current.delete(id)
    }
    setItems((prev) => prev.filter((x) => x.id !== id))
  }, [])

  useEffect(() => {
    const onPush = (t: ToastRecord) => {
      setItems((prev) => [...prev, t].slice(-6))
      if (t.duration && t.duration > 0) {
        const tid = window.setTimeout(() => dismiss(t.id), t.duration)
        timersRef.current.set(t.id, tid)
      }
    }
    registerToastSink(onPush)
    return () => {
      registerToastSink(null)
      for (const id of timersRef.current.keys()) {
        const x = timersRef.current.get(id)
        if (x != null) window.clearTimeout(x)
      }
      timersRef.current.clear()
    }
  }, [dismiss])

  return (
    <>
      {children}
      <div className="app-toast-viewport" aria-live="polite" aria-relevant="additions text">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`app-toast app-toast--${t.kind}`}
          >
            <div className="app-toast__body">
              <span className="app-toast__title">{t.title}</span>
              {t.description ? (
                <span className="app-toast__desc">{t.description}</span>
              ) : null}
            </div>
            <button
              type="button"
              className="app-toast__close"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  )
}

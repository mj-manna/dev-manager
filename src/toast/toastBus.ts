export type ToastKind = 'success' | 'error' | 'info' | 'warning'

export type ToastInput = {
  kind: ToastKind
  title: string
  description?: string
  /** ms; 0 = stay until dismissed */
  duration?: number
}

export type ToastRecord = ToastInput & { id: string }

type Sink = (t: ToastRecord) => void

let sink: Sink | null = null

export function registerToastSink(fn: Sink | null) {
  sink = fn
}

function newId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function pushToast(input: ToastInput) {
  const record: ToastRecord = {
    ...input,
    id: newId(),
    duration: input.duration ?? 4500,
  }
  sink?.(record)
}

/** Sonner-like API for call sites */
export const toast = {
  success(title: string, opts?: { description?: string; duration?: number }) {
    pushToast({ kind: 'success', title, description: opts?.description, duration: opts?.duration })
  },
  error(title: string, opts?: { description?: string; duration?: number }) {
    pushToast({ kind: 'error', title, description: opts?.description, duration: opts?.duration ?? 6000 })
  },
  info(title: string, opts?: { description?: string; duration?: number }) {
    pushToast({ kind: 'info', title, description: opts?.description, duration: opts?.duration })
  },
  warning(title: string, opts?: { description?: string; duration?: number }) {
    pushToast({ kind: 'warning', title, description: opts?.description, duration: opts?.duration })
  },
}

function truncate(s: string, max: number) {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

export function jobToastDescription(detail: string | undefined, exitCode: number | null) {
  const code = exitCode === null || exitCode === undefined ? '—' : String(exitCode)
  if (!detail?.trim()) return `Exit code ${code}`
  return `${truncate(detail.trim(), 140)} · exit ${code}`
}

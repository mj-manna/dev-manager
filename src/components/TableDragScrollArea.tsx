import {
  useCallback,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

type Props = {
  children: ReactNode
  className?: string
}

function targetIsInteractive(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false
  return !!el.closest(
    'button, a, input, textarea, select, label, option, [role="checkbox"], [role="switch"]',
  )
}

/** Scroll container: drag with middle mouse, Shift+primary, or primary on column headers (not select column). */
export function TableDragScrollArea({ children, className }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null)

  const shouldStartPan = useCallback((e: ReactPointerEvent<HTMLDivElement>): boolean => {
    if (targetIsInteractive(e.target)) return false
    if (e.button === 1) return true
    if (e.button === 0 && e.shiftKey) return true
    if (e.button === 0 && !e.shiftKey) {
      const t = e.target as Element
      const th = t.closest('th')
      if (!th) return false
      if (th.classList.contains('postgres-data-browser__th--select')) return false
      return true
    }
    return false
  }, [])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!shouldStartPan(e)) return
      e.preventDefault()
      const el = ref.current
      if (!el) return
      el.setPointerCapture(e.pointerId)
      el.classList.add('table-drag-scroll--dragging')
      drag.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY }
    },
    [shouldStartPan],
  )

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    const el = ref.current
    if (!el) return
    const dx = e.clientX - d.lastX
    const dy = e.clientY - d.lastY
    d.lastX = e.clientX
    d.lastY = e.clientY
    el.scrollLeft -= dx
    el.scrollTop -= dy
  }, [])

  const endPan = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    ref.current?.releasePointerCapture(e.pointerId)
    ref.current?.classList.remove('table-drag-scroll--dragging')
    drag.current = null
  }, [])

  return (
    <div
      ref={ref}
      className={`table-drag-scroll-area ${className ?? ''}`.trim()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
    >
      {children}
    </div>
  )
}

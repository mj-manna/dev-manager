import type { ReactNode } from 'react'

export type ConfirmDangerModalProps = {
  open: boolean
  title: string
  titleId?: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  onCancel: () => void
  onConfirm: () => void | Promise<void>
  busy?: boolean
}

/**
 * Shared destructive-action confirmation (replaces window.confirm).
 */
export function ConfirmDangerModal({
  open,
  title,
  titleId = 'confirm-danger-title',
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onCancel,
  onConfirm,
  busy = false,
}: ConfirmDangerModalProps) {
  if (!open) return null

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={busy ? undefined : onCancel}
      onKeyDown={(e) => !busy && e.key === 'Escape' && onCancel()}
    >
      <div
        className="modal deployments-modal deployments-modal--confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-desc`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="modal__close" aria-label="Close" onClick={onCancel} disabled={busy}>
            ×
          </button>
        </div>
        <div className="modal__body">
          <p id={`${titleId}-desc`} className="deployments-modal__confirm-text deployments-modal__confirm-text--warning">
            {message}
          </p>
        </div>
        <div className="modal__foot modal__foot--split">
          <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => void onConfirm()}
            disabled={busy}
          >
            {busy ? 'Please wait…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

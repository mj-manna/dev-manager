/**
 * Optional UI tuning — stored in localStorage; safe to extend with new keys without dropping old ones.
 */

export const UI_PREFERENCES_CHANGED_EVENT = 'dev-manager-ui-preferences-changed' as const

const DENSITY_KEY = 'dev-manager-ui-density-v1'
const MOTION_KEY = 'dev-manager-ui-motion-v1'
const TERMINAL_SCALE_KEY = 'dev-manager-terminal-font-scale-v1'
const SIDEBAR_COMPACT_LABELS_KEY = 'dev-manager-sidebar-compact-labels-v1'
const CONFIRM_DANGER_KEY = 'dev-manager-confirm-danger-v1'

export type UiDensity = 'comfortable' | 'compact'
export type UiMotionPreference = 'system' | 'reduce'

function readString(key: string, fallback: string): string {
  try {
    const v = localStorage.getItem(key)
    return v != null && v !== '' ? v : fallback
  } catch {
    return fallback
  }
}

function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

export function getUiDensity(): UiDensity {
  const v = readString(DENSITY_KEY, 'comfortable')
  return v === 'compact' ? 'compact' : 'comfortable'
}

export function setUiDensity(value: UiDensity): void {
  writeString(DENSITY_KEY, value)
  applyUiPreferences()
  window.dispatchEvent(new Event(UI_PREFERENCES_CHANGED_EVENT))
}

export function getUiMotionPreference(): UiMotionPreference {
  const v = readString(MOTION_KEY, 'system')
  return v === 'reduce' ? 'reduce' : 'system'
}

export function setUiMotionPreference(value: UiMotionPreference): void {
  writeString(MOTION_KEY, value)
  applyUiPreferences()
  window.dispatchEvent(new Event(UI_PREFERENCES_CHANGED_EVENT))
}

export function getTerminalFontScale(): number {
  const raw = readString(TERMINAL_SCALE_KEY, '1')
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return 1
  return Math.min(1.35, Math.max(0.8, n))
}

export function setTerminalFontScale(scale: number): void {
  const n = Math.min(1.35, Math.max(0.8, scale))
  writeString(TERMINAL_SCALE_KEY, String(Math.round(n * 100) / 100))
  applyUiPreferences()
  window.dispatchEvent(new Event(UI_PREFERENCES_CHANGED_EVENT))
}

/** When sidebar is collapsed, still show nav labels (more verbose). */
export function getSidebarCompactLabels(): boolean {
  return readString(SIDEBAR_COMPACT_LABELS_KEY, '0') === '1'
}

export function setSidebarCompactLabels(on: boolean): void {
  writeString(SIDEBAR_COMPACT_LABELS_KEY, on ? '1' : '0')
  applyUiPreferences()
  window.dispatchEvent(new Event(UI_PREFERENCES_CHANGED_EVENT))
}

/** Extra confirmation for destructive modals (recommended on). */
export function getConfirmDangerActions(): boolean {
  return readString(CONFIRM_DANGER_KEY, '1') !== '0'
}

export function setConfirmDangerActions(on: boolean): void {
  writeString(CONFIRM_DANGER_KEY, on ? '1' : '0')
  window.dispatchEvent(new Event(UI_PREFERENCES_CHANGED_EVENT))
}

export function getTerminalFontSizePx(): number {
  return Math.round(14 * getTerminalFontScale())
}

export function applyUiPreferences(): void {
  document.documentElement.dataset.uiDensity = getUiDensity()
  document.documentElement.dataset.uiMotion = getUiMotionPreference()
  document.documentElement.style.setProperty('--terminal-font-scale', String(getTerminalFontScale()))
  document.documentElement.classList.toggle('reduce-motion', getUiMotionPreference() === 'reduce')
  document.documentElement.classList.toggle('sidebar-compact-labels', getSidebarCompactLabels())
}

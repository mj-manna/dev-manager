export type ThemePreference = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'dev-manager-theme'

export function getStoredThemePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* ignore */
  }
  return 'system'
}

export function setStoredThemePreference(value: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    /* ignore */
  }
}

export function resolveThemeIsDark(preference: ThemePreference): boolean {
  if (preference === 'light') return false
  if (preference === 'dark') return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Syncs <html> class and data-theme from preference (call on load and whenever it changes). */
export function applyThemePreference(preference: ThemePreference): void {
  const dark = resolveThemeIsDark(preference)
  document.documentElement.classList.toggle('theme-dark', dark)
  document.documentElement.dataset.theme = preference
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

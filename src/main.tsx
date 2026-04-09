import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import { SudoElevationProvider } from './elevation/SudoElevationContext'
import { DeploymentsSessionRestore } from './deployments/DeploymentsSessionRestore'
import { TerminalPane } from './terminal/TerminalPane'
import { TerminalProvider } from './terminal/TerminalContext'
import { ToastProvider } from './toast/ToastProvider'
import './index.css'
import { applyThemePreference, getStoredThemePreference } from './theme/themePreference'

applyThemePreference(getStoredThemePreference())

/** New id each full page load — Deployments uses it to restore running projects once (Strict Mode safe). */
declare global {
  interface Window {
    __dmPageLoadId?: string
  }
}
if (typeof window !== 'undefined') {
  window.__dmPageLoadId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `pl-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <TerminalProvider>
          <DeploymentsSessionRestore />
          <SudoElevationProvider>
            <App />
            <TerminalPane />
          </SudoElevationProvider>
        </TerminalProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
)

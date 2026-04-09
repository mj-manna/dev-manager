import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import { SudoElevationProvider } from './elevation/SudoElevationContext'
import { TerminalPane } from './terminal/TerminalPane'
import { TerminalProvider } from './terminal/TerminalContext'
import './index.css'
import { applyThemePreference, getStoredThemePreference } from './theme/themePreference'

applyThemePreference(getStoredThemePreference())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <TerminalProvider>
        <SudoElevationProvider>
          <App />
          <TerminalPane />
        </SudoElevationProvider>
      </TerminalProvider>
    </BrowserRouter>
  </StrictMode>,
)

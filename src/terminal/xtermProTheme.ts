import type { ITheme } from '@xterm/xterm'

/**
 * High-saturation neon palette — CLI tools, git, and errors read loud and clear.
 * (Cyberpunk / synthwave inspired, not pastel.)
 */
export const proTerminalTheme: ITheme = {
  background: '#0c0618',
  foreground: '#eef0ff',
  cursor: '#00ffea',
  cursorAccent: '#0c0618',
  selectionBackground: 'rgba(255, 0, 229, 0.35)',
  selectionForeground: '#ffffff',
  selectionInactiveBackground: 'rgba(0, 255, 234, 0.15)',

  black: '#4a3d6b',
  red: '#ff3b6b',
  green: '#3cff7a',
  yellow: '#ffe600',
  blue: '#2fb8ff',
  magenta: '#ff2fe3',
  cyan: '#00fff2',
  white: '#f8f8ff',

  brightBlack: '#6b5b94',
  brightRed: '#ff6b8a',
  brightGreen: '#7fff9a',
  brightYellow: '#fff44f',
  brightBlue: '#6ad1ff',
  brightMagenta: '#ff7ef0',
  brightCyan: '#8ffffa',
  brightWhite: '#ffffff',
}

export const proTerminalFont =
  '"JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'

/** Rainbow-style prompt marker (magenta → cyan). */
export const proTermPromptArrow = '\x1b[38;2;255;47;227m▶\x1b[0m'

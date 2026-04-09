import type { TerminalGroup, TerminalGroupSlot } from './terminalGroupsStorage'

export function slotRunnable(s: TerminalGroupSlot) {
  return Boolean(s.label.trim() && s.cwd.trim() && s.command.trim())
}

export function buildCommand(slot: TerminalGroupSlot) {
  const cmd = slot.command.trim() || 'pnpm dev'
  const port = slot.portNote?.trim()
  if (port && /^[0-9]+$/.test(port) && !/\bPORT=/.test(cmd) && !/--port\b/.test(cmd)) {
    return `PORT=${port} ${cmd}`
  }
  return cmd
}

export function findSlotById(groups: TerminalGroup[], slotId: string): TerminalGroupSlot | null {
  for (const g of groups) {
    const s = g.slots.find((x) => x.id === slotId)
    if (s) return s
  }
  return null
}

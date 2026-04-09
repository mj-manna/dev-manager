import { loadTerminalGroups } from './terminalGroupsStorage'

/** Payload sent to `/api/linux-autostart` when enabling (saved next to the autostart entry). */
export type AutostartDeploymentSlotPayload = {
  groupName: string
  label: string
  cwd: string
  command: string
  siteUrl?: string
  environment: string
}

export function collectDeploymentSlotsForAutostart(): AutostartDeploymentSlotPayload[] {
  const groups = loadTerminalGroups()
  const out: AutostartDeploymentSlotPayload[] = []
  for (const g of groups) {
    for (const s of g.slots) {
      if (!s.cwd.trim()) continue
      out.push({
        groupName: g.name,
        label: s.label,
        cwd: s.cwd,
        command: s.command,
        siteUrl: s.siteUrl?.trim() || undefined,
        environment: s.environment,
      })
    }
  }
  return out
}

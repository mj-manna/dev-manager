/** Hostname part of a vhost file id (drops trailing `.conf` for conf.d names). */
export function hostKeyFromVhostId(id: string): string {
  return (id.endsWith('.conf') ? id.slice(0, -5) : id).toLowerCase()
}

function longestStrictParent(hostKey: string, keys: Set<string>): string | null {
  let best: string | null = null
  for (const g of keys) {
    if (!g.includes('.')) continue
    if (g === hostKey) continue
    if (!hostKey.endsWith('.' + g)) continue
    if (best === null || g.length > best.length) best = g
  }
  return best
}

/** Cluster id: parent domain vhost if any, else this host (singleton). */
function clusterAnchorForHost(hostKey: string, keys: Set<string>): string {
  return longestStrictParent(hostKey, keys) ?? hostKey
}

export type VhostGroupable = {
  id: string
  name: string
  enabled: boolean
  layout: string
}

export type VhostTabMember = {
  row: VhostGroupable
  chip: string
}

export type VhostTabSection =
  | { kind: 'single'; row: VhostGroupable }
  | { kind: 'group'; anchor: string; members: VhostTabMember[] }

export type VhostTabGroupSection = Extract<VhostTabSection, { kind: 'group' }>

function chipForMember(hostKey: string, anchor: string): string {
  if (hostKey === anchor) return 'root'
  const suffix = '.' + anchor
  if (hostKey.endsWith(suffix)) {
    const prefix = hostKey.slice(0, -suffix.length)
    return prefix || 'root'
  }
  return hostKey
}

function sortMembers(members: VhostTabMember[]): VhostTabMember[] {
  return [...members].sort((a, b) => {
    if (a.chip === 'root' && b.chip !== 'root') return -1
    if (b.chip === 'root' && a.chip !== 'root') return 1
    return a.chip.localeCompare(b.chip, undefined, { sensitivity: 'base' })
  })
}

/**
 * Groups vhosts that share the same parent domain when that parent exists as its own vhost
 * (e.g. `doracone.test` + `account.doracone.test` → group anchored at `doracone.test`).
 * Works for any TLD depth; only multi-label names participate as parents.
 */
export function buildVhostTabSections(rows: VhostGroupable[]): VhostTabSection[] {
  if (rows.length === 0) return []
  const keys = new Set(rows.map((r) => hostKeyFromVhostId(r.id)))
  const anchorByRow = new Map<string, string>()
  for (const r of rows) {
    const hk = hostKeyFromVhostId(r.id)
    anchorByRow.set(r.id, clusterAnchorForHost(hk, keys))
  }
  const clusters = new Map<string, VhostGroupable[]>()
  for (const r of rows) {
    const a = anchorByRow.get(r.id)!
    if (!clusters.has(a)) clusters.set(a, [])
    clusters.get(a)!.push(r)
  }

  const anchors = [...clusters.keys()].sort((x, y) =>
    x.localeCompare(y, undefined, { sensitivity: 'base' }),
  )

  const sections: VhostTabSection[] = []
  for (const anchor of anchors) {
    const members = clusters.get(anchor)!
    if (members.length < 2) {
      sections.push({ kind: 'single', row: members[0] })
      continue
    }
    const tabMembers: VhostTabMember[] = members.map((row) => ({
      row,
      chip: chipForMember(hostKeyFromVhostId(row.id), anchor),
    }))
    sections.push({ kind: 'group', anchor, members: sortMembers(tabMembers) })
  }
  return sections
}

export function findActiveGroupSection(
  sections: VhostTabSection[],
  activeId: string | null,
): VhostTabGroupSection | null {
  if (!activeId || activeId === '__new__') return null
  for (const s of sections) {
    if (s.kind === 'group' && s.members.some((m) => m.row.id === activeId)) {
      return s
    }
  }
  return null
}

/** Prefer the apex (`root` chip) vhost when selecting a group from the parent row. */
export function defaultApexIdForGroup(section: VhostTabGroupSection): string {
  const root = section.members.find((m) => m.chip === 'root')
  return root?.row.id ?? section.members[0].row.id
}

import { useWorkspace } from '../workspace/WorkspaceContext'

type WorkspaceScopeBarProps = {
  /** `sidebar` = bottom of nav rail; full width card style. */
  variant?: 'sidebar' | 'header'
}

export function WorkspaceScopeBar({ variant = 'sidebar' }: WorkspaceScopeBarProps) {
  const { groups, effectiveGroupId, setActiveGroupId } = useWorkspace()

  const rootClass =
    variant === 'sidebar'
      ? 'admin__workspace-scope admin__workspace-scope--sidebar'
      : 'admin__workspace-scope'

  if (groups.length === 0) {
    return (
      <div className={`${rootClass} admin__workspace-scope--empty`} role="status">
        <span className="admin__workspace-scope-muted">Add a workspace in Projects</span>
      </div>
    )
  }

  return (
    <div className={rootClass} aria-label="Workspace">
      <label className="admin__workspace-scope-field">
        <span className="admin__workspace-scope-label">Workspace</span>
        <div className="admin__workspace-scope-select-wrap">
          <select
            className="admin__workspace-scope-select"
            value={effectiveGroupId ?? ''}
            onChange={(e) => setActiveGroupId(e.target.value || null)}
            title={groups.find((g) => g.id === effectiveGroupId)?.name}
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      </label>
    </div>
  )
}

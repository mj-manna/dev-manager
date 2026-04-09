import { useMemo } from 'react'
import {
  buildVhostTabSections,
  defaultApexIdForGroup,
  findActiveGroupSection,
  type VhostGroupable,
  type VhostTabMember,
} from '../vhostTabGroups'

type Props = {
  vhosts: VhostGroupable[]
  activeId: string | null
  onSelectTab: (id: string) => void
  onSelectNew: () => void
  /** Accessible name for the tab list (e.g. Apache vs nginx). */
  tablistLabel?: string
}

export function WebServerVhostTabs({
  vhosts,
  activeId,
  onSelectTab,
  onSelectNew,
  tablistLabel = 'Virtual host files',
}: Props) {
  const sections = useMemo(() => buildVhostTabSections(vhosts), [vhosts])
  const activeGroup = useMemo(
    () => findActiveGroupSection(sections, activeId),
    [sections, activeId],
  )

  const parentGroupSelected = (section: { kind: 'group'; members: VhostTabMember[] }) =>
    activeId !== null && section.members.some((m) => m.row.id === activeId)

  return (
    <div className="nginx-tabs-wrap">
      <div
        className="nginx-tabs nginx-tabs--parent"
        role="tablist"
        aria-label={tablistLabel}
      >
        {sections.map((section) =>
          section.kind === 'single' ? (
            <button
              key={section.row.id}
              type="button"
              role="tab"
              aria-selected={activeId === section.row.id}
              className={`nginx-tab nginx-tab--parent ${activeId === section.row.id ? 'nginx-tab--active' : ''}`}
              onClick={() => onSelectTab(section.row.id)}
              title={section.row.name}
            >
              <span className="nginx-tab__name">{section.row.name}</span>
              {section.row.layout === 'debian' ? (
                <span
                  className={`nginx-tab__pill ${section.row.enabled ? 'nginx-tab__pill--on' : ''}`}
                >
                  {section.row.enabled ? 'enabled' : 'off'}
                </span>
              ) : null}
            </button>
          ) : (
            <button
              key={section.anchor}
              type="button"
              role="tab"
              aria-selected={parentGroupSelected(section)}
              aria-label={`${section.anchor} (${section.members.length} sites)`}
              className={`nginx-tab nginx-tab--parent nginx-tab--parent-group ${parentGroupSelected(section) ? 'nginx-tab--active' : ''}`}
              onClick={() => onSelectTab(defaultApexIdForGroup(section))}
              title={section.anchor}
            >
              <span className="nginx-tab__parent-label">{section.anchor}</span>
              <span className="nginx-tab__parent-count">{section.members.length}</span>
            </button>
          ),
        )}
        <button
          type="button"
          role="tab"
          aria-selected={activeId === '__new__'}
          className={`nginx-tab nginx-tab--parent nginx-tab--new ${activeId === '__new__' ? 'nginx-tab--active' : ''}`}
          onClick={onSelectNew}
        >
          + New file
        </button>
      </div>

      {activeGroup ? (
        <div
          className="nginx-tabs nginx-tabs--child"
          role="tablist"
          aria-label={`Sites under ${activeGroup.anchor}`}
        >
          <span className="nginx-tabs-child__prefix" aria-hidden="true">
            {activeGroup.anchor}
          </span>
          <div className="nginx-tabs-child__tabs">
            {activeGroup.members.map(({ row, chip }) => (
              <button
                key={row.id}
                type="button"
                role="tab"
                aria-selected={activeId === row.id}
                aria-label={`${row.name} (${chip})`}
                className={`nginx-tab nginx-tab--child ${activeId === row.id ? 'nginx-tab--active' : ''}`}
                onClick={() => onSelectTab(row.id)}
                title={row.name}
              >
                <span className="nginx-tab__chip">{chip}</span>
                {row.layout === 'debian' ? (
                  <span className={`nginx-tab__pill ${row.enabled ? 'nginx-tab__pill--on' : ''}`}>
                    {row.enabled ? 'enabled' : 'off'}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

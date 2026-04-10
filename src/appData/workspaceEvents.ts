/** Fired when a workspace is removed so terminals can close deployment tabs. */
export const WORKSPACE_DELETED_EVENT = 'dev-manager-workspace-deleted' as const

export type WorkspaceDeletedDetail = { slotIds: string[] }

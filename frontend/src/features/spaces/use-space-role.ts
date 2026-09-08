import type { Space, SpaceRole } from '@/lib/api';

export interface SpacePermissions {
  /** Undefined until the space has loaded. */
  role: SpaceRole | undefined;
  /**
   * May change shared material: sources, notes, the notebook, the space's
   * details. False for a viewer, for an archived space (REQ-065), and before
   * the space is known — one condition for every write affordance, so the
   * archived rule and the role rule can never drift apart.
   */
  canEdit: boolean;
  /** May manage members, archive or delete the space, delete anyone's source. */
  isOwner: boolean;
  /** A member without write rights: reads everything, exports, asks the assistant. */
  isViewer: boolean;
  /** Archived: read-only for every role, restore is the owner's. */
  archived: boolean;
}

/**
 * The one place the role and the archived state are turned into affordances
 * (wiki-docs/plan/shared-spaces-v1/design.md "Frontend › Gating").
 */
export function useSpaceRole(space: Space | undefined): SpacePermissions {
  const role = space?.myRole;
  const archived = space !== undefined && space.archivedAt !== null;
  return {
    role,
    archived,
    canEdit: space !== undefined && !archived && role !== 'viewer',
    isOwner: role === 'owner',
    isViewer: role === 'viewer',
  };
}

/** The same rule without a hook, for code that only has the role and the flag. */
export function canEditSpace(space: Pick<Space, 'myRole' | 'archivedAt'> | undefined): boolean {
  return space !== undefined && space.archivedAt === null && space.myRole !== 'viewer';
}

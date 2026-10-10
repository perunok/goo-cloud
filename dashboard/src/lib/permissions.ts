/**
 * Mirrors the authorization matrix in server/README.md ("Authorization matrix").
 * This only decides what the UI offers; the server remains the authority.
 */
import type { PlatformRole, WorkspaceRole } from './api/schemas';

export type Role = PlatformRole | undefined | null;
export type WsRole = WorkspaceRole | undefined | null;

export const isPlatformAdmin = (p: Role) => p === 'super_admin' || p === 'platform_admin';
export const isSuperAdmin = (p: Role) => p === 'super_admin';

/** /v1/admin/* routes (users list, platform audit, health, admin workspace list). */
export const canUseAdminRoutes = isPlatformAdmin;

/** Create users at all. */
export const canCreateUsers = isPlatformAdmin;

/** Platform roles the caller may assign when creating a user / changing a role. */
export function assignablePlatformRoles(p: Role): PlatformRole[] {
  // `super_admin` is never assignable: the single super admin comes from GOO_ADMIN_BOOTSTRAP.
  if (isSuperAdmin(p)) return ['user', 'platform_admin'];
  if (isPlatformAdmin(p)) return ['user'];
  return [];
}

/** Change an existing user's platform role: super_admin only. */
export const canChangePlatformRole = isSuperAdmin;

/** Add members, see and cancel additions waiting for an account, read the workspace audit log. */
export const canModerateMembership = (p: Role, w: WsRole) => isPlatformAdmin(p) || w === 'owner' || w === 'admin';
export const canViewWorkspaceAudit = canModerateMembership;

const WS_RANK: Record<WorkspaceRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

/**
 * Change the role of / remove one member. Never the owner (transfer instead); owners and platform admins anyone else;
 * a workspace admin only members below their own role (editors and viewers). Mirrors `assertCanManage` in
 * server/src/routes/membership.ts.
 */
export function canManageMember(p: Role, w: WsRole, target: WorkspaceRole): boolean {
  if (target === 'owner') return false;
  if (isPlatformAdmin(p) || w === 'owner') return true;
  if (w !== 'admin') return false;
  return WS_RANK[target] < WS_RANK[w];
}
/** Whether the caller can manage anyone at all (decides whether the action column is shown). */
export const canManageMembers = (p: Role, w: WsRole) => isPlatformAdmin(p) || w === 'owner' || w === 'admin';

/** PATCH /workspaces/{id} (name, description): owner or platform admin. */
export const canEditWorkspaceSettings = (p: Role, w: WsRole) => isPlatformAdmin(p) || w === 'owner';

/** POST /workspaces/{id}/transfer: the owner or the super admin. */
export const canTransferOwnership = (p: Role, w: WsRole) => isSuperAdmin(p) || w === 'owner';

export const canDeleteWorkspace = (p: Role, w: WsRole) => isSuperAdmin(p) || w === 'owner';

/** POST /workspaces/{id}/leave: any member except the owner (platform admins without a membership have nothing to leave). */
export const canLeaveWorkspace = (w: WsRole) => !!w && w !== 'owner';

/** Roles that can be granted when adding members / changing roles ("owner" is never assignable here). */
export const ASSIGNABLE_WORKSPACE_ROLES: WorkspaceRole[] = ['admin', 'editor', 'viewer'];

/**
 * Roles the caller may grant when adding a member or changing a role: never above their own workspace role
 * (platform admins may grant every assignable role). Mirrors `assertCanGrant` in server/src/routes/membership.ts.
 */
export function grantableWorkspaceRoles(p: Role, w: WsRole): WorkspaceRole[] {
  if (isPlatformAdmin(p)) return ASSIGNABLE_WORKSPACE_ROLES;
  if (!w) return [];
  return ASSIGNABLE_WORKSPACE_ROLES.filter((r) => WS_RANK[r] <= WS_RANK[w]);
}

/** An owner row is locked: the workspace must always keep its owner (ownership moves only by transfer). */
export const isOwnerLocked = (memberRole: WorkspaceRole) => memberRole === 'owner';

/** What each workspace role means for a goo user (shown next to role pickers). */
export const workspaceRoleHelp: Record<WorkspaceRole, string> = {
  owner: 'Everything, including renaming, transferring and deleting the workspace',
  admin: 'Edit notes and manage members',
  editor: 'Edit notes (sync pushes changes)',
  viewer: 'Read notes only (sync pulls, never pushes)',
};

export const platformRoleLabel: Record<PlatformRole, string> = {
  super_admin: 'Super admin',
  platform_admin: 'Platform admin',
  user: 'User',
};

/**
 * Disable / re-enable an account (PATCH /admin/users/{id} `{disabled}`). Mirrors the server: nobody can disable
 * themselves, the super admin can never be disabled, and only a super admin may touch another platform admin.
 * `reason` explains a disabled control in the UI.
 */
export function disableUserPolicy(
  actor: { id: string; platform_role: PlatformRole } | null | undefined,
  target: { id: string; platform_role: PlatformRole },
): { allowed: true } | { allowed: false; reason: string } {
  if (!actor || !isPlatformAdmin(actor.platform_role)) return { allowed: false, reason: 'Only platform admins can disable users' };
  if (target.id === actor.id) return { allowed: false, reason: 'You cannot disable your own account' };
  if (target.platform_role === 'super_admin') return { allowed: false, reason: 'The super admin cannot be disabled' };
  if (target.platform_role === 'platform_admin' && !isSuperAdmin(actor.platform_role)) {
    return { allowed: false, reason: 'Only the super admin can disable a platform admin' };
  }
  return { allowed: true };
}

/**
 * Force a password change / reset a user's password (PATCH /admin/users/{id} `{must_change_password}`,
 * POST /admin/users/{id}/reset-password). Same rules as disabling: not yourself (use the Account page), never the super
 * admin, other platform admins only by the super admin.
 */
export function userPasswordPolicy(
  actor: { id: string; platform_role: PlatformRole } | null | undefined,
  target: { id: string; platform_role: PlatformRole },
): { allowed: true } | { allowed: false; reason: string } {
  if (!actor || !isPlatformAdmin(actor.platform_role)) return { allowed: false, reason: 'Only platform admins can manage passwords' };
  if (target.id === actor.id) return { allowed: false, reason: 'Change your own password on the Account page' };
  if (target.platform_role === 'super_admin') return { allowed: false, reason: "The super admin's password can only be changed by the super admin" };
  if (target.platform_role === 'platform_admin' && !isSuperAdmin(actor.platform_role)) {
    return { allowed: false, reason: "Only the super admin can manage a platform admin's password" };
  }
  return { allowed: true };
}

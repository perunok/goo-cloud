import { describe, expect, it } from 'vitest';
import * as p from './permissions';

describe('authorization matrix', () => {
  it('platform-level', () => {
    expect(p.canUseAdminRoutes('super_admin')).toBe(true);
    expect(p.canUseAdminRoutes('platform_admin')).toBe(true);
    expect(p.canUseAdminRoutes('user')).toBe(false);
    expect(p.canChangePlatformRole('super_admin')).toBe(true);
    expect(p.canChangePlatformRole('platform_admin')).toBe(false);
    expect(p.assignablePlatformRoles('super_admin')).toEqual(['user', 'platform_admin']);
    expect(p.assignablePlatformRoles('platform_admin')).toEqual(['user']);
    expect(p.assignablePlatformRoles('user')).toEqual([]);
  });
  it('add members / pending invites / workspace audit: platform admins, owners, admins', () => {
    expect(p.canModerateMembership('user', 'owner')).toBe(true);
    expect(p.canModerateMembership('user', 'admin')).toBe(true);
    expect(p.canModerateMembership('user', 'editor')).toBe(false);
    expect(p.canModerateMembership('user', 'viewer')).toBe(false);
    expect(p.canModerateMembership('platform_admin', null)).toBe(true);
    expect(p.canViewWorkspaceAudit('user', 'admin')).toBe(true);
    expect(p.canViewWorkspaceAudit('user', 'editor')).toBe(false);
    expect(p.canViewWorkspaceAudit('super_admin', null)).toBe(true);
  });
  it('change role / remove: never the owner; owners and platform admins anyone else; admins only editors and viewers', () => {
    for (const t of ['admin', 'editor', 'viewer'] as const) {
      expect(p.canManageMember('user', 'owner', t)).toBe(true);
      expect(p.canManageMember('platform_admin', null, t)).toBe(true);
    }
    expect(p.canManageMember('user', 'owner', 'owner')).toBe(false);
    expect(p.canManageMember('super_admin', null, 'owner')).toBe(false);
    expect(p.canManageMember('user', 'admin', 'admin')).toBe(false);
    expect(p.canManageMember('user', 'admin', 'editor')).toBe(true);
    expect(p.canManageMember('user', 'admin', 'viewer')).toBe(true);
    expect(p.canManageMember('user', 'editor', 'viewer')).toBe(false);
    expect(p.canManageMember('user', 'viewer', 'viewer')).toBe(false);
    expect(p.canManageMembers('user', 'admin')).toBe(true);
    expect(p.canManageMembers('user', 'editor')).toBe(false);
  });
  it('transfer: owner or super admin; leave: any member but the owner', () => {
    expect(p.canTransferOwnership('user', 'owner')).toBe(true);
    expect(p.canTransferOwnership('super_admin', null)).toBe(true);
    expect(p.canTransferOwnership('platform_admin', null)).toBe(false);
    expect(p.canTransferOwnership('user', 'admin')).toBe(false);
    expect(p.canLeaveWorkspace('owner')).toBe(false);
    expect(p.canLeaveWorkspace('viewer')).toBe(true);
    expect(p.canLeaveWorkspace('admin')).toBe(true);
    expect(p.canLeaveWorkspace(null)).toBe(false);
  });
  it('delete workspace: super admin or owner (not platform_admin, not workspace admin)', () => {
    expect(p.canDeleteWorkspace('super_admin', null)).toBe(true);
    expect(p.canDeleteWorkspace('user', 'owner')).toBe(true);
    expect(p.canDeleteWorkspace('platform_admin', null)).toBe(false);
    expect(p.canDeleteWorkspace('user', 'admin')).toBe(false);
  });
  it('owner rows are locked and owner is not assignable', () => {
    expect(p.isOwnerLocked('owner')).toBe(true);
    expect(p.isOwnerLocked('admin')).toBe(false);
    expect(p.ASSIGNABLE_WORKSPACE_ROLES).not.toContain('owner');
  });
  it('workspace settings: owner or platform admin only (workspace admins/editors cannot)', () => {
    expect(p.canEditWorkspaceSettings('user', 'owner')).toBe(true);
    expect(p.canEditWorkspaceSettings('platform_admin', null)).toBe(true);
    expect(p.canEditWorkspaceSettings('super_admin', null)).toBe(true);
    expect(p.canEditWorkspaceSettings('user', 'admin')).toBe(false);
    expect(p.canEditWorkspaceSettings('user', 'editor')).toBe(false);
    expect(p.canEditWorkspaceSettings('user', null)).toBe(false);
  });
  it('disable user: never self or the super admin; platform admins only by the super admin', () => {
    const sa = { id: 's', platform_role: 'super_admin' as const };
    const pa = { id: 'p', platform_role: 'platform_admin' as const };
    const plain = { id: 'u', platform_role: 'user' as const };
    expect(p.disableUserPolicy(sa, plain)).toEqual({ allowed: true });
    expect(p.disableUserPolicy(pa, plain)).toEqual({ allowed: true });
    expect(p.disableUserPolicy(sa, pa)).toEqual({ allowed: true });
    expect(p.disableUserPolicy(pa, { id: 'p2', platform_role: 'platform_admin' })).toMatchObject({ allowed: false });
    expect(p.disableUserPolicy(sa, sa)).toMatchObject({ allowed: false, reason: expect.stringMatching(/own account/) });
    expect(p.disableUserPolicy(pa, sa)).toMatchObject({ allowed: false });
    expect(p.disableUserPolicy(pa, pa)).toMatchObject({ allowed: false });
    expect(p.disableUserPolicy(plain, { id: 'x', platform_role: 'user' })).toMatchObject({ allowed: false });
    expect(p.disableUserPolicy(null, plain)).toMatchObject({ allowed: false });
  });

  it('grantableWorkspaceRoles never exceeds the caller\'s own role', () => {
    expect(p.grantableWorkspaceRoles('platform_admin', null)).toEqual(['admin', 'editor', 'viewer']);
    expect(p.grantableWorkspaceRoles('user', 'owner')).toEqual(['admin', 'editor', 'viewer']);
    expect(p.grantableWorkspaceRoles('user', 'admin')).toEqual(['admin', 'editor', 'viewer']);
    expect(p.grantableWorkspaceRoles('user', 'editor')).toEqual(['editor', 'viewer']);
    expect(p.grantableWorkspaceRoles('user', null)).toEqual([]);
  });

  it('userPasswordPolicy mirrors the admin password rules', () => {
    const sup = { id: 's', platform_role: 'super_admin' as const };
    const pad = { id: 'p', platform_role: 'platform_admin' as const };
    const plain = { id: 'u', platform_role: 'user' as const };
    expect(p.userPasswordPolicy(pad, plain)).toEqual({ allowed: true });
    expect(p.userPasswordPolicy(pad, pad)).toMatchObject({ allowed: false });
    expect(p.userPasswordPolicy(pad, { id: 'p2', platform_role: 'platform_admin' })).toMatchObject({ allowed: false });
    expect(p.userPasswordPolicy(sup, pad)).toEqual({ allowed: true });
    expect(p.userPasswordPolicy(pad, sup)).toMatchObject({ allowed: false });
    expect(p.userPasswordPolicy(plain, { id: 'x', platform_role: 'user' })).toMatchObject({ allowed: false });
  });
});

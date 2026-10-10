import { z } from 'zod';

/**
 * Every schema in here is the single place where we decide what the server may send us.
 * Mirrors the response schemas in server/openapi.yaml (generated from server/src/lib/dto.ts and the routes).
 */

export const platformRoleSchema = z.enum(['super_admin', 'platform_admin', 'user']);
export type PlatformRole = z.infer<typeof platformRoleSchema>;

export const workspaceRoleSchema = z.enum(['owner', 'admin', 'editor', 'viewer']);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  display_name: z.string().nullish(),
  platform_role: platformRoleSchema,
  /**
   * True while an admin-issued (temporary) password must be replaced. The server then refuses everything except
   * GET /me, POST /me/password, the session probe and logout (403 `password_change_required`).
   */
  must_change_password: z.boolean().optional(),
  /** Only on admin views (`/admin/users`). */
  disabled: z.boolean().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type User = z.infer<typeof userSchema>;

export const loginResponseSchema = z.object({
  user: userSchema,
  csrf_token: z.string().min(1),
});

/** POST /v1/admin/users. `temporary_password` is only set when the request omitted `password`. */
export const createUserResponseSchema = z.object({
  user: userSchema,
  temporary_password: z.string().nullish(),
});

/** POST /v1/admin/users/{id}/reset-password: the new temporary password is returned exactly once. */
export const resetPasswordResponseSchema = z.object({
  user: userSchema,
  temporary_password: z.string().min(1),
});

export const workspaceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  owner_user_id: z.string().optional(),
  /** Only on `/admin/workspaces` items. */
  member_count: z.number().optional(),
  /** Present on the non-admin list (caller's role). */
  role: workspaceRoleSchema.nullish(),
  /** GET /workspaces (yours) only: who added you (null if you created it) and when you joined. */
  added_by: z.object({ id: z.string(), display_name: z.string() }).nullish(),
  joined_at: z.string().nullish(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  version: z.number().default(1),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const workspaceDetailSchema = z.object({
  workspace: workspaceSchema,
  /** Null for a platform admin who is not a member. */
  membership: z.object({ role: workspaceRoleSchema }).nullish(),
});
export type WorkspaceDetail = z.infer<typeof workspaceDetailSchema>;

export const memberSchema = z.object({
  id: z.string(),
  workspace_id: z.string().optional(),
  user_id: z.string(),
  email: z.string().nullish(),
  display_name: z.string().nullish(),
  role: workspaceRoleSchema,
  status: z.string().optional(),
  joined_at: z.string().nullish(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  version: z.number().default(1),
});
export type Member = z.infer<typeof memberSchema>;

export const inviteSchema = z.object({
  id: z.string(),
  workspace_id: z.string().optional(),
  email: z.string(),
  role: workspaceRoleSchema,
  status: z.string(),
  invited_by_user_id: z.string().nullish(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  version: z.number().default(1),
});
export type Invite = z.infer<typeof inviteSchema>;

/**
 * POST /workspaces/{id}/members: an existing account is added at once (`added`); an email without an account gets a
 * pending invite (`pending`) that turns into a membership when that account is created or signs in. No token.
 */
export const addMemberResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('added'), member: memberSchema }),
  z.object({ status: z.literal('pending'), invite: inviteSchema }),
]);
export type AddMemberResponse = z.infer<typeof addMemberResponseSchema>;

/** GET /workspaces/{id}/notes items: metadata only. */
export const noteMetaSchema = z.object({
  id: z.string(),
  workspace_id: z.string().optional(),
  path: z.string(),
  version: z.number(),
  /** UTF-8 bytes of the content. */
  size: z.number(),
  created_at: z.string().optional(),
  updated_at: z.string(),
  /** Who changed the note last (null when that account no longer exists). */
  updated_by: z.object({ id: z.string(), display_name: z.string() }).nullish(),
});
export type NoteMeta = z.infer<typeof noteMetaSchema>;

/** GET /workspaces/{id}/notes/{note_id}. */
export const noteSchema = noteMetaSchema.extend({
  content: z.string(),
  content_hash: z.string().optional(),
});
export type Note = z.infer<typeof noteSchema>;

/** GET /me/devices: the caller's registered sync devices (goo desktop installations). */
export const deviceSchema = z.object({
  id: z.string(),
  device_name: z.string(),
  platform: z.string(),
  app_version: z.string(),
  created_at: z.string(),
  last_seen_at: z.string(),
});
export type Device = z.infer<typeof deviceSchema>;

export const auditLogSchema = z.object({
  id: z.string(),
  workspace_id: z.string().nullish(),
  actor_user_id: z.string().nullish(),
  actor_email: z.string().nullish(),
  /** Dotted names such as `member.role_changed`, `invite.created`, `admin.user_created`. */
  action: z.string(),
  resource_type: z.string().nullish(),
  resource_id: z.string().nullish(),
  request_id: z.string().nullish(),
  details: z.record(z.string(), z.unknown()).nullish(),
  created_at: z.string(),
});
export type AuditLog = z.infer<typeof auditLogSchema>;

export const statsSchema = z.object({
  users: z.number(),
  platform_admins: z.number(),
  disabled_users: z.number(),
  workspaces: z.number(),
  memberships: z.number(),
  pending_invites: z.number(),
  notes: z.number(),
  devices: z.number(),
  active_sessions: z.number(),
  audit_logs: z.number(),
});
export type Stats = z.infer<typeof statsSchema>;

export const healthSchema = z.object({
  status: z.string(),
  services: z.record(z.string(), z.string()).default({}),
  timestamp: z.string().optional(),
});
export type Health = z.infer<typeof healthSchema>;

export const pageInfoSchema = z.object({
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: pageInfoSchema,
  });
}
export interface Page<T> {
  items: T[];
  page: { next_cursor: string | null; has_more: boolean };
}

export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    request_id: z.string().nullish(),
  }),
});

/** `{ ok: true }` and other bodies we do not read (delete, logout, ...). */
export const anyObjectSchema = z.object({}).passthrough();

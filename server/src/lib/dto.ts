import { z } from "zod";
import type { AuditLog, Invite, Membership, Note, SyncClient, User, Workspace } from "@prisma/client";

const ts = z.string().datetime();
const id = z.string();
export const workspaceRoleEnum = z.enum(["owner", "admin", "editor", "viewer"]);
export const assignableRoleEnum = z.enum(["admin", "editor", "viewer"]);
export const platformRoleEnum = z.enum(["super_admin", "platform_admin", "user"]);

// ---------- response schemas (also published in openapi.yaml) ----------
export const userSchema = z.object({
  id, email: z.string(), display_name: z.string(), platform_role: platformRoleEnum,
  /** True while an admin-issued password must be replaced (only GET /v1/me, POST /v1/me/password and logout work). */
  must_change_password: z.boolean()
});
export const adminUserSchema = userSchema.extend({ disabled: z.boolean(), created_at: ts, updated_at: ts });

export const workspaceSchema = z.object({
  id, slug: z.string(), name: z.string(), description: z.string(), owner_user_id: id,
  created_at: ts, updated_at: ts, version: z.number().int()
});
export const workspaceListItemSchema = workspaceSchema.extend({
  role: workspaceRoleEnum,
  /** When the caller became a member. */
  joined_at: ts,
  /** Who added the caller (an owner/admin); null for the creator. */
  added_by: z.object({ id, display_name: z.string() }).nullable()
});

export const memberSchema = z.object({
  id, workspace_id: id, user_id: id, email: z.string(), display_name: z.string(), role: workspaceRoleEnum,
  status: z.enum(["active", "removed"]), joined_at: ts, created_at: ts, updated_at: ts, version: z.number().int()
});
export const inviteSchema = z.object({
  id, workspace_id: id, email: z.string(), role: workspaceRoleEnum,
  status: z.enum(["pending", "accepted", "revoked"]),
  invited_by_user_id: id.nullable(), created_at: ts, updated_at: ts, version: z.number().int()
});
export const noteMetaSchema = z.object({
  id, workspace_id: id, path: z.string(), version: z.number().int(),
  /** UTF-8 bytes of the content. */
  size: z.number().int(),
  created_at: ts, updated_at: ts,
  /** Who changed the note last (null when that account no longer exists). */
  updated_by: z.object({ id, display_name: z.string() }).nullable()
});
export const noteSchema = noteMetaSchema.extend({ content: z.string(), content_hash: z.string() });
export const deviceSchema = z.object({
  id, device_name: z.string(), platform: z.string(), app_version: z.string(), created_at: ts, last_seen_at: ts
});
export const auditLogSchema = z.object({
  id, actor_user_id: id.nullable(), actor_email: z.string().nullable(), action: z.string(), resource_type: z.string(), resource_id: z.string(),
  workspace_id: id.nullable(), request_id: z.string().nullable(), details: z.record(z.unknown()), created_at: ts
});
export const pageSchema = z.object({ next_cursor: z.string().nullable(), has_more: z.boolean() });
export const paged = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), page: pageSchema });

// ---------- serializers ----------
const iso = (d: Date) => d.toISOString();

export const toUser = (u: User) => ({
  id: u.id, email: u.email, display_name: u.displayName, platform_role: u.platformRole,
  must_change_password: u.mustChangePassword
});
export const toAdminUser = (u: User) => ({
  ...toUser(u), disabled: u.disabledAt !== null, created_at: iso(u.createdAt), updated_at: iso(u.updatedAt)
});
export const toWorkspace = (w: Workspace) => ({
  id: w.id, slug: w.slug, name: w.name, description: w.description, owner_user_id: w.ownerUserId,
  created_at: iso(w.createdAt), updated_at: iso(w.updatedAt), version: w.version
});
export const toMember = (m: Membership & { user: Pick<User, "email" | "displayName"> }) => ({
  id: m.id, workspace_id: m.workspaceId, user_id: m.userId, email: m.user.email,
  display_name: m.user.displayName, role: m.role, status: m.status, joined_at: iso(m.joinedAt),
  created_at: iso(m.createdAt), updated_at: iso(m.updatedAt), version: m.version
});
export const toInvite = (i: Invite) => ({
  id: i.id, workspace_id: i.workspaceId, email: i.email, role: i.role, status: i.status,
  invited_by_user_id: i.invitedByUserId, created_at: iso(i.createdAt), updated_at: iso(i.updatedAt), version: i.version
});
type NoteWithAuthor = Omit<Note, "content"> & { updatedBy: Pick<User, "id" | "displayName"> | null };
export const toNoteMeta = (n: NoteWithAuthor) => ({
  id: n.id, workspace_id: n.workspaceId, path: n.path, version: n.version, size: n.size,
  created_at: iso(n.createdAt), updated_at: iso(n.updatedAt),
  updated_by: n.updatedBy ? { id: n.updatedBy.id, display_name: n.updatedBy.displayName } : null
});
export const toNote = (n: NoteWithAuthor & { content: string }) => ({ ...toNoteMeta(n), content: n.content, content_hash: n.contentHash });
export const toDevice = (c: SyncClient) => ({
  id: c.id, device_name: c.deviceName, platform: c.platform, app_version: c.appVersion,
  created_at: iso(c.createdAt), last_seen_at: iso(c.lastSeenAt)
});
export const toAuditLog = (a: AuditLog & { actor: Pick<User, "email"> | null }) => ({
  id: a.id, actor_user_id: a.actorUserId, actor_email: a.actor?.email ?? null, action: a.action, resource_type: a.resourceType,
  resource_id: a.resourceId, workspace_id: a.workspaceId, request_id: a.requestId,
  details: (a.details ?? {}) as Record<string, unknown>, created_at: iso(a.createdAt)
});

export const okSchema = z.object({ ok: z.literal(true) });
export const ok = () => ({ ok: true as const });

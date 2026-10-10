/**
 * The ONLY place that knows route paths and payload shapes.
 * Every route here is listed in API-USAGE.md and checked against server/openapi.yaml.
 */
import { z } from 'zod';
import type { HttpClient } from './client';
import {
  anyObjectSchema,
  auditLogSchema,
  addMemberResponseSchema,
  createUserResponseSchema,
  deviceSchema,
  healthSchema,
  inviteSchema,
  loginResponseSchema,
  memberSchema,
  noteMetaSchema,
  noteSchema,
  pageSchema,
  resetPasswordResponseSchema,
  statsSchema,
  userSchema,
  workspaceDetailSchema,
  workspaceSchema,
  type Page,
  type PlatformRole,
  type WorkspaceRole,
} from './schemas';

export const DEFAULT_PAGE_SIZE = 20;

export interface ListParams {
  cursor?: string | null;
  limit?: number;
  q?: string;
  /** Server default is oldest first; audit logs ask for `desc`. */
  order?: 'asc' | 'desc';
}

const enc = encodeURIComponent;
const ws = (id: string) => `/workspaces/${enc(id)}`;

export function createApi(c: HttpClient) {
  // The server lists oldest first by default; pages that prepend freshly created rows ask for newest first.
  const list = <S extends z.ZodType>(path: string, item: S, query: Record<string, string | number | undefined | null>) =>
    c.request('GET', path, { schema: pageSchema(item), query: { limit: DEFAULT_PAGE_SIZE, order: 'asc', ...query } }) as Promise<
      Page<z.output<S>>
    >;

  return {
    auth: {
      login: (email: string, password: string) =>
        c.request('POST', '/auth/browser/login', {
          body: { email, password },
          schema: loginResponseSchema,
          handleUnauthorized: false,
        }),
      logout: () => c.request('POST', '/auth/browser/logout', { schema: anyObjectSchema, handleUnauthorized: false }),
      /**
       * Boot-time session probe: `{ user, csrf_token }` for the cookie session (the CSRF token is re-derived
       * server-side, so it survives a reload). A 401 here just means "not signed in".
       */
      session: () => c.request('GET', '/auth/browser/session', { schema: loginResponseSchema, handleUnauthorized: false }),
      /**
       * Approves a pending desktop sign-in (device flow) for the signed-in user. The goo app shows the code;
       * 404 `not_found` means unknown, expired or already used.
       */
      approveDevice: (user_code: string) =>
        c.request('POST', '/auth/device/approve', { body: { user_code }, schema: anyObjectSchema }),
    },

    me: {
      /**
       * Self-service password change. Errors: 403 `forbidden` + `details.reason: invalid_current_password`,
       * 400 `invalid_request` (`details.issues` on `new_password`), 429 `rate_limited`. On success the server keeps this
       * cookie session (and its CSRF token) and signs out every other session and device.
       */
      changePassword: (current_password: string, new_password: string) =>
        c.request('POST', '/me/password', { body: { current_password, new_password }, schema: anyObjectSchema }),
      /** The caller's goo installations registered for sync, newest first. */
      devices: (p: ListParams) => list('/me/devices', deviceSchema, { order: 'desc', cursor: p.cursor, limit: p.limit }),
      /** Signs a device out (drops the refresh tokens of its sign-in) and removes it from the list. */
      signOutDevice: (deviceId: string) => c.request('DELETE', `/me/devices/${enc(deviceId)}`, { schema: anyObjectSchema }),
    },

    admin: {
      users: (p: ListParams) => list('/admin/users', userSchema, { order: 'desc', cursor: p.cursor, limit: p.limit, q: p.q }),
      createUser: (input: {
        email: string;
        display_name: string;
        platform_role: PlatformRole;
        password?: string;
        /** Always true on the server when `password` is omitted (generated temporary password). */
        must_change_password?: boolean;
      }) => c.request('POST', '/admin/users', { body: input, schema: createUserResponseSchema }),
      setMustChangePassword: (userId: string, must_change_password: boolean) =>
        c.request('PATCH', `/admin/users/${enc(userId)}`, {
          body: { must_change_password },
          schema: z.object({ user: userSchema }),
        }),
      /** New temporary password (shown once), forces a change and signs the user out everywhere. */
      resetPassword: (userId: string) =>
        c.request('POST', `/admin/users/${enc(userId)}/reset-password`, { body: {}, schema: resetPasswordResponseSchema }),
      setUserDisabled: (userId: string, disabled: boolean) =>
        c.request('PATCH', `/admin/users/${enc(userId)}`, {
          body: { disabled },
          schema: z.object({ user: userSchema }),
        }),
      setUserRole: (userId: string, platform_role: PlatformRole) =>
        c.request('PATCH', `/admin/users/${enc(userId)}`, {
          body: { platform_role },
          schema: z.object({ user: userSchema }),
        }),
      workspaces: (p: ListParams) =>
        list('/admin/workspaces', workspaceSchema, { order: 'desc', cursor: p.cursor, limit: p.limit, q: p.q }),
      auditLogs: (p: ListParams & { action?: string }) =>
        list('/admin/audit-logs', auditLogSchema, { cursor: p.cursor, limit: p.limit, action: p.action, order: 'desc' }),
      stats: () => c.request('GET', '/admin/stats', { schema: statsSchema }),
      // 503 carries the same body (`status: degraded`, `services.postgres: down`), so it is data, not an error.
      health: () => c.request('GET', '/admin/health', { schema: healthSchema, acceptStatus: [503] }),
    },

    workspaces: {
      /** Workspaces the caller is a member of (used for non-platform-admins). */
      mine: (p: ListParams) => list('/workspaces', workspaceSchema, { order: 'desc', cursor: p.cursor, limit: p.limit }),
      /** `slug` is optional: the server derives one from the name. */
      create: (input: { name: string; slug?: string; description?: string }) =>
        c.request('POST', '/workspaces', { body: input, schema: z.object({ workspace: workspaceSchema }) }),
      get: (id: string) => c.request('GET', ws(id), { schema: workspaceDetailSchema }),
      remove: (id: string) => c.request('DELETE', ws(id), { schema: anyObjectSchema }),
      /** Owner or platform admin. `version` is the workspace version the form was loaded from (409 `version_mismatch` if stale). */
      update: (id: string, input: { name?: string; description?: string; version: number }) =>
        c.request('PATCH', ws(id), { body: input, schema: z.object({ workspace: workspaceSchema }) }),
      /** Owner or super admin. `memberId` is the membership id of the new owner; the previous owner becomes admin. */
      transfer: (id: string, memberId: string, version: number) =>
        c.request('POST', `${ws(id)}/transfer`, {
          body: { member_id: memberId, version },
          schema: z.object({ workspace: workspaceSchema }),
        }),
      /** Any member except the owner. */
      leave: (id: string) => c.request('POST', `${ws(id)}/leave`, { schema: anyObjectSchema }),

      members: (id: string, p: ListParams) => list(`${ws(id)}/members`, memberSchema, { cursor: p.cursor, limit: p.limit }),
      setMemberRole: (id: string, memberId: string, role: WorkspaceRole, version: number) =>
        c.request('PATCH', `${ws(id)}/members/${enc(memberId)}`, {
          body: { role, version },
          schema: z.object({ member: memberSchema }),
        }),
      removeMember: (id: string, memberId: string) =>
        c.request('DELETE', `${ws(id)}/members/${enc(memberId)}`, { schema: anyObjectSchema }),

      addMember: (id: string, input: { email: string; role: WorkspaceRole }) =>
        c.request('POST', `${ws(id)}/members`, { body: input, schema: addMemberResponseSchema }),
      /** Emails added before they had an account (`pending`), newest first. */
      pendingInvites: (id: string, p: ListParams) =>
        list(`${ws(id)}/invites`, inviteSchema, { order: 'desc', cursor: p.cursor, limit: p.limit, status: 'pending' }),
      revokeInvite: (id: string, inviteId: string) =>
        c.request('DELETE', `${ws(id)}/invites/${enc(inviteId)}`, { schema: anyObjectSchema }),

      /** Live notes, metadata only. `q` filters by a path substring. */
      notes: (id: string, p: ListParams) =>
        list(`${ws(id)}/notes`, noteMetaSchema, { cursor: p.cursor, limit: p.limit, q: p.q }),
      note: (id: string, noteId: string) =>
        c.request('GET', `${ws(id)}/notes/${enc(noteId)}`, { schema: z.object({ note: noteSchema }) }),

      auditLogs: (id: string, p: ListParams & { action?: string }) =>
        list(`${ws(id)}/audit-logs`, auditLogSchema, { cursor: p.cursor, limit: p.limit, action: p.action, order: 'desc' }),
    },
  };
}

export type Api = ReturnType<typeof createApi>;

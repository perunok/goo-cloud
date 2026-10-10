/**
 * In-memory fake of the goo cloud API, installed as the client's `fetch` when VITE_MOCK_API=1.
 * It speaks the same HTTP contract (paths, CSRF, cursor pagination, error envelope) so the whole
 * dashboard - including the real client and zod schemas - runs against it.
 *
 * Demo accounts (password for all: `password-12345`):
 *   super@example.com   super_admin
 *   admin@example.com   platform_admin
 *   owner@example.com   user (owner of "Team notes")
 *   editor@example.com  user (editor in "Team notes")
 *   viewer@example.com  user (viewer in "Team notes")
 *   temp@example.com    user with must_change_password (lands on "Choose a new password")
 *
 * Desktop sign-in codes `ABCD-EFGH` and `WXYZ-2345` are pending and can be approved once each (Desktop sign-in page).
 *
 * Dev hooks on `window.__mock`: expireSession(), failNext(status, body?), latency(ms), reset(), healthDown(bool)
 * (GET /admin/health then answers 503 with postgres: down), touchWorkspace(id) (bumps its version, to provoke a settings
 * conflict), addDeviceCode(code).
 */
import type { HttpClient } from '../lib/api/client';

type Json = Record<string, unknown>;
type PlatformRole = 'super_admin' | 'platform_admin' | 'user';
type WsRole = 'owner' | 'admin' | 'editor' | 'viewer';
interface U { disabled?: boolean; must_change_password?: boolean; id: string; email: string; display_name: string; platform_role: PlatformRole; password: string; created_at: string; updated_at: string }
interface W { id: string; slug: string; name: string; description: string; owner_user_id: string; created_at: string; updated_at: string; version: number }
interface M { id: string; workspace_id: string; user_id: string; role: WsRole; status: 'active' | 'removed'; added_by_user_id: string | null; joined_at: string; created_at: string; updated_at: string; version: number }
interface I { id: string; workspace_id: string; email: string; role: WsRole; status: string; invited_by_user_id: string | null; created_at: string; updated_at: string; version: number }
interface N { id: string; workspace_id: string; path: string; content: string; version: number; created_at: string; updated_at: string; updated_by: string | null }
interface D { id: string; user_id: string; device_name: string; platform: string; app_version: string; created_at: string; last_seen_at: string }
interface A { id: string; workspace_id: string | null; actor_user_id: string; actor_email: string; action: string; resource_type: string; resource_id: string; request_id: string; details: Json; created_at: string }

const PASSWORD = 'password-12345';
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
let seq = 1;
const uid = () => `0197c1f6-4b54-7d2a-a86f-${String(seq++).padStart(12, '0')}`;
const RANK: Record<WsRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

interface Db { users: U[]; workspaces: W[]; members: M[]; invites: I[]; notes: N[]; devices: D[]; codes: Set<string>; audit: A[] }

const SAMPLE_NOTE = `# Release plan

The **next release** ships on Friday. Everything below is synced from goo.

## Checklist

- [x] Merge the sync engine
- [ ] Write the changelog
- [ ] Tag \`v0.5.0\`

| Area | Owner | Status |
| :--- | :---: | ---: |
| Sync | Eddie | done |
| Docs | Olive | in progress |

> Notes are read-only in the dashboard: edit them in goo.

\`\`\`sh
npm run build
\`\`\`

Links: [goo on GitHub](https://github.com/perunok/goo), <https://example.com>, and a [relative link](other.md).

<script>alert('this stays text')</script>
`;

function seed(): Db {
  seq = 1;
  const users: U[] = [
    { id: uid(), email: 'super@example.com', display_name: 'Sam Super', platform_role: 'super_admin', password: PASSWORD, created_at: iso(90000), updated_at: iso(90000) },
    { id: uid(), email: 'admin@example.com', display_name: 'Ada Admin', platform_role: 'platform_admin', password: PASSWORD, created_at: iso(80000), updated_at: iso(80000) },
    { id: uid(), email: 'owner@example.com', display_name: 'Olive Owner', platform_role: 'user', password: PASSWORD, created_at: iso(70000), updated_at: iso(70000) },
    { id: uid(), email: 'editor@example.com', display_name: 'Eddie Editor', platform_role: 'user', password: PASSWORD, created_at: iso(60000), updated_at: iso(60000) },
    { id: uid(), email: 'viewer@example.com', display_name: 'Vic Viewer', platform_role: 'user', password: PASSWORD, created_at: iso(58000), updated_at: iso(58000) },
  ];
  users.push({ id: uid(), email: 'temp@example.com', display_name: 'Tia Temporary', platform_role: 'user', password: PASSWORD, must_change_password: true, created_at: iso(55000), updated_at: iso(55000) });
  for (let n = 1; n <= 41; n++) {
    users.push({ id: uid(), email: `person${n}@example.com`, display_name: `Person ${n}`, platform_role: 'user', password: PASSWORD, created_at: iso(50000 - n * 100), updated_at: iso(50000 - n * 100) });
  }
  const [sup, , owner, editor, viewer] = users as [U, U, U, U, U];
  const names = ['Team notes', 'Recipes', 'Research', 'Journal', 'Handbook'];
  const workspaces: W[] = [];
  for (let n = 0; n < 26; n++) {
    const name = n < names.length ? names[n]! : `Workspace ${n + 1}`;
    workspaces.push({
      id: uid(), slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, description: `${name} folder`,
      owner_user_id: n === 0 ? owner.id : sup.id, created_at: iso(40000 - n * 500), updated_at: iso(40000 - n * 500), version: 1,
    });
  }
  const members: M[] = [];
  const addMember = (w: W, u: U, role: WsRole) =>
    members.push({ id: uid(), workspace_id: w.id, user_id: u.id, role, status: 'active', added_by_user_id: role === 'owner' ? null : w.owner_user_id, joined_at: iso(30000), created_at: iso(30000), updated_at: iso(30000), version: 1 });
  const team = workspaces[0]!;
  addMember(team, owner, 'owner');
  addMember(team, editor, 'editor');
  addMember(team, viewer, 'viewer');
  users.slice(6, 30).forEach((u, i) => addMember(team, u, (['viewer', 'editor', 'admin'] as const)[i % 3]!));
  workspaces.slice(1).forEach((w) => addMember(w, sup, 'owner'));

  const invites: I[] = [];
  // People added before they had an account; they join when the account is created.
  for (let n = 1; n <= 3; n++) {
    invites.push({ id: uid(), workspace_id: team.id, email: `newhire${n}@example.com`, role: (['viewer', 'editor', 'admin'] as const)[n % 3]!, status: 'pending', invited_by_user_id: team.owner_user_id, created_at: iso(2000 - n * 10), updated_at: iso(2000 - n * 10), version: 1 });
  }

  const notes: N[] = [];
  const note = (w: W, path: string, content: string, minsAgo: number, by: U) =>
    notes.push({ id: crypto.randomUUID(), workspace_id: w.id, path, content, version: 1 + (minsAgo % 5), created_at: iso(minsAgo + 5000), updated_at: iso(minsAgo), updated_by: by.id });
  note(team, 'release-plan.md', SAMPLE_NOTE, 30, editor);
  note(team, 'inbox.md', '# Inbox\n\n- call Ann\n- buy milk\n', 90, owner);
  note(team, 'projects/sync/design.md', '# Sync design\n\nPull, then push. Never discard local work.\n', 400, owner);
  for (let n = 1; n <= 30; n++) note(team, `meetings/2026-${String(1 + (n % 12)).padStart(2, '0')}-${String(n).padStart(2, '0')}.md`, `# Meeting ${n}\n\nAttendees: Olive, Eddie.\n`, 1000 + n * 60, n % 2 ? owner : editor);
  note(workspaces[1]!, 'soup.md', '# Soup\n\n1. Boil water\n2. Add things\n', 200, sup);

  const devices: D[] = [];
  for (const u of [sup, owner, editor]) {
    devices.push({ id: uid(), user_id: u.id, device_name: `${u.display_name.split(' ')[0]}'s laptop`, platform: 'linux', app_version: '0.5.0', created_at: iso(20000), last_seen_at: iso(15) });
    devices.push({ id: uid(), user_id: u.id, device_name: 'Work desktop', platform: 'windows', app_version: '0.4.2', created_at: iso(30000), last_seen_at: iso(4000) });
  }

  const actions = ['member.added', 'member.role_changed', 'member.removed', 'workspace.updated', 'invite.created', 'auth.login'];
  const audit: A[] = [];
  for (let n = 0; n < 47; n++) {
    const wsId = n % 3 === 0 ? team.id : workspaces[1 + (n % 5)]!.id;
    audit.push({ id: uid(), workspace_id: wsId, actor_user_id: sup.id, actor_email: sup.email, action: actions[n % actions.length]!, resource_type: 'membership', resource_id: users[5 + (n % 20)]!.id, request_id: `req-${n}`, details: n % 2 ? { to: 'editor' } : {}, created_at: iso(n * 37) });
  }
  return { users, workspaces, members, invites, notes, devices, codes: new Set(['ABCD-EFGH', 'WXYZ-2345']), audit };
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Json = {}) { super(message); }
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

export function installMockApi(client: HttpClient) {
  let db = seed();
  let sessionUser: string | null = null;
  let csrf: string | null = null;
  let latency = 120;
  let failNext: { status: number; body?: string } | null = null;
  let dbDown = false;

  const now = () => new Date().toISOString();
  const ctl = {
    expireSession() { sessionUser = null; csrf = null; },
    failNext(status: number, body?: string) { failNext = { status, body }; },
    latency(ms: number) { latency = ms; },
    reset() { db = seed(); sessionUser = null; csrf = null; dbDown = false; },
    healthDown(v = true) { dbDown = v; },
    touchWorkspace(id: string) { const w = db.workspaces.find((x) => x.id === id); if (w) { w.version += 1; w.updated_at = now(); } },
    addDeviceCode(code: string) { db.codes.add(code.toUpperCase()); },
  };
  (window as unknown as { __mock: typeof ctl }).__mock = ctl;

  const me = () => db.users.find((u) => u.id === sessionUser) ?? null;
  const isAdmin = (u: U | null) => !!u && u.platform_role !== 'user';
  const pub = (u: U) => ({ id: u.id, email: u.email, display_name: u.display_name, platform_role: u.platform_role, must_change_password: !!u.must_change_password });
  const adminPub = (u: U) => ({ ...pub(u), disabled: !!u.disabled, created_at: u.created_at, updated_at: u.updated_at });
  const memberView = (m: M) => {
    const mu = db.users.find((x) => x.id === m.user_id)!;
    const { added_by_user_id: _, ...rest } = m;
    return { ...rest, email: mu.email, display_name: mu.display_name };
  };
  const author = (id: string | null) => {
    const u = id ? db.users.find((x) => x.id === id) : undefined;
    return u ? { id: u.id, display_name: u.display_name } : null;
  };
  const noteMeta = (n: N) => ({ id: n.id, workspace_id: n.workspace_id, path: n.path, version: n.version, size: bytes(n.content), created_at: n.created_at, updated_at: n.updated_at, updated_by: author(n.updated_by) });
  const audit = (workspace_id: string | null, action: string, resource_type: string, resource_id: string, details: Json = {}) => {
    const u = me()!;
    db.audit.unshift({ id: uid(), workspace_id, actor_user_id: u.id, actor_email: u.email, action, resource_type, resource_id, request_id: crypto.randomUUID(), details, created_at: now() });
  };

  /** Like the server: ordered by (created_at, id), ascending unless `order=desc`; opaque cursors. */
  function paginate<T extends { id: string; created_at?: string }>(items: T[], params: URLSearchParams) {
    const sorted = [...items].sort((x, y) => (x.created_at ?? '').localeCompare(y.created_at ?? '') || x.id.localeCompare(y.id));
    if (params.get('order') === 'desc') sorted.reverse();
    const limit = Math.min(Number(params.get('limit') ?? 20) || 20, 100);
    const start = params.get('cursor') ? Number(atob(params.get('cursor')!)) : 0;
    const slice = sorted.slice(start, start + limit);
    const has_more = start + limit < sorted.length;
    return { items: slice, page: { next_cursor: has_more ? btoa(String(start + limit)) : null, has_more } };
  }
  const activeMember = (wid: string, userId: string) => db.members.find((m) => m.workspace_id === wid && m.user_id === userId && m.status === 'active');
  const roleOf = (wid: string, u: U) => activeMember(wid, u.id)?.role ?? null;
  function requireWs(id: string, u: U) {
    const w = db.workspaces.find((x) => x.id === id);
    const role = w ? roleOf(id, u) : null;
    if (!w || (!isAdmin(u) && !role)) throw new HttpError(403, 'workspace_access_denied', 'you do not have access to this workspace');
    return { w, role };
  }
  const atLeast = (u: U, role: WsRole | null, min: WsRole) => isAdmin(u) || (!!role && RANK[role] >= RANK[min]);

  async function handle(method: string, path: string, params: URLSearchParams, body: Json, headers: Headers): Promise<{ status: number; json?: unknown }> {
    if (method === 'POST' && path === '/auth/browser/login') {
      const u = db.users.find((x) => x.email.toLowerCase() === String(body.email ?? '').toLowerCase());
      if (!u || u.password !== body.password || u.disabled) throw new HttpError(401, 'unauthenticated', 'invalid email or password');
      sessionUser = u.id;
      csrf = `csrf-${Math.random().toString(36).slice(2)}`;
      return { status: 200, json: { user: pub(u), csrf_token: csrf } };
    }
    if (method === 'GET' && path === '/auth/browser/session') {
      const u = me();
      if (!u) throw new HttpError(401, 'unauthenticated', 'authentication required');
      return { status: 200, json: { user: pub(u), csrf_token: csrf } };
    }
    const u = me();
    if (!u) throw new HttpError(401, 'unauthenticated', 'authentication required');
    if (method !== 'GET' && headers.get('X-CSRF-Token') !== csrf) throw new HttpError(403, 'csrf_invalid', 'Missing or invalid CSRF token.');
    if (method === 'POST' && path === '/auth/browser/logout') { sessionUser = null; csrf = null; return { status: 200, json: { ok: true } }; }
    if (method === 'GET' && path === '/me') return { status: 200, json: { user: pub(u), workspace_memberships: [] } };
    if (method === 'POST' && path === '/me/password') {
      const next = String(body.new_password ?? '');
      if (body.current_password !== u.password) throw new HttpError(403, 'forbidden', 'current password is incorrect', { reason: 'invalid_current_password' });
      if (next.length < 12) throw new HttpError(400, 'invalid_request', 'request validation failed', { issues: [{ path: 'new_password', message: 'password must be at least 12 characters' }] });
      if (next === u.password) throw new HttpError(400, 'invalid_request', 'request validation failed', { issues: [{ path: 'new_password', message: 'the new password must differ from the current one' }] });
      u.password = next; u.must_change_password = false; u.updated_at = now();
      audit(null, 'user.password_changed', 'user', u.id, { via: 'cookie' });
      return { status: 200, json: { ok: true } };
    }
    // Like the server: an admin-issued password must be replaced before anything else works.
    if (u.must_change_password) throw new HttpError(403, 'password_change_required', 'You must choose a new password before continuing (POST /v1/me/password).');

    if (method === 'POST' && path === '/auth/device/approve') {
      const code = String(body.user_code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const normalized = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
      if (!db.codes.delete(normalized)) throw new HttpError(404, 'not_found', 'device login request not found or expired');
      audit(null, 'auth.device_approved', 'user', u.id, { via: 'dashboard', client_name: 'goo', device_name: 'mock device' });
      db.devices.unshift({ id: uid(), user_id: u.id, device_name: 'New device', platform: 'macos', app_version: '0.5.0', created_at: now(), last_seen_at: now() });
      return { status: 200, json: { ok: true } };
    }
    if (method === 'GET' && path === '/me/devices') {
      return { status: 200, json: paginate(db.devices.filter((d) => d.user_id === u.id), params) };
    }
    const dm = path.match(/^\/me\/devices\/([^/]+)$/);
    if (method === 'DELETE' && dm) {
      const d = db.devices.find((x) => x.id === dm[1] && x.user_id === u.id);
      if (!d) throw new HttpError(404, 'not_found', 'device not found');
      db.devices = db.devices.filter((x) => x !== d);
      audit(null, 'device.signed_out', 'device', d.id, { device_name: d.device_name, platform: d.platform });
      return { status: 200, json: { ok: true } };
    }

    // ---- admin ----
    if (path.startsWith('/admin/')) {
      if (!isAdmin(u)) throw new HttpError(403, 'forbidden', 'Platform admin access required.');
      if (method === 'GET' && path === '/admin/health') {
        return { status: dbDown ? 503 : 200, json: { status: dbDown ? 'degraded' : 'ok', services: { api: 'ok', postgres: dbDown ? 'down' : 'ok' }, timestamp: now() } };
      }
      if (method === 'GET' && path === '/admin/stats') {
        return { status: 200, json: { users: db.users.length, platform_admins: db.users.filter((x) => x.platform_role !== 'user').length, disabled_users: db.users.filter((x) => x.disabled).length, workspaces: db.workspaces.length, memberships: db.members.filter((m) => m.status === 'active').length, pending_invites: db.invites.filter((i) => i.status === 'pending').length, notes: db.notes.length, devices: db.devices.length, active_sessions: 1, audit_logs: db.audit.length } };
      }
      if (method === 'GET' && path === '/admin/users') {
        const q = (params.get('q') ?? '').toLowerCase();
        return { status: 200, json: paginate(db.users.filter((x) => !q || x.email.includes(q) || x.display_name.toLowerCase().includes(q)).map(adminPub), params) };
      }
      if (method === 'POST' && path === '/admin/users') {
        const role = String(body.platform_role ?? 'user');
        const pw = body.password === undefined ? null : String(body.password);
        if (pw !== null && pw.length < 12) throw new HttpError(400, 'invalid_request', 'request validation failed', { issues: [{ path: 'password', message: 'password must be at least 12 characters' }] });
        if (role !== 'user' && u.platform_role !== 'super_admin') throw new HttpError(403, 'forbidden', 'creating platform admins requires the super_admin role');
        if (db.users.some((x) => x.email.toLowerCase() === String(body.email).toLowerCase())) {
          throw new HttpError(409, 'conflict', 'a resource with these unique values already exists');
        }
        const tempPw = Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('');
        const mustChange = pw === null || body.must_change_password === true;
        const nu: U = { id: uid(), email: String(body.email), display_name: String(body.display_name), platform_role: role as PlatformRole, password: pw ?? tempPw, must_change_password: mustChange, created_at: now(), updated_at: now() };
        db.users.push(nu);
        audit(null, 'admin.user_created', 'user', nu.id, { email: nu.email, platform_role: role, password: pw === null ? 'generated' : 'set_by_admin' });
        // Like the server: pending additions for this email become memberships.
        for (const inv of db.invites.filter((i) => i.status === 'pending' && i.email.toLowerCase() === nu.email.toLowerCase())) {
          inv.status = 'accepted';
          db.members.push({ id: uid(), workspace_id: inv.workspace_id, user_id: nu.id, role: inv.role, status: 'active', added_by_user_id: inv.invited_by_user_id, joined_at: now(), created_at: now(), updated_at: now(), version: 1 });
        }
        return { status: 201, json: { user: adminPub(nu), temporary_password: pw === null ? tempPw : null } };
      }
      const um = path.match(/^\/admin\/users\/([^/]+)$/);
      if (method === 'PATCH' && um) {
        const t = db.users.find((x) => x.id === um[1]);
        if (!t) throw new HttpError(404, 'not_found', 'user not found');
        if (t.platform_role !== 'user' && u.platform_role !== 'super_admin') throw new HttpError(403, 'forbidden', 'modifying a platform admin requires the super_admin role');
        if (body.platform_role !== undefined) {
          if (u.platform_role !== 'super_admin') throw new HttpError(403, 'forbidden', 'changing platform roles requires the super_admin role');
          if (body.platform_role === 'super_admin') throw new HttpError(400, 'invalid_request', 'request validation failed', { issues: [{ path: 'platform_role', message: "Invalid enum value. Expected 'platform_admin' | 'user'" }] });
          if (t.platform_role === 'super_admin') throw new HttpError(403, 'forbidden', "the super admin's role cannot be changed");
          if (t.email === 'person7@example.com') throw new HttpError(500, 'internal_error', 'Simulated server failure (person7).', {});
          t.platform_role = body.platform_role as PlatformRole;
        }
        if (body.disabled === true && t.id === u.id) throw new HttpError(403, 'forbidden', 'you cannot disable your own account');
        if (body.disabled !== undefined) t.disabled = body.disabled === true;
        if (body.must_change_password !== undefined) t.must_change_password = body.must_change_password === true;
        t.updated_at = now();
        audit(null, body.platform_role !== undefined ? 'admin.user_role_changed' : 'admin.user_updated', 'user', t.id, { email: t.email, changes: body });
        return { status: 200, json: { user: adminPub(t) } };
      }
      const rp = path.match(/^\/admin\/users\/([^/]+)\/reset-password$/);
      if (method === 'POST' && rp) {
        const t = db.users.find((x) => x.id === rp[1]);
        if (!t) throw new HttpError(404, 'not_found', 'user not found');
        if (t.id === u.id) throw new HttpError(403, 'forbidden', 'use POST /v1/me/password to change your own password');
        if (t.platform_role !== 'user' && u.platform_role !== 'super_admin') throw new HttpError(403, 'forbidden', "resetting a platform admin's password requires the super_admin role");
        const tempPw = Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('');
        t.password = tempPw; t.must_change_password = true; t.updated_at = now();
        audit(null, 'admin.user_password_reset', 'user', t.id, { email: t.email });
        return { status: 200, json: { user: adminPub(t), temporary_password: tempPw } };
      }
      if (method === 'GET' && path === '/admin/workspaces') {
        const q = (params.get('q') ?? '').toLowerCase();
        const items = db.workspaces
          .filter((w) => !q || w.name.toLowerCase().includes(q) || w.slug.includes(q))
          .map((w) => ({ ...w, member_count: db.members.filter((m) => m.workspace_id === w.id && m.status === 'active').length }));
        return { status: 200, json: paginate(items, params) };
      }
      if (method === 'GET' && path === '/admin/audit-logs') {
        const a = params.get('action');
        return { status: 200, json: paginate(db.audit.filter((x) => !a || x.action === a), params) };
      }
    }

    // ---- workspaces ----
    if (method === 'GET' && path === '/workspaces') {
      const mine = db.workspaces.filter((w) => roleOf(w.id, u)).map((w) => {
        const m = activeMember(w.id, u.id)!;
        return { ...w, role: m.role, joined_at: m.joined_at, added_by: author(m.added_by_user_id) };
      });
      return { status: 200, json: paginate(mine, params) };
    }
    if (method === 'POST' && path === '/workspaces') {
      const name = String(body.name ?? '').trim();
      const slug = body.slug ? String(body.slug) : `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace'}-${Math.random().toString(16).slice(2, 6)}`;
      if (db.workspaces.some((w) => w.slug === slug)) throw new HttpError(409, 'conflict', 'a resource with these unique values already exists');
      const w: W = { id: uid(), slug, name, description: String(body.description ?? ''), owner_user_id: u.id, created_at: now(), updated_at: now(), version: 1 };
      db.workspaces.unshift(w);
      db.members.push({ id: uid(), workspace_id: w.id, user_id: u.id, role: 'owner', status: 'active', added_by_user_id: null, joined_at: now(), created_at: now(), updated_at: now(), version: 1 });
      audit(w.id, 'workspace.created', 'workspace', w.id, { slug });
      return { status: 201, json: { workspace: w } };
    }
    const wm = path.match(/^\/workspaces\/([^/]+)(?:\/(.*))?$/);
    if (wm) {
      const wid = wm[1]!;
      const rest = wm[2] ?? '';
      const { w, role } = requireWs(wid, u);
      if (rest === '' && method === 'GET') return { status: 200, json: { workspace: w, membership: role ? { role } : null } };
      if (rest === '' && method === 'DELETE') {
        if (u.platform_role !== 'super_admin' && role !== 'owner') throw new HttpError(403, 'workspace_access_denied', 'you do not have access to this workspace');
        db.workspaces = db.workspaces.filter((x) => x.id !== wid);
        db.notes = db.notes.filter((n) => n.workspace_id !== wid);
        audit(wid, 'workspace.deleted', 'workspace', wid, { name: w.name });
        return { status: 200, json: { ok: true } };
      }
      if (rest === '' && method === 'PATCH') {
        if (!isAdmin(u) && role !== 'owner') throw new HttpError(403, 'workspace_access_denied', 'you do not have access to this workspace');
        if (body.version !== w.version) throw new HttpError(409, 'version_mismatch', 'resource was modified by someone else; refetch and retry', { current_version: w.version });
        if (typeof body.name === 'string') w.name = body.name;
        if (typeof body.description === 'string') w.description = body.description;
        w.version += 1; w.updated_at = now();
        audit(wid, 'workspace.updated', 'workspace', wid, { fields: Object.keys(body).filter((k) => k !== 'version') });
        return { status: 200, json: { workspace: w } };
      }
      if (rest === 'transfer' && method === 'POST') {
        if (u.platform_role !== 'super_admin' && role !== 'owner') throw new HttpError(403, 'workspace_access_denied', 'you do not have access to this workspace');
        if (body.version !== w.version) throw new HttpError(409, 'version_mismatch', 'resource was modified by someone else; refetch and retry', { current_version: w.version });
        const target = db.members.find((m) => m.id === body.member_id && m.workspace_id === wid && m.status === 'active');
        if (!target) throw new HttpError(404, 'not_found', 'member not found');
        const prev = activeMember(wid, w.owner_user_id);
        if (prev) { prev.role = 'admin'; prev.version += 1; }
        target.role = 'owner'; target.version += 1;
        audit(wid, 'workspace.ownership_transferred', 'workspace', wid, { from_user_id: w.owner_user_id, to_user_id: target.user_id });
        w.owner_user_id = target.user_id; w.version += 1; w.updated_at = now();
        return { status: 200, json: { workspace: w } };
      }
      if (rest === 'leave' && method === 'POST') {
        const m = activeMember(wid, u.id);
        if (!m) throw new HttpError(403, 'workspace_access_denied', 'you do not have access to this workspace');
        if (m.role === 'owner') throw new HttpError(403, 'forbidden', 'the owner cannot leave; transfer ownership or delete the workspace');
        m.status = 'removed'; m.version += 1;
        audit(wid, 'member.left', 'membership', m.id, { role: m.role });
        return { status: 200, json: { ok: true } };
      }
      if (rest === 'notes' && method === 'GET') {
        const q = (params.get('q') ?? '').toLowerCase();
        const items = db.notes.filter((n) => n.workspace_id === wid && (!q || n.path.toLowerCase().includes(q))).map(noteMeta);
        return { status: 200, json: paginate(items, params) };
      }
      const nm = rest.match(/^notes\/([^/]+)$/);
      if (nm && method === 'GET') {
        const n = db.notes.find((x) => x.id === nm[1] && x.workspace_id === wid);
        if (!n) throw new HttpError(404, 'not_found', 'note not found');
        return { status: 200, json: { note: { ...noteMeta(n), content: n.content, content_hash: 'mock' } } };
      }
      if (rest === 'members' && method === 'POST') {
        if (!atLeast(u, role, 'admin')) throw new HttpError(403, 'workspace_access_denied', 'you do not have access to this workspace');
        const grant = String(body.role) as WsRole;
        if (!isAdmin(u) && RANK[grant] > RANK[role!]) throw new HttpError(403, 'forbidden', 'you cannot grant a role above your own');
        const email = String(body.email).trim().toLowerCase();
        const target = db.users.find((x) => x.email.toLowerCase() === email);
        if (target) {
          if (activeMember(wid, target.id)) throw new HttpError(409, 'conflict', 'that user is already a member');
          const m: M = { id: uid(), workspace_id: wid, user_id: target.id, role: grant, status: 'active', added_by_user_id: u.id, joined_at: now(), created_at: now(), updated_at: now(), version: 1 };
          db.members.push(m);
          audit(wid, 'member.added', 'membership', m.id, { email, role: m.role });
          return { status: 201, json: { status: 'added', member: memberView(m) } };
        }
        if (db.invites.some((i) => i.workspace_id === wid && i.status === 'pending' && i.email.toLowerCase() === email)) throw new HttpError(409, 'conflict', 'that email is already pending; it joins when its account is created');
        const inv: I = { id: uid(), workspace_id: wid, email, role: grant, status: 'pending', invited_by_user_id: u.id, created_at: now(), updated_at: now(), version: 1 };
        db.invites.push(inv);
        audit(wid, 'invite.created', 'invite', inv.id, { email, role: inv.role });
        return { status: 201, json: { status: 'pending', invite: inv } };
      }
      if (rest === 'members' && method === 'GET') {
        const items = db.members.filter((m) => m.workspace_id === wid && m.status === 'active').map(memberView);
        return { status: 200, json: paginate(items, params) };
      }
      const mm = rest.match(/^members\/([^/]+)$/);
      if (mm && (method === 'PATCH' || method === 'DELETE')) {
        if (!atLeast(u, role, 'admin')) throw new HttpError(403, 'workspace_access_denied', 'you do not have access to this workspace');
        const m = db.members.find((x) => x.id === mm[1] && x.workspace_id === wid && x.status === 'active');
        if (!m) throw new HttpError(404, 'not_found', 'member not found');
        if (m.role === 'owner') throw new HttpError(403, 'forbidden', `the workspace owner cannot be ${method === 'PATCH' ? 'changed' : 'removed'}`);
        if (!isAdmin(u) && role !== 'owner' && RANK[m.role] >= RANK[role!]) throw new HttpError(403, 'forbidden', 'you can only manage members below your own role');
        if (method === 'PATCH') {
          if (body.version !== m.version) throw new HttpError(409, 'version_mismatch', 'resource was modified by someone else; refetch and retry', { current_version: m.version });
          if (m.user_id === db.users.find((x) => x.email === 'person5@example.com')?.id) throw new HttpError(500, 'internal_error', 'Simulated server failure (person5).');
          const grant = String(body.role) as WsRole;
          if (!isAdmin(u) && RANK[grant] > RANK[role!]) throw new HttpError(403, 'forbidden', 'you cannot grant a role above your own');
          audit(wid, 'member.role_changed', 'membership', m.id, { from: m.role, to: grant });
          m.role = grant; m.version += 1; m.updated_at = now();
          return { status: 200, json: { member: memberView(m) } };
        }
        m.status = 'removed'; m.version += 1;
        audit(wid, 'member.removed', 'membership', m.id, { role: m.role });
        return { status: 200, json: { ok: true } };
      }
      if (rest === 'invites' && method === 'GET') {
        if (!atLeast(u, role, 'admin')) throw new HttpError(403, 'workspace_access_denied', 'you do not have access to this workspace');
        const st = params.get('status');
        return { status: 200, json: paginate(db.invites.filter((i) => i.workspace_id === wid && (!st || i.status === st)), params) };
      }
      const im = rest.match(/^invites\/([^/]+)$/);
      if (im && method === 'DELETE') {
        if (!atLeast(u, role, 'admin')) throw new HttpError(403, 'workspace_access_denied', 'you do not have access to this workspace');
        const inv = db.invites.find((x) => x.id === im[1] && x.workspace_id === wid && x.status === 'pending');
        if (!inv) throw new HttpError(404, 'not_found', 'invite not found');
        inv.status = 'revoked'; inv.version += 1;
        audit(wid, 'invite.revoked', 'invite', inv.id);
        return { status: 200, json: { invite: inv } };
      }
      if (rest === 'audit-logs' && method === 'GET') {
        if (!atLeast(u, role, 'admin')) throw new HttpError(403, 'workspace_access_denied', 'you do not have access to this workspace');
        const a = params.get('action');
        return { status: 200, json: paginate(db.audit.filter((x) => x.workspace_id === wid && (!a || x.action === a)), params) };
      }
    }
    throw new HttpError(404, 'not_found', `No mock route for ${method} ${path}`);
  }

  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    const path = url.pathname.replace(/^.*?\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : {};
    await new Promise((r) => setTimeout(r, latency));

    if (failNext) {
      const f = failNext;
      failNext = null;
      return new Response(f.body ?? '<html><body><h1>502 Bad Gateway</h1></body></html>', { status: f.status, headers: { 'Content-Type': f.body?.startsWith('{') ? 'application/json' : 'text/html' } });
    }
    const requestId = crypto.randomUUID();
    try {
      const r = await handle(method, path, url.searchParams, body, headers);
      return new Response(r.status === 204 ? null : JSON.stringify(r.json), { status: r.status, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId } });
    } catch (e) {
      if (e instanceof HttpError) {
        return new Response(JSON.stringify({ error: { code: e.code, message: e.message, details: e.details, request_id: requestId } }), { status: e.status, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId } });
      }
      throw e;
    }
  };
  client.configure({ fetch: mockFetch });
}

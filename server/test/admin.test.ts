import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { PASSWORD, call, createUser, makeApp, makeNote, setupWorkspace, uniq, type TestUser } from "./helpers.js";

let app: FastifyInstance;
let sa: TestUser;
let pa: TestUser;
beforeAll(async () => {
  app = await makeApp();
  sa = await createUser("super_admin");
  pa = await createUser("platform_admin");
});
afterAll(async () => {
  await app.close();
});
const j = (r: { json: <T>() => T }) => r.json<any>();

describe("admin users", () => {
  it("lists users with filters and cursor pagination (platform admins only)", async () => {
    const plain = await createUser();
    expect((await call(app, { method: "GET", url: "/v1/admin/users", as: plain })).statusCode).toBe(403);
    expect((await call(app, { method: "GET", url: "/v1/admin/users" })).statusCode).toBe(401);
    const res = await call(app, { method: "GET", url: `/v1/admin/users?limit=2&q=${encodeURIComponent(plain.email.slice(0, 8))}`, as: pa });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/password_hash|passwordHash|argon2|"password"/);
    const page1 = j(await call(app, { method: "GET", url: "/v1/admin/users?limit=2", as: pa }));
    expect(page1.items).toHaveLength(2);
    expect(page1.page.has_more).toBe(true);
    const page2 = j(await call(app, { method: "GET", url: `/v1/admin/users?limit=2&cursor=${page1.page.next_cursor}`, as: pa }));
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
    expect(j(await call(app, { method: "GET", url: "/v1/admin/users?platform_role=super_admin", as: pa })).items.every((u: { platform_role: string }) => u.platform_role === "super_admin")).toBe(true);
  });

  it("platform_admin may onboard normal users (temporary password, can log in) but not admins; super_admin may", async () => {
    const email = `${uniq("new")}@example.test`;
    const created = await call(app, { method: "POST", url: "/v1/admin/users", as: pa, body: { email, display_name: "New User" } });
    expect(created.statusCode).toBe(201);
    const tmp = j(created).temporary_password as string;
    expect(tmp.length).toBeGreaterThanOrEqual(16);
    expect(j(created).user).toMatchObject({ email, platform_role: "user", disabled: false });
    const login = await call(app, { method: "POST", url: "/v1/auth/browser/login", body: { email, password: tmp } });
    expect(login.statusCode).toBe(200);

    const denied = await call(app, { method: "POST", url: "/v1/admin/users", as: pa, body: { email: `${uniq()}@x.test`, display_name: "A", platform_role: "platform_admin" } });
    expect(denied.statusCode).toBe(403);
    const ok = await call(app, { method: "POST", url: "/v1/admin/users", as: sa, body: { email: `${uniq()}@x.test`, display_name: "A", platform_role: "platform_admin", password: "A-long-enough-password" } });
    expect(ok.statusCode).toBe(201);
    expect(j(ok)).toMatchObject({ user: { platform_role: "platform_admin" }, temporary_password: null });
    expect((await call(app, { method: "POST", url: "/v1/admin/users", as: sa, body: { email: `${uniq()}@x.test`, display_name: "S", platform_role: "super_admin" } })).statusCode).toBe(400);
    expect((await call(app, { method: "POST", url: "/v1/admin/users", as: sa, body: { email, display_name: "dup" } })).statusCode).toBe(409);
    expect((await call(app, { method: "POST", url: "/v1/admin/users", as: sa, body: { email: `${uniq()}@x.test`, display_name: "w", password: "short" } })).statusCode).toBe(400);
    // audit trail
    const logs = j(await call(app, { method: "GET", url: "/v1/admin/audit-logs?action=admin.user_created&order=desc&limit=5", as: pa }));
    expect(logs.items.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(logs)).not.toContain(tmp);
  });

  it("role changes need super_admin; the super admin is protected; disabling revokes access", async () => {
    const target = await createUser();
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${target.id}`, as: pa, body: { platform_role: "platform_admin" } })).statusCode).toBe(403);
    const promoted = await call(app, { method: "PATCH", url: `/v1/admin/users/${target.id}`, as: sa, body: { platform_role: "platform_admin" } });
    expect(j(promoted).user.platform_role).toBe("platform_admin");
    expect((await call(app, { method: "GET", url: "/v1/admin/stats", as: target })).statusCode).toBe(200); // role is read fresh from the DB, not the token
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${target.id}`, as: pa, body: { display_name: "x" } })).statusCode).toBe(403); // pa can't edit admins
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${sa.id}`, as: sa, body: { platform_role: "user" } })).statusCode).toBe(403);
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${sa.id}`, as: sa, body: { disabled: true } })).statusCode).toBe(403);
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${sa.id}`, as: pa, body: { display_name: "hax" } })).statusCode).toBe(403);
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/nope`, as: sa, body: { display_name: "x" } })).statusCode).toBe(404);

    const victim = await createUser();
    const login = await call(app, { method: "POST", url: "/v1/auth/browser/login", body: { email: victim.email, password: PASSWORD } });
    const cookie = { goo_session: login.cookies[0]!.value };
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${victim.id}`, as: pa, body: { disabled: true } })).statusCode).toBe(200);
    expect((await call(app, { method: "GET", url: "/v1/me", cookies: cookie })).statusCode).toBe(401);
    expect((await call(app, { method: "GET", url: "/v1/me", as: victim })).statusCode).toBe(401);
    expect(await prisma.session.count({ where: { userId: victim.id } })).toBe(0);
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${victim.id}`, as: pa, body: { disabled: false } })).statusCode).toBe(200);
    // re-enabling does not resurrect access tokens issued before the disable (tokenVersion was bumped)
    expect((await call(app, { method: "GET", url: "/v1/me", as: victim })).statusCode).toBe(401);
    const roleLog = j(await call(app, { method: "GET", url: "/v1/admin/audit-logs?action=admin.user_role_changed&order=desc&limit=1", as: sa })).items[0];
    expect(roleLog).toMatchObject({ actor_user_id: sa.id, resource_id: target.id });
  });
});

describe("disabling a user", () => {
  it("rejects the disabled user's existing dashboard session, access token AND refresh tokens; re-enabling does not resurrect them", async () => {
    const victim = await createUser();
    // desktop-style credentials via the device flow (yields a real access + refresh token pair)
    const start = j(await call(app, { method: "POST", url: "/v1/auth/device/start", body: { client_name: "goo-desktop", device_name: "Laptop" } }));
    await call(app, { method: "POST", url: "/v1/auth/device/approve", as: victim, body: { user_code: start.user_code } });
    const tokens = j(await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: start.device_code } }));
    expect(tokens.status).toBe("approved");
    const bearer = { token: tokens.access_token as string };
    const login = await call(app, { method: "POST", url: "/v1/auth/browser/login", body: { email: victim.email, password: PASSWORD } });
    const cookie = { goo_session: login.cookies[0]!.value };
    expect((await call(app, { method: "GET", url: "/v1/me", as: bearer })).statusCode).toBe(200);
    expect((await call(app, { method: "GET", url: "/v1/auth/browser/session", cookies: cookie })).statusCode).toBe(200);

    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${victim.id}`, as: pa, body: { disabled: true } })).statusCode).toBe(200);
    expect(j(await call(app, { method: "GET", url: `/v1/admin/users?q=${encodeURIComponent(victim.email)}`, as: pa })).items[0]).toMatchObject({ disabled: true });

    expect((await call(app, { method: "GET", url: "/v1/me", as: bearer })).statusCode).toBe(401);
    expect((await call(app, { method: "GET", url: "/v1/auth/browser/session", cookies: cookie })).statusCode).toBe(401);
    const refresh = await call(app, { method: "POST", url: "/v1/auth/refresh", body: { refresh_token: tokens.refresh_token } });
    expect(refresh.statusCode).toBe(401);
    expect(await prisma.refreshToken.count({ where: { userId: victim.id, revokedAt: null } })).toBe(0);
    expect((await call(app, { method: "POST", url: "/v1/auth/browser/login", body: { email: victim.email, password: PASSWORD } })).statusCode).toBe(401);
    // a pending device flow approved before the disable cannot be turned into tokens either
    const start2 = j(await call(app, { method: "POST", url: "/v1/auth/device/start", body: { client_name: "goo-desktop", device_name: "Laptop" } }));
    const flow = await prisma.deviceFlow.findFirstOrThrow({ where: { userCode: start2.user_code } });
    await prisma.deviceFlow.update({ where: { id: flow.id }, data: { status: "approved", userId: victim.id } });
    expect(j(await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: start2.device_code } })).status).toBe("expired");

    // enabling again lets the user sign in anew, but the old credentials stay dead
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${victim.id}`, as: pa, body: { disabled: false } })).statusCode).toBe(200);
    expect((await call(app, { method: "POST", url: "/v1/auth/refresh", body: { refresh_token: tokens.refresh_token } })).statusCode).toBe(401);
    expect((await call(app, { method: "GET", url: "/v1/auth/browser/session", cookies: cookie })).statusCode).toBe(401);
    expect((await call(app, { method: "POST", url: "/v1/auth/browser/login", body: { email: victim.email, password: PASSWORD } })).statusCode).toBe(200);
  });

  it("nobody can disable themselves; only the super admin can disable platform admins; the super admin cannot be disabled", async () => {
    const admin = await createUser("platform_admin");
    const plain = await createUser();
    const self = await call(app, { method: "PATCH", url: `/v1/admin/users/${admin.id}`, as: admin, body: { disabled: true } });
    expect(self.statusCode).toBe(403); // platform_admin modifying an admin (itself) needs super_admin
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${pa.id}`, as: pa, body: { disabled: true } })).statusCode).toBe(403);
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${admin.id}`, as: sa, body: { disabled: true } })).statusCode).toBe(200);
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${admin.id}`, as: sa, body: { disabled: false } })).statusCode).toBe(200);
    const saSelf = await call(app, { method: "PATCH", url: `/v1/admin/users/${sa.id}`, as: sa, body: { disabled: true } });
    expect(saSelf.statusCode).toBe(403);
    expect(saSelf.json().error.message).toMatch(/cannot disable your own account/);
    expect((await call(app, { method: "PATCH", url: `/v1/admin/users/${sa.id}`, as: pa, body: { disabled: true } })).statusCode).toBe(403);
    expect((await call(app, { method: "GET", url: "/v1/me", as: sa })).statusCode).toBe(200);
    expect(plain.id).toBeTruthy();
  });
});

describe("admin workspaces, audit logs, health, stats", () => {
  it("lists/inspects workspaces, super_admin deletes one and the deletion is audited", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const name = (await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } })).name;
    const list = j(await call(app, { method: "GET", url: `/v1/admin/workspaces?q=${encodeURIComponent(name)}`, as: pa }));
    expect(list.items.find((w: { id: string }) => w.id === ws.id)).toMatchObject({ member_count: 1 });
    await makeNote(app, owner, ws.id, "a.md", "12345");
    const one = await call(app, { method: "GET", url: `/v1/admin/workspaces/${ws.id}`, as: pa });
    expect(j(one)).toMatchObject({
      owner: { id: owner.id, email: owner.email }, counts: { members: 1, pending_invites: 0, notes: 1, note_bytes: 5, checkpoint: 1 }
    });
    expect((await call(app, { method: "GET", url: `/v1/admin/workspaces/${owner.id}`, as: pa })).statusCode).toBe(404);
    expect((await call(app, { method: "DELETE", url: `/v1/admin/workspaces/${ws.id}`, as: pa })).statusCode).toBe(403);
    expect((await call(app, { method: "DELETE", url: `/v1/admin/workspaces/${ws.id}`, as: sa })).statusCode).toBe(200);
    expect((await call(app, { method: "DELETE", url: `/v1/admin/workspaces/${ws.id}`, as: sa })).statusCode).toBe(404);
    const logs = j(await call(app, { method: "GET", url: `/v1/admin/audit-logs?workspace_id=${ws.id}`, as: sa }));
    // note changes are not audited, workspace events are
    expect(logs.items.map((l: { action: string }) => l.action)).toEqual(["workspace.created", "admin.workspace_deleted"]);
    expect(await prisma.note.count({ where: { workspaceId: ws.id } })).toBe(0); // notes went with the workspace
    expect(logs.items[1]).toMatchObject({ actor_user_id: sa.id, details: { owner_user_id: owner.id } });
  });

  it("health pings the database; stats returns counters", async () => {
    const h = await call(app, { method: "GET", url: "/v1/admin/health", as: pa });
    expect(j(h)).toMatchObject({ status: "ok", services: { api: "ok", postgres: "ok" } });
    const s = j(await call(app, { method: "GET", url: "/v1/admin/stats", as: pa }));
    expect(s.users).toBeGreaterThan(0);
    expect(s.workspaces).toBeGreaterThan(0);
    expect(Object.keys(s).sort()).toEqual([
      "active_sessions", "audit_logs", "devices", "disabled_users", "memberships", "notes", "pending_invites", "platform_admins", "users", "workspaces"
    ]);
    for (const v of Object.values(s)) expect(typeof v).toBe("number");
    expect((await call(app, { method: "GET", url: "/v1/admin/health", as: await createUser() })).statusCode).toBe(403);
  });

  it("health answers 503 WITH the per-service body when the database ping fails (the dashboard renders it)", async () => {
    // Authentication uses regular Prisma queries, so only the `SELECT 1` probe is made to fail here.
    // (`mockRestore` would break the Prisma client proxy, so the spy stays installed and just delegates afterwards.)
    const spy = vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("connection refused"));
    const h = await call(app, { method: "GET", url: "/v1/admin/health", as: pa });
    expect(h.statusCode).toBe(503);
    expect(j(h)).toMatchObject({ status: "degraded", services: { api: "ok", postgres: "down" } });
    expect(new Date(j(h).timestamp).getTime()).not.toBeNaN();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await call(app, { method: "GET", url: "/v1/admin/health", as: pa })).statusCode).toBe(200);
  });
});

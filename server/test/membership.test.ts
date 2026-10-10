import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { PASSWORD, call, createUser, makeApp, setupWorkspace, uniq } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp();
});
afterAll(async () => {
  await app.close();
});

describe("adding members", () => {
  const add = (as: { token: string }, wsId: string, email: string, role = "editor") =>
    call(app, { method: "POST", url: `/v1/workspaces/${wsId}/members`, as, body: { email, role } });
  const mine = async (as: { token: string }) => (await call(app, { method: "GET", url: "/v1/workspaces", as })).json().items as any[];

  it("adds an existing account at once: it is in their workspace list with who added them, no token involved", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const member = await createUser("user", `${uniq("m")}@example.test`);
    const res = await add(owner, ws.id, member.email.toUpperCase(), "editor");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "added", member: { user_id: member.id, role: "editor", status: "active" } });
    expect(JSON.stringify(res.json())).not.toMatch(/token/);

    const listed = (await mine(member)).find((w) => w.id === ws.id);
    expect(listed).toMatchObject({ role: "editor", added_by: { id: owner.id, display_name: `User ${owner.email}` } });
    expect(Date.parse(listed.joined_at)).toBeGreaterThan(Date.now() - 60_000);
    expect((await mine(owner)).find((w) => w.id === ws.id).added_by).toBeNull(); // the creator was not added by anyone
    expect((await call(app, { method: "GET", url: `/v1/workspaces/${ws.id}`, as: member })).statusCode).toBe(200);
    expect(await prisma.auditLog.count({ where: { workspaceId: ws.id, action: "member.added" } })).toBe(1);
  });

  it("an email without an account stays pending (no token, no expiry) and joins when the admin creates the account", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const email = `${uniq("later")}@example.test`;
    const res = await add(owner, ws.id, email, "viewer");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "pending", invite: { email, role: "viewer", status: "pending" } });
    const row = await prisma.invite.findUniqueOrThrow({ where: { id: res.json().invite.id } });
    const pending = await call(app, { method: "GET", url: `/v1/workspaces/${ws.id}/invites?status=pending`, as: owner });
    expect(pending.json().items.map((i: any) => i.email)).toEqual([email]);

    const pa = await createUser("platform_admin");
    const created = await call(app, { method: "POST", url: "/v1/admin/users", as: pa, body: { email, display_name: "Later" } });
    expect(created.statusCode).toBe(201);
    const userId = created.json().user.id;
    expect(await prisma.membership.count({ where: { workspaceId: ws.id, userId, status: "active", role: "viewer", addedByUserId: owner.id } })).toBe(1);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("accepted");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { workspaceId: ws.id, action: "invite.accepted" } });
    expect(audit).toMatchObject({ actorUserId: userId, details: { role: "viewer", via: "account_created" } });
  });

  it("signing in (dashboard or desktop) claims pending additions; not cancelled ones", async () => {
    const owner = await createUser();
    const ws1 = await setupWorkspace(app, owner);
    const ws2 = await setupWorkspace(app, owner);
    const email = `${uniq("si")}@example.test`;
    await add(owner, ws1.id, email, "editor");
    const revoked = (await add(owner, ws2.id, email, "editor")).json().invite;
    const cancel = await call(app, { method: "DELETE", url: `/v1/workspaces/${ws2.id}/invites/${revoked.id}`, as: owner });
    expect(cancel.json().invite.status).toBe("revoked");
    expect((await call(app, { method: "DELETE", url: `/v1/workspaces/${ws2.id}/invites/${revoked.id}`, as: owner })).statusCode).toBe(409);

    // the account appears some other way (e.g. created directly in the database), then signs in to the dashboard
    const u = await createUser("user", email);
    const login = await call(app, { method: "POST", url: "/v1/auth/browser/login", body: { email, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    expect((await mine(u)).map((w) => w.id)).toEqual([ws1.id]);
    expect((await mine(u)).find((w) => w.id === ws1.id).added_by.id).toBe(owner.id);

    // desktop device sign-in claims as well
    const ws3 = await setupWorkspace(app, owner);
    await prisma.invite.create({ data: { id: uniq("inv"), workspaceId: ws3.id, email, role: "editor", invitedByUserId: owner.id } });
    const d = (await call(app, { method: "POST", url: "/v1/auth/device/start", body: { client_name: "goo-desktop", device_name: "Box" } })).json();
    await call(app, { method: "POST", url: "/v1/auth/device/approve", as: u, body: { user_code: d.user_code } });
    expect((await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: d.device_code } })).json().status).toBe("approved");
    expect((await mine(u)).map((w) => w.id)).toContain(ws3.id);
  });

  it("re-adding a removed member reactivates them with the new role and adder", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const m = await createUser();
    const first = (await add(owner, ws.id, m.email, "viewer")).json().member;
    expect((await call(app, { method: "DELETE", url: `/v1/workspaces/${ws.id}/members/${first.id}`, as: owner })).statusCode).toBe(200);
    expect((await mine(m)).some((w) => w.id === ws.id)).toBe(false);
    const again = await add(owner, ws.id, m.email, "editor");
    expect(again.json()).toMatchObject({ status: "added", member: { id: first.id, role: "editor", status: "active" } });
    expect((await mine(m)).find((w) => w.id === ws.id)).toMatchObject({ role: "editor", added_by: { id: owner.id } });
  });

  it("rejects invalid emails/roles, duplicates and existing members; owner role cannot be granted", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    expect((await add(owner, ws.id, "not-an-email", "viewer")).statusCode).toBe(400);
    expect((await add(owner, ws.id, "a@b.test", "owner")).statusCode).toBe(400);
    expect((await add(owner, ws.id, "a@b.test", "superuser")).statusCode).toBe(400);
    const dup = `${uniq("dup")}@b.test`;
    expect((await add(owner, ws.id, dup, "viewer")).statusCode).toBe(201);
    expect((await add(owner, ws.id, dup.toUpperCase(), "viewer")).statusCode).toBe(409);
    expect((await add(owner, ws.id, owner.email, "viewer")).statusCode).toBe(409); // already a member
    const m = await createUser();
    expect((await add(owner, ws.id, m.email)).statusCode).toBe(201);
    expect((await add(owner, ws.id, m.email)).json().error.code).toBe("conflict");
  });

  it("there are no token invite or join-request routes", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    expect((await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/invites`, as: owner, body: { email: "a@b.test", role: "viewer" } })).statusCode).toBe(404);
    expect((await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/join-requests`, as: owner, body: {} })).statusCode).toBe(404);
  });
});

describe("members", () => {
  it("owner changes a role (with version) and removes a member; the owner is immutable", async () => {
    const owner = await createUser();
    const member = await createUser();
    const ws = await setupWorkspace(app, owner, [{ user: member, role: "viewer" }]);
    const base = `/v1/workspaces/${ws.id}`;
    const members = (await call(app, { method: "GET", url: `${base}/members`, as: owner })).json().items;
    const m = members.find((x: { user_id: string }) => x.user_id === member.id);
    const o = members.find((x: { user_id: string }) => x.user_id === owner.id);

    expect((await call(app, { method: "PATCH", url: `${base}/members/${m.id}`, as: owner, body: { role: "editor", version: 99 } })).json().error.code).toBe("version_mismatch");
    const ok = await call(app, { method: "PATCH", url: `${base}/members/${m.id}`, as: owner, body: { role: "editor", version: m.version } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().member).toMatchObject({ role: "editor", version: m.version + 1 });
    expect((await call(app, { method: "PATCH", url: `${base}/members/${m.id}`, as: owner, body: { role: "owner", version: 2 } })).statusCode).toBe(400);
    expect((await call(app, { method: "PATCH", url: `${base}/members/${o.id}`, as: owner, body: { role: "viewer", version: o.version } })).statusCode).toBe(403);
    expect((await call(app, { method: "DELETE", url: `${base}/members/${o.id}`, as: owner })).statusCode).toBe(403);

    expect((await call(app, { method: "DELETE", url: `${base}/members/${m.id}`, as: owner })).statusCode).toBe(200);
    expect((await call(app, { method: "GET", url: base, as: member })).statusCode).toBe(403); // access gone immediately
    expect((await call(app, { method: "GET", url: `${base}/members`, as: owner })).json().items).toHaveLength(1);
    // removed members can be added again and come back active
    expect((await call(app, { method: "POST", url: `${base}/members`, as: owner, body: { email: member.email, role: "viewer" } })).json().status).toBe("added");
    expect((await call(app, { method: "GET", url: base, as: member })).statusCode).toBe(200);
  });

  it("a workspace admin manages editors and viewers only, and grants at most admin", async () => {
    const owner = await createUser();
    const admin = await createUser();
    const admin2 = await createUser();
    const editor = await createUser();
    const ws = await setupWorkspace(app, owner, [{ user: admin, role: "admin" }, { user: admin2, role: "admin" }, { user: editor, role: "editor" }]);
    const base = `/v1/workspaces/${ws.id}`;
    const members = (await call(app, { method: "GET", url: `${base}/members`, as: admin })).json().items;
    const by = (u: { id: string }) => members.find((x: { user_id: string }) => x.user_id === u.id);
    const [o, a2, e] = [by(owner), by(admin2), by(editor)];

    // down to viewer and back up to admin
    const down = await call(app, { method: "PATCH", url: `${base}/members/${e.id}`, as: admin, body: { role: "viewer", version: e.version } });
    expect(down.statusCode).toBe(200);
    const up = await call(app, { method: "PATCH", url: `${base}/members/${e.id}`, as: admin, body: { role: "admin", version: e.version + 1 } });
    expect(up.json().member.role).toBe("admin");
    // now an admin: out of reach for the other admin, like admin2 and the owner
    for (const target of [e, a2, o]) {
      const r = await call(app, { method: "PATCH", url: `${base}/members/${target.id}`, as: admin, body: { role: "viewer", version: target.version + (target === e ? 2 : 0) } });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe("forbidden");
      expect((await call(app, { method: "DELETE", url: `${base}/members/${target.id}`, as: admin })).statusCode).toBe(403);
    }
    // the owner may change and remove admins
    expect((await call(app, { method: "PATCH", url: `${base}/members/${a2.id}`, as: owner, body: { role: "editor", version: a2.version } })).statusCode).toBe(200);
    expect((await call(app, { method: "DELETE", url: `${base}/members/${a2.id}`, as: admin })).statusCode).toBe(200); // an editor now
    // an editor cannot manage anyone
    expect((await call(app, { method: "DELETE", url: `${base}/members/${by(admin).id}`, as: editor })).statusCode).toBe(403);
  });

  it("members can leave (access ends at once); the owner cannot", async () => {
    const owner = await createUser();
    const member = await createUser();
    const ws = await setupWorkspace(app, owner, [{ user: member, role: "editor" }]);
    const base = `/v1/workspaces/${ws.id}`;
    const left = await call(app, { method: "POST", url: `${base}/leave`, as: member, body: {} });
    expect(left.statusCode).toBe(200);
    expect((await call(app, { method: "GET", url: base, as: member })).statusCode).toBe(403);
    expect((await call(app, { method: "POST", url: `${base}/leave`, as: member, body: {} })).statusCode).toBe(403);
    const ownerLeave = await call(app, { method: "POST", url: `${base}/leave`, as: owner, body: {} });
    expect(ownerLeave.statusCode).toBe(403);
    expect(ownerLeave.json().error.message).toMatch(/transfer ownership/);
    // a platform admin who is not a member has nothing to leave
    expect((await call(app, { method: "POST", url: `${base}/leave`, as: await createUser("platform_admin"), body: {} })).statusCode).toBe(403);
    expect(await prisma.auditLog.count({ where: { workspaceId: ws.id, action: "member.left", actorUserId: member.id } })).toBe(1);
  });

  it("the owner transfers ownership to a member and stays as admin", async () => {
    const owner = await createUser();
    const next = await createUser();
    const ws = await setupWorkspace(app, owner, [{ user: next, role: "editor" }]);
    const base = `/v1/workspaces/${ws.id}`;
    const members = (await call(app, { method: "GET", url: `${base}/members`, as: owner })).json().items;
    const n = members.find((x: { user_id: string }) => x.user_id === next.id);
    const o = members.find((x: { user_id: string }) => x.user_id === owner.id);

    expect((await call(app, { method: "POST", url: `${base}/transfer`, as: next, body: { member_id: n.id, version: ws.version } })).statusCode).toBe(403);
    expect((await call(app, { method: "POST", url: `${base}/transfer`, as: owner, body: { member_id: n.id, version: 99 } })).json().error.code).toBe("version_mismatch");
    expect((await call(app, { method: "POST", url: `${base}/transfer`, as: owner, body: { member_id: o.id, version: ws.version } })).statusCode).toBe(400);
    expect((await call(app, { method: "POST", url: `${base}/transfer`, as: owner, body: { member_id: "nope", version: ws.version } })).statusCode).toBe(404);
    const t = await call(app, { method: "POST", url: `${base}/transfer`, as: owner, body: { member_id: n.id, version: ws.version } });
    expect(t.statusCode).toBe(200);
    expect(t.json().workspace).toMatchObject({ owner_user_id: next.id, version: ws.version + 1 });
    const roles = Object.fromEntries((await call(app, { method: "GET", url: `${base}/members`, as: next })).json().items.map((m: any) => [m.user_id, m.role]));
    expect(roles).toEqual({ [owner.id]: "admin", [next.id]: "owner" });
    // the new owner renames; the old one no longer can, and can now leave
    expect((await call(app, { method: "PATCH", url: base, as: next, body: { name: "Mine now", version: ws.version + 1 } })).statusCode).toBe(200);
    expect((await call(app, { method: "PATCH", url: base, as: owner, body: { name: "x", version: ws.version + 2 } })).statusCode).toBe(403);
    expect((await call(app, { method: "POST", url: `${base}/leave`, as: owner, body: {} })).statusCode).toBe(200);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { workspaceId: ws.id, action: "workspace.ownership_transferred" } });
    expect(audit.details).toEqual({ from_user_id: owner.id, to_user_id: next.id });
  });
});

describe("audit logs", () => {
  it("records every workspace-admin-level mutation with actor, request id and no secrets", async () => {
    const owner = await createUser();
    const member = await createUser();
    const ws = await setupWorkspace(app, owner);
    const base = `/v1/workspaces/${ws.id}`;
    await call(app, { method: "POST", url: `${base}/members`, as: owner, body: { email: member.email, role: "viewer" } });
    const m = (await call(app, { method: "GET", url: `${base}/members`, as: owner })).json().items.find((x: { user_id: string }) => x.user_id === member.id);
    await call(app, { method: "PATCH", url: `${base}/members/${m.id}`, as: owner, body: { role: "editor", version: m.version } });
    await call(app, { method: "PATCH", url: base, as: owner, body: { name: "Renamed", version: ws.version } });
    const pending = (await call(app, { method: "POST", url: `${base}/members`, as: owner, body: { email: `${uniq("p")}@x.test`, role: "viewer" } })).json().invite;
    await call(app, { method: "DELETE", url: `${base}/invites/${pending.id}`, as: owner });
    await call(app, { method: "DELETE", url: `${base}/members/${m.id}`, as: owner, headers: { "x-request-id": "audit-req-1" } });

    const logs = (await call(app, { method: "GET", url: `${base}/audit-logs?limit=100`, as: owner })).json();
    const actions = logs.items.map((l: { action: string }) => l.action);
    expect(actions).toEqual([
      "workspace.created", "member.added", "member.role_changed", "workspace.updated",
      "invite.created", "invite.revoked", "member.removed"
    ]);
    expect(logs.items[0].actor_user_id).toBe(owner.id);
    expect(logs.items[0].actor_email).toBe(owner.email);
    expect(logs.items[6].request_id).toBe("audit-req-1");
    expect(logs.items[1].details).toMatchObject({ email: member.email, role: "viewer" });
    expect(logs.items[2].details).toMatchObject({ from: "viewer", to: "editor", user_id: member.id });

    // filterable + newest-first
    const desc = (await call(app, { method: "GET", url: `${base}/audit-logs?order=desc&limit=2`, as: owner })).json();
    expect(desc.items.map((l: { action: string }) => l.action)).toEqual(["member.removed", "invite.revoked"]);
    expect(desc.page.has_more).toBe(true);
    const only = (await call(app, { method: "GET", url: `${base}/audit-logs?action=member.added`, as: owner })).json();
    expect(only.items).toHaveLength(1);
  });

  it("audit log rows are only writable through the API's own mutations (no write endpoint exists)", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    const r = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/audit-logs`, as: owner, body: { action: "x" } });
    expect(r.statusCode).toBe(404);
  });
});

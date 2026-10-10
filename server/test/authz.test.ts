import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/db.js";
import { call, change, createUser, makeApp, makeNote, push, registerClient, setupWorkspace, uniq } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp();
});
afterAll(async () => {
  await app.close();
});

describe("workspace Owner (not a platform admin)", () => {
  it("adds members, pushes notes, and is blocked from platform-admin routes", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);

    const added = await call(app, { method: "POST", url: `/v1/workspaces/${ws.id}/members`, as: owner, body: { email: "someone@example.test", role: "editor" } });
    expect(added.statusCode).toBe(201);
    const note = await makeNote(app, owner, ws.id);
    expect((await call(app, { method: "GET", url: `/v1/workspaces/${ws.id}/notes/${note.id}`, as: owner })).statusCode).toBe(200);

    for (const url of ["/v1/admin/users", "/v1/admin/workspaces", "/v1/admin/audit-logs", "/v1/admin/health", "/v1/admin/stats"]) {
      const r = await call(app, { method: "GET", url, as: owner });
      expect(r.statusCode, url).toBe(403);
      expect(r.json().error.code).toBe("forbidden");
    }
    expect((await call(app, { method: "POST", url: "/v1/admin/users", as: owner, body: { email: `${uniq()}@x.test`, display_name: "x" } })).statusCode).toBe(403);
  });
});

describe("authorization matrix", () => {
  it("viewer: reads notes and pulls, but every write is refused (push changes rejected `forbidden`, nothing written)", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const ws = await setupWorkspace(app, owner, [{ user: viewer, role: "viewer" }]);
    const note = await makeNote(app, owner, ws.id);
    const base = `/v1/workspaces/${ws.id}`;

    for (const url of [`${base}`, `${base}/members`, `${base}/notes`, `${base}/notes/${note.id}`]) {
      expect((await call(app, { method: "GET", url, as: viewer })).statusCode, url).toBe(200);
    }
    const client = await registerClient(app, viewer);
    expect((await call(app, { method: "GET", url: `${base}/sync/pull?client_id=${client}`, as: viewer })).statusCode).toBe(200);

    const sneaky = await push(app, viewer, ws.id, client, [
      change({ note_id: randomUUID(), path: "sneaky.md", content: "x" }),
      change({ note_id: note.id, op: "delete", base_version: 1 })
    ]);
    expect(sneaky.statusCode).toBe(200);
    expect(sneaky.json().accepted).toEqual([]);
    expect(sneaky.json().rejected.map((r: { reason: string }) => r.reason)).toEqual(["forbidden", "forbidden"]);
    expect(await prisma.note.count({ where: { workspaceId: ws.id } })).toBe(1);
    expect(await prisma.note.findFirst({ where: { workspaceId: ws.id, id: note.id } })).toMatchObject({ deleted: false, version: 1 });

    const writes: Array<[string, string, unknown]> = [
      ["POST", `${base}/members`, { email: "a@b.test", role: "viewer" }],
      ["GET", `${base}/invites`, undefined],
      ["GET", `${base}/audit-logs`, undefined],
      ["PATCH", `${base}`, { name: "x", version: 1 }],
      ["POST", `${base}/transfer`, { member_id: "x", version: 1 }],
      ["DELETE", `${base}`, undefined]
    ];
    for (const [method, url, body] of writes) {
      const r = await call(app, { method: method as "POST", url, as: viewer, body });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().error.code).toBe("workspace_access_denied");
    }
  });

  it("editor: pushes notes, but cannot manage membership or the workspace", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const ws = await setupWorkspace(app, owner, [{ user: editor, role: "editor" }]);
    const base = `/v1/workspaces/${ws.id}`;
    await makeNote(app, editor, ws.id);
    for (const [method, url, body] of [
      ["POST", `${base}/members`, { email: "a@b.test", role: "viewer" }],
      ["GET", `${base}/invites`, undefined],
      ["GET", `${base}/audit-logs`, undefined],
      ["PATCH", `${base}`, { name: "x", version: 1 }],
      ["DELETE", `${base}`, undefined]
    ] as const) {
      expect((await call(app, { method, url, as: editor, body })).statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("admin: manages members but cannot rename, transfer or delete the workspace", async () => {
    const owner = await createUser();
    const admin = await createUser();
    const ws = await setupWorkspace(app, owner, [{ user: admin, role: "admin" }]);
    const base = `/v1/workspaces/${ws.id}`;
    expect((await call(app, { method: "POST", url: `${base}/members`, as: admin, body: { email: `${uniq()}@x.test`, role: "viewer" } })).statusCode).toBe(201);
    expect((await call(app, { method: "GET", url: `${base}/audit-logs`, as: admin })).statusCode).toBe(200);
    await makeNote(app, admin, ws.id);
    expect((await call(app, { method: "PATCH", url: base, as: admin, body: { name: "x", version: ws.version } })).statusCode).toBe(403);
    expect((await call(app, { method: "POST", url: `${base}/transfer`, as: admin, body: { member_id: "x", version: ws.version } })).statusCode).toBe(403);
    expect((await call(app, { method: "DELETE", url: base, as: admin })).statusCode).toBe(403);
  });

  it("non-members get 403 for every workspace route (and the same answer for nonexistent workspaces)", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const ws = await setupWorkspace(app, owner);
    const note = await makeNote(app, owner, ws.id);
    const client = await registerClient(app, stranger);
    const fakeId = "00000000-0000-7000-8000-00000000dead";
    for (const id of [ws.id, fakeId]) {
      for (const [method, url, body] of [
        ["GET", `/v1/workspaces/${id}`, undefined],
        ["GET", `/v1/workspaces/${id}/notes`, undefined],
        ["GET", `/v1/workspaces/${id}/notes/${note.id}`, undefined],
        ["GET", `/v1/workspaces/${id}/sync/pull?client_id=${client}`, undefined],
        ["POST", `/v1/workspaces/${id}/sync/push`, { client_id: client, changes: [change({ note_id: note.id, base_version: 1, content: "pwned" })] }],
        ["POST", `/v1/workspaces/${id}/leave`, {}]
      ] as const) {
        const r = await call(app, { method, url, as: stranger, body });
        expect(r.statusCode, `${method} ${url}`).toBe(403);
        expect(r.json().error.code).toBe("workspace_access_denied");
      }
    }
    expect((await prisma.note.findFirstOrThrow({ where: { workspaceId: ws.id, id: note.id } })).content).toBe("hello");
    const list = await call(app, { method: "GET", url: "/v1/workspaces", as: stranger });
    expect(list.json().items).toEqual([]);
  });

  it("platform_admin bypasses workspace membership, but cannot delete a workspace (super_admin/owner only)", async () => {
    const owner = await createUser();
    const pa = await createUser("platform_admin");
    const sa = await createUser("super_admin");
    const ws = await setupWorkspace(app, owner);
    const base = `/v1/workspaces/${ws.id}`;
    expect((await call(app, { method: "GET", url: base, as: pa })).json().membership).toBeNull();
    const note = await makeNote(app, pa, ws.id);
    expect((await call(app, { method: "GET", url: `${base}/notes/${note.id}`, as: pa })).statusCode).toBe(200);
    expect((await call(app, { method: "POST", url: `${base}/members`, as: pa, body: { email: `${uniq()}@x.test`, role: "viewer" } })).statusCode).toBe(201);
    expect((await call(app, { method: "DELETE", url: base, as: pa })).statusCode).toBe(403);
    expect((await call(app, { method: "DELETE", url: `/v1/admin/workspaces/${ws.id}`, as: pa })).statusCode).toBe(403);
    expect((await call(app, { method: "DELETE", url: base, as: sa })).statusCode).toBe(200);
    expect(await prisma.workspace.count({ where: { id: ws.id } })).toBe(0);
  });

  it("owner can delete their workspace; the audit trail survives the deletion", async () => {
    const owner = await createUser();
    const ws = await setupWorkspace(app, owner);
    expect((await call(app, { method: "DELETE", url: `/v1/workspaces/${ws.id}`, as: owner })).statusCode).toBe(200);
    const logs = await prisma.auditLog.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["workspace.created", "workspace.deleted"]);
  });
});

describe("cross-workspace IDOR", () => {
  it("a member of A gets 404 for B's notes and members addressed through A's URL; B's data is untouched", async () => {
    const ownerA = await createUser();
    const ownerB = await createUser();
    const wsA = await setupWorkspace(app, ownerA);
    const wsB = await setupWorkspace(app, ownerB);
    const bNote = await makeNote(app, ownerB, wsB.id, "secret.md", "B private");
    const a = `/v1/workspaces/${wsA.id}`;

    const get = await call(app, { method: "GET", url: `${a}/notes/${bNote.id}`, as: ownerA });
    expect(get.statusCode).toBe(404);
    expect(get.json().error.code).toBe("not_found");
    expect((await call(app, { method: "GET", url: `${a}/notes`, as: ownerA })).json().items).toEqual([]);

    // pushing B's note id through A: an edit is not_found, a delete is not_found, a "new" note lives in A only
    const client = await registerClient(app, ownerA);
    const r = (await push(app, ownerA, wsA.id, client, [
      change({ note_id: bNote.id, base_version: 1, content: "hijack" }),
      change({ note_id: bNote.id, op: "delete", base_version: 1 }),
      change({ note_id: bNote.id, base_version: 0, path: "secret.md", content: "mine" })
    ])).json();
    expect(r.rejected.map((x: { reason: string; current: unknown }) => [x.reason, x.current])).toEqual([["not_found", null], ["not_found", null]]);
    expect(r.accepted).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain("B private");
    expect(await prisma.note.findFirst({ where: { workspaceId: wsB.id, id: bNote.id } })).toMatchObject({ content: "B private", version: 1, deleted: false });
    expect(await prisma.note.findFirst({ where: { workspaceId: wsA.id, id: bNote.id } })).toMatchObject({ content: "mine", version: 1 });

    // B's member / invite ids through A's URL (A's owner can manage members) are 404 as well
    const bMember = await prisma.membership.findFirstOrThrow({ where: { workspaceId: wsB.id } });
    expect((await call(app, { method: "PATCH", url: `${a}/members/${bMember.id}`, as: ownerA, body: { role: "viewer", version: 1 } })).statusCode).toBe(404);
    expect((await call(app, { method: "DELETE", url: `${a}/members/${bMember.id}`, as: ownerA })).statusCode).toBe(404);
    expect((await call(app, { method: "POST", url: `${a}/transfer`, as: ownerA, body: { member_id: bMember.id, version: wsA.version } })).statusCode).toBe(404);
    const bInvite = (await call(app, { method: "POST", url: `/v1/workspaces/${wsB.id}/members`, as: ownerB, body: { email: `${uniq()}@x.test`, role: "viewer" } })).json().invite;
    expect((await call(app, { method: "DELETE", url: `${a}/invites/${bInvite.id}`, as: ownerA })).statusCode).toBe(404);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: bInvite.id } })).status).toBe("pending");
  });

  it("a device id belongs to its user: someone else cannot push or pull with it", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const ws = await setupWorkspace(app, owner, [{ user: editor, role: "editor" }]);
    const ownersClient = await registerClient(app, owner);
    const r = await push(app, editor, ws.id, ownersClient, []);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("invalid_request");
    expect((await call(app, { method: "GET", url: `/v1/workspaces/${ws.id}/sync/pull?client_id=${ownersClient}`, as: editor })).statusCode).toBe(400);
    expect((await call(app, { method: "DELETE", url: `/v1/me/devices/${ownersClient}`, as: editor })).statusCode).toBe(404);
  });
});

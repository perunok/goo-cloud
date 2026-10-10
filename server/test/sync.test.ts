import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../src/db.js";
import { pathKey, pathProblem } from "../src/services/sync.js";
import { call, change, createUser, makeApp, push, registerClient, setupWorkspace, uniq, type TestUser } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp();
});
afterAll(async () => {
  await app.close();
});

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const MiB = 1024 * 1024;

/** A workspace with an owner and a registered device, plus small helpers bound to them. */
async function setup() {
  const owner = await createUser();
  const ws = await setupWorkspace(app, owner);
  const client = await registerClient(app, owner);
  const send = async (changes: unknown[], as: TestUser = owner, clientId = client) => {
    const r = await push(app, as, ws.id, clientId, changes);
    expect(r.statusCode, r.body.slice(0, 500)).toBe(200);
    return r.json();
  };
  const pull = async (after = 0, limit?: number, as: TestUser = owner, clientId = client) => {
    const r = await call(app, {
      method: "GET", url: `/v1/workspaces/${ws.id}/sync/pull?client_id=${clientId}&after=${after}${limit ? `&limit=${limit}` : ""}`, as
    });
    expect(r.statusCode, r.body.slice(0, 500)).toBe(200);
    return r.json();
  };
  /** Creates a note and returns its id. */
  const create = async (path: string, content = "text") => {
    const id = randomUUID();
    const r = await send([change({ note_id: id, path, content })]);
    expect(r.rejected).toEqual([]);
    return id;
  };
  const row = (id: string) => prisma.note.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId: ws.id, id } } });
  return { owner, ws, client, send, pull, create, row };
}

describe("device registration", () => {
  it("registers a device and lists it under /v1/me/devices", async () => {
    const u = await createUser();
    const res = await call(app, {
      method: "POST", url: "/v1/sync/clients/register", as: u, body: { device_name: "Work laptop", platform: "macos", app_version: "0.4.0" }
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ client_id: expect.any(String), protocol_version: 1, features: [] });
    const devices = (await call(app, { method: "GET", url: "/v1/me/devices", as: u })).json();
    expect(devices.items).toEqual([
      { id: res.json().client_id, device_name: "Work laptop", platform: "macos", app_version: "0.4.0", created_at: expect.any(String), last_seen_at: expect.any(String) }
    ]);
    expect((await call(app, { method: "POST", url: "/v1/sync/clients/register", body: {} })).statusCode).toBe(401);
    expect((await call(app, { method: "POST", url: "/v1/sync/clients/register", as: u, body: { device_name: "x" } })).statusCode).toBe(400);
  });

  it("signing a device out revokes the refresh tokens of the sign-in it registered with, and its client id", async () => {
    const u = await createUser();
    const ws = await setupWorkspace(app, u);
    const sign = async (device: string) => {
      const d = (await call(app, { method: "POST", url: "/v1/auth/device/start", body: { client_name: "goo-desktop", device_name: device } })).json();
      await call(app, { method: "POST", url: "/v1/auth/device/approve", as: u, body: { user_code: d.user_code } });
      return (await call(app, { method: "POST", url: "/v1/auth/device/poll", body: { device_code: d.device_code } })).json();
    };
    const laptop = await sign("Laptop");
    const desktop = await sign("Desktop");
    const laptopClient = await registerClient(app, { token: laptop.access_token }, "Laptop");
    const desktopClient = await registerClient(app, { token: desktop.access_token }, "Desktop");
    // the laptop rotates once: the family survives rotation
    const rotated = (await call(app, { method: "POST", url: "/v1/auth/refresh", body: { refresh_token: laptop.refresh_token } })).json();

    const out = await call(app, { method: "DELETE", url: `/v1/me/devices/${laptopClient}`, as: { token: desktop.access_token } });
    expect(out.statusCode).toBe(200);
    expect((await call(app, { method: "POST", url: "/v1/auth/refresh", body: { refresh_token: rotated.refresh_token } })).statusCode).toBe(401);
    expect((await call(app, { method: "POST", url: "/v1/auth/refresh", body: { refresh_token: desktop.refresh_token } })).statusCode).toBe(200);
    const r = await push(app, { token: rotated.access_token }, ws.id, laptopClient, []);
    expect(r.statusCode).toBe(400); // the client id is gone
    expect((await call(app, { method: "GET", url: "/v1/me/devices", as: u })).json().items.map((d: { id: string }) => d.id)).toEqual([desktopClient]);
    expect(await prisma.auditLog.count({ where: { action: "device.signed_out", resourceId: laptopClient } })).toBe(1);
    expect((await call(app, { method: "DELETE", url: `/v1/me/devices/${laptopClient}`, as: u })).statusCode).toBe(404);
  });
});

describe("push: create, update, rename, delete, revive", () => {
  it("creates a note (version 1, server-side hash) and pull returns it", async () => {
    const s = await setup();
    const id = randomUUID();
    const r = await s.send([change({ note_id: id, path: "projects/plan.md", content: "# Plan\n" })]);
    expect(r).toEqual({ accepted: [{ op_id: expect.any(String), note_id: id, version: 1, seq: 1 }], rejected: [], checkpoint: 1 });
    expect(await s.row(id)).toMatchObject({
      path: "projects/plan.md", pathKey: "projects/plan.md", content: "# Plan\n", contentHash: sha("# Plan\n"), size: 7,
      version: 1, deleted: false, seq: 1, updatedById: s.owner.id, updatedByClientId: s.client
    });
    expect(await s.pull()).toEqual({
      changes: [{ note_id: id, path: "projects/plan.md", version: 1, deleted: false, content_hash: sha("# Plan\n"), content: "# Plan\n", seq: 1 }],
      checkpoint: 1, has_more: false
    });
    expect(await s.pull(1)).toEqual({ changes: [], checkpoint: 1, has_more: false });
  });

  it("partial upserts: content only keeps the path, path only (rename) keeps the content", async () => {
    const s = await setup();
    const id = await s.create("a.md", "one");
    const edit = await s.send([change({ note_id: id, base_version: 1, content: "two" })]);
    expect(edit.accepted[0]).toMatchObject({ version: 2, seq: 2 });
    expect(await s.row(id)).toMatchObject({ path: "a.md", content: "two", contentHash: sha("two") });
    const rename = await s.send([change({ note_id: id, base_version: 2, path: "folder/b.md" })]);
    expect(rename.accepted[0]).toMatchObject({ version: 3, seq: 3 });
    expect(await s.row(id)).toMatchObject({ path: "folder/b.md", pathKey: "folder/b.md", content: "two", version: 3 });
    const both = await s.send([change({ note_id: id, base_version: 3, path: "c.md", content: "three" })]);
    expect(both.accepted[0]).toMatchObject({ version: 4 });
    expect(await s.row(id)).toMatchObject({ path: "c.md", content: "three" });
  });

  it("an upsert that changes nothing is accepted without a new version or seq", async () => {
    const s = await setup();
    const id = await s.create("same.md", "same");
    const r = await s.send([change({ note_id: id, base_version: 1, content: "same" }), change({ note_id: id, base_version: 1 })]);
    expect(r.accepted.map((a: { version: number; seq: number }) => [a.version, a.seq])).toEqual([[1, 1], [1, 1]]);
    expect(r.checkpoint).toBe(1);
  });

  it("a case-only rename of the same note is allowed", async () => {
    const s = await setup();
    const id = await s.create("readme.md");
    expect((await s.send([change({ note_id: id, base_version: 1, path: "README.md" })])).accepted).toHaveLength(1);
    expect(await s.row(id)).toMatchObject({ path: "README.md", pathKey: "readme.md" });
  });

  it("delete leaves a tombstone (content cleared, new version and seq); pull after N delivers it, after=0 leaves it out", async () => {
    const s = await setup();
    const keep = await s.create("keep.md");
    const gone = await s.create("gone.md", "bye");
    const del = await s.send([change({ note_id: gone, op: "delete", base_version: 1 })]);
    expect(del.accepted[0]).toMatchObject({ note_id: gone, version: 2, seq: 3 });
    expect(await s.row(gone)).toMatchObject({ deleted: true, content: "", size: 0, version: 2, seq: 3, path: "gone.md" });

    const after = await s.pull(2);
    expect(after).toEqual({
      changes: [{ note_id: gone, path: "gone.md", version: 2, deleted: true, content_hash: null, content: null, seq: 3 }],
      checkpoint: 3, has_more: false
    });
    const initial = await s.pull(0);
    expect(initial.changes.map((c: { note_id: string }) => c.note_id)).toEqual([keep]);
    expect(initial.checkpoint).toBe(3); // the left-out tombstone is still covered
    // the dashboard no longer sees it
    expect((await call(app, { method: "GET", url: `/v1/workspaces/${s.ws.id}/notes/${gone}`, as: s.owner })).statusCode).toBe(404);
    // deleting a tombstone again (same base) is a no-op success; a stale base is a mismatch
    expect((await s.send([change({ note_id: gone, op: "delete", base_version: 2 })])).accepted[0]).toMatchObject({ version: 2, seq: 3 });
    expect((await s.send([change({ note_id: gone, op: "delete", base_version: 1 })])).rejected[0].reason).toBe("version_mismatch");
  });

  it("an upsert of a tombstone with its version revives it; a stale one gets version_mismatch with the tombstone state", async () => {
    const s = await setup();
    const id = await s.create("phoenix.md", "ash");
    await s.send([change({ note_id: id, op: "delete", base_version: 1 })]);
    const stale = await s.send([change({ note_id: id, base_version: 1, content: "late edit" })]);
    expect(stale.rejected[0]).toMatchObject({
      note_id: id, reason: "version_mismatch", current: { version: 2, path: "phoenix.md", deleted: true, content: null }
    });
    const revived = await s.send([change({ note_id: id, base_version: 2, content: "reborn" })]);
    expect(revived.accepted[0]).toMatchObject({ version: 3, seq: 3 });
    expect(await s.row(id)).toMatchObject({ deleted: false, path: "phoenix.md", content: "reborn", contentHash: sha("reborn") });
    expect((await s.pull(2)).changes[0]).toMatchObject({ deleted: false, content: "reborn", version: 3 });
  });

  it("seqs are gap-free and the push answer carries the workspace checkpoint", async () => {
    const s = await setup();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const r = await s.send([
      ...ids.map((id, i) => change({ note_id: id, path: `n${i}.md`, content: `${i}` })),
      change({ note_id: randomUUID(), base_version: 5, content: "x" }) // rejected: takes no seq
    ]);
    expect(r.accepted.map((a: { seq: number }) => a.seq)).toEqual([1, 2, 3]);
    expect(r.checkpoint).toBe(3);
    expect((await s.send([change({ note_id: ids[0], base_version: 1, content: "again" })])).accepted[0].seq).toBe(4);
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: s.ws.id } })).checkpoint).toBe(4);
  });

  it("concurrent pushes to one workspace get unique, contiguous seqs", async () => {
    const s = await setup();
    const other = await registerClient(app, s.owner, "Desktop");
    const batches = Array.from({ length: 6 }, (_, b) =>
      Array.from({ length: 5 }, (_, i) => change({ note_id: randomUUID(), path: `b${b}/n${i}.md`, content: `${b}-${i}` }))
    );
    const results = await Promise.all(batches.map((ch, i) => s.send(ch, s.owner, i % 2 ? other : s.client)));
    const seqs = results.flatMap((r) => r.accepted.map((a: { seq: number }) => a.seq)).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it("ignores unknown fields (the protocol grows additively) and accepts an empty push", async () => {
    const s = await setup();
    const r = await s.send([change({ note_id: randomUUID(), path: "x.md", content: "x", future_field: { a: 1 } })]);
    expect(r.accepted).toHaveLength(1);
    expect(await s.send([])).toEqual({ accepted: [], rejected: [], checkpoint: 1 });
  });
});

describe("push: idempotency by op_id", () => {
  it("a replayed change returns the same accepted entry and changes nothing", async () => {
    const s = await setup();
    const c = change({ note_id: randomUUID(), path: "once.md", content: "1" });
    const first = await s.send([c]);
    const again = await s.send([c]);
    expect(again).toEqual(first);
    const edit = change({ note_id: c.note_id, base_version: 1, content: "2" });
    const e1 = await s.send([edit]);
    // replaying both later (e.g. a lost response) still answers the original outcomes, even though version is now 2
    expect(await s.send([c, edit])).toEqual({ accepted: [...first.accepted, ...e1.accepted], rejected: [], checkpoint: 2 });
    expect(await s.row(c.note_id as string)).toMatchObject({ version: 2, content: "2", seq: 2 });
  });

  it("a replayed rejection returns the same reason, with the note's state as it is now", async () => {
    const s = await setup();
    const id = await s.create("r.md", "v1");
    await s.send([change({ note_id: id, base_version: 1, content: "v2" })]);
    const stale = change({ note_id: id, base_version: 1, content: "stale" });
    const first = await s.send([stale]);
    expect(first.rejected[0]).toMatchObject({ reason: "version_mismatch", current: { version: 2, content: "v2" } });
    await s.send([change({ note_id: id, base_version: 2, content: "v3" })]);
    const replay = await s.send([stale]);
    expect(replay.rejected[0]).toMatchObject({ op_id: stale.op_id, reason: "version_mismatch", message: first.rejected[0].message, current: { version: 3, content: "v3" } });
    // validation rejections are stored and replayed the same way
    const bad = change({ note_id: randomUUID(), path: "bad\\path.md", content: "x" });
    expect((await s.send([bad])).rejected[0].reason).toBe("invalid");
    expect((await s.send([bad])).rejected[0].reason).toBe("invalid");
  });

  it("concurrent replays of the same op_id apply it once", async () => {
    const s = await setup();
    const c = change({ note_id: randomUUID(), path: "race.md", content: "x" });
    const results = await Promise.all(Array.from({ length: 5 }, () => s.send([c])));
    for (const r of results) expect(r.accepted).toEqual([{ op_id: c.op_id, note_id: c.note_id, version: 1, seq: 1 }]);
    expect(await prisma.syncOp.count({ where: { workspaceId: s.ws.id } })).toBe(1);
  });

  it("op ids are scoped to the workspace", async () => {
    const a = await setup();
    const b = await setup();
    const opId = randomUUID();
    expect((await a.send([change({ op_id: opId, note_id: randomUUID(), path: "x.md", content: "a" })])).accepted).toHaveLength(1);
    const inB = await b.send([change({ op_id: opId, note_id: randomUUID(), path: "x.md", content: "b" })]);
    expect(inB.accepted).toHaveLength(1);
    expect(await prisma.note.count({ where: { workspaceId: b.ws.id } })).toBe(1);
  });
});

describe("push: rejections", () => {
  it("version_mismatch carries the current state; base_version 0 for an existing note is a mismatch too", async () => {
    const s = await setup();
    const id = await s.create("m.md", "server text");
    await s.send([change({ note_id: id, base_version: 1, content: "server v2" })]);
    const r = await s.send([
      change({ note_id: id, base_version: 1, content: "my edit" }),
      change({ note_id: id, base_version: 0, path: "m.md", content: "dup" }),
      change({ note_id: id, op: "delete", base_version: 1 })
    ]);
    expect(r.accepted).toEqual([]);
    for (const rej of r.rejected) {
      expect(rej).toEqual({
        op_id: expect.any(String), note_id: id, reason: "version_mismatch", message: expect.any(String),
        current: { version: 2, path: "m.md", deleted: false, content: "server v2" }
      });
    }
    expect(await s.row(id)).toMatchObject({ version: 2, content: "server v2" });
  });

  it("not_found: an edit or delete of a note the server does not have", async () => {
    const s = await setup();
    const r = await s.send([
      change({ note_id: randomUUID(), base_version: 3, content: "x" }),
      change({ note_id: randomUUID(), op: "delete", base_version: 1 }),
      change({ note_id: randomUUID(), op: "delete", base_version: 0 })
    ]);
    expect(r.rejected.map((x: { reason: string; current: unknown }) => [x.reason, x.current])).toEqual([
      ["not_found", null], ["not_found", null], ["not_found", null]
    ]);
    expect(r.checkpoint).toBe(0);
  });

  it("path_taken: exact and case-insensitive (and Unicode-normalised) clashes among live notes", async () => {
    const s = await setup();
    const plan = await s.create("Projects/Plan.md");
    const cafe = await s.create("café.md"); // NFC
    const r = await s.send([
      change({ note_id: randomUUID(), path: "Projects/Plan.md", content: "x" }),
      change({ note_id: randomUUID(), path: "projects/plan.MD", content: "x" }),
      change({ note_id: randomUUID(), path: "CAFÉ.md", content: "x" }) // NFD, upper case
    ]);
    expect(r.rejected.map((x: { reason: string; current: unknown }) => [x.reason, x.current])).toEqual([
      ["path_taken", null], ["path_taken", null], ["path_taken", null]
    ]);
    // renaming another note onto a taken path: rejected with that note's own state
    const other = await s.create("other.md", "mine");
    const ren = await s.send([change({ note_id: other, base_version: 1, path: "PROJECTS/plan.md" })]);
    expect(ren.rejected[0]).toMatchObject({ reason: "path_taken", current: { version: 1, path: "other.md", deleted: false, content: "mine" } });
    expect(await s.row(plan)).toMatchObject({ path: "Projects/Plan.md" });
    expect(await s.row(cafe)).toMatchObject({ deleted: false });
  });

  it("a path freed by a delete or rename earlier in the same push can be taken (changes apply in order)", async () => {
    const s = await setup();
    const a = await s.create("x.md", "a");
    const b = await s.create("y.md", "b");
    const newX = randomUUID();
    const newY = randomUUID();
    const r = await s.send([
      change({ note_id: a, op: "delete", base_version: 1 }),
      change({ note_id: newX, path: "X.md", content: "new x" }),
      change({ note_id: b, base_version: 1, path: "z.md" }),
      change({ note_id: newY, path: "y.md", content: "new y" })
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.accepted.map((x: { note_id: string }) => x.note_id)).toEqual([a, newX, b, newY]);

    // the other way round the path is still taken when the second change arrives
    const c = await s.create("w.md");
    const late = randomUUID();
    const r2 = await s.send([
      change({ note_id: late, path: "w.md", content: "too early" }),
      change({ note_id: c, base_version: 1, path: "w2.md" })
    ]);
    expect(r2.rejected.map((x: { note_id: string; reason: string }) => [x.note_id, x.reason])).toEqual([[late, "path_taken"]]);
    expect(r2.accepted.map((x: { note_id: string }) => x.note_id)).toEqual([c]);
  });

  it("a tombstone's path is free, and reviving a tombstone onto a path taken meanwhile is path_taken", async () => {
    const s = await setup();
    const old = await s.create("t.md", "old");
    await s.send([change({ note_id: old, op: "delete", base_version: 1 })]);
    const fresh = await s.create("T.md", "new");
    const revive = await s.send([change({ note_id: old, base_version: 2, content: "back" })]);
    expect(revive.rejected[0]).toMatchObject({ reason: "path_taken", current: { version: 2, deleted: true, content: null } });
    expect((await s.send([change({ note_id: old, base_version: 2, path: "t (restored).md", content: "back" })])).accepted).toHaveLength(1);
    expect(await s.row(fresh)).toMatchObject({ path: "T.md", deleted: false });
  });

  it("too_large: content over 4 MiB (UTF-8 bytes); exactly 4 MiB is fine", async () => {
    const s = await setup();
    const exactly = "é".repeat(2 * MiB); // 2 bytes each
    const over = "a".repeat(4 * MiB + 1);
    const okId = randomUUID();
    const r1 = await s.send([change({ note_id: okId, path: "big.md", content: exactly })]);
    expect(r1.accepted).toHaveLength(1);
    expect((await s.row(okId)).size).toBe(4 * MiB);
    const r2 = await s.send([change({ note_id: randomUUID(), path: "huge.md", content: over })]);
    expect(r2.rejected[0]).toMatchObject({ reason: "too_large", current: null });
    expect(r2.rejected[0].message).toMatch(/4194305 bytes/);
    // an edit that grows past the cap is refused the same way
    expect((await s.send([change({ note_id: okId, base_version: 1, content: `${exactly}!` })])).rejected[0].reason).toBe("too_large");
  });

  it("one note at the size limit always fits in a push, even when JSON escaping makes it 6x larger", async () => {
    const s = await setup();
    const worst = "\u0001".repeat(4 * MiB); // each character becomes \u0001 (6 bytes) in JSON
    const r = await push(app, s.owner, s.ws.id, s.client, [change({ note_id: randomUUID(), path: "worst.md", content: worst })]);
    expect(r.statusCode).toBe(200);
    expect(r.json().accepted).toHaveLength(1);
  });

  it("the push body is capped (413), as are the number of changes (400)", async () => {
    const s = await setup();
    // over the 26 MiB default: seven 4 MiB notes
    const tooBig = await push(app, s.owner, s.ws.id, s.client, Array.from({ length: 7 }, (_, i) =>
      change({ note_id: randomUUID(), path: `${i}.md`, content: "x".repeat(4 * MiB) })));
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error).toMatchObject({ code: "invalid_request", details: { reason: "too_large" } });
    const many = await push(app, s.owner, s.ws.id, s.client, Array.from({ length: 201 }, (_, i) => change({ note_id: randomUUID(), path: `${i}.md`, content: "" })));
    expect(many.statusCode).toBe(400);
    const max = await push(app, s.owner, s.ws.id, s.client, Array.from({ length: 200 }, (_, i) => change({ note_id: randomUUID(), path: `${i}.md`, content: "" })));
    expect(max.json().accepted).toHaveLength(200);
    // other routes keep the small default body limit
    const big = await call(app, { method: "POST", url: "/v1/workspaces", as: s.owner, body: { name: "x", description: "y".repeat(2 * MiB) } });
    expect(big.statusCode).toBe(413);
  });

  it("invalid: bad paths, a malformed note id, a new note without path or content, NUL in content", async () => {
    const s = await setup();
    const bad = [
      "", "/abs.md", "a//b.md", "dir/", "./a.md", "a/../b.md", "..", "a\\b.md", "tab\there.md", "nl\nhere.md", "del\u007f.md",
      "notes.txt", "noext", "md", `${"s".repeat(201)}.md`, `${"d/".repeat(512)}x.md`
    ];
    const r = await s.send(bad.map((path) => change({ note_id: randomUUID(), path, content: "x" })));
    expect(r.accepted).toEqual([]);
    expect(r.rejected.map((x: { reason: string }) => x.reason)).toEqual(bad.map(() => "invalid"));
    expect(r.rejected[0].message).toMatch(/empty/);

    const more = await s.send([
      change({ note_id: "not-a-uuid", path: "a.md", content: "x" }),
      change({ note_id: randomUUID(), path: "a.md" }),
      change({ note_id: randomUUID(), content: "no path" }),
      change({ note_id: randomUUID(), path: "nul.md", content: "a\u0000b" })
    ]);
    expect(more.rejected.map((x: { reason: string }) => x.reason)).toEqual(["invalid", "invalid", "invalid", "invalid"]);
    expect(more.checkpoint).toBe(0);
    // an invalid rename of an existing note is refused too, the note keeps its path
    const id = await s.create("fine.md");
    expect((await s.send([change({ note_id: id, base_version: 1, path: "../escape.md" })])).rejected[0].reason).toBe("invalid");
    expect(await s.row(id)).toMatchObject({ path: "fine.md", version: 1 });

    const good = [
      "a.md", "Nested/Deeper/Note.markdown", "x.mdown", "y.mkd", "UPPER.MD", "spaces in name.md", "ünïcödé/日本語.md",
      ".hidden.md", `${"s".repeat(197)}.md`, `${"d/".repeat(509)}x.md`
    ];
    const ok = await s.send(good.map((path) => change({ note_id: randomUUID(), path, content: "x" })));
    expect(ok.rejected).toEqual([]);
  });

  it("path rules (unit)", () => {
    expect(pathProblem("a/b.md")).toBeNull();
    expect(pathProblem(`${"x".repeat(1022)}.md`)).toMatch(/1024/);
    expect(pathProblem("a/\u0085b.md")).toMatch(/control/);
    expect(pathKey("Café/X.MD")).toBe("café/x.md");
  });
});

describe("pull", () => {
  it("coalesces: several edits of one note come down as one change with the latest state", async () => {
    const s = await setup();
    const id = await s.create("draft.md", "v1");
    const other = await s.create("other.md");
    for (let v = 1; v <= 4; v++) await s.send([change({ note_id: id, base_version: v, content: `v${v + 1}` })]);
    await s.send([change({ note_id: id, base_version: 5, path: "final.md" })]);
    const p = await s.pull(0);
    expect(p.changes).toEqual([
      { note_id: other, path: "other.md", version: 1, deleted: false, content_hash: sha("text"), content: "text", seq: 2 },
      { note_id: id, path: "final.md", version: 6, deleted: false, content_hash: sha("v5"), content: "v5", seq: 7 }
    ]);
    expect(p.checkpoint).toBe(7);
    expect((await s.pull(2)).changes.map((c: { note_id: string }) => c.note_id)).toEqual([id]);
  });

  it("pages by limit with has_more; the checkpoint is the last seq of a page", async () => {
    const s = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await s.create(`p${i}.md`, `${i}`));
    await s.send([change({ note_id: ids[1], op: "delete", base_version: 1 })]); // seq 6, a tombstone
    const seen: string[] = [];
    let after = 0;
    const pages: Array<{ checkpoint: number; has_more: boolean }> = [];
    for (;;) {
      const p = await s.pull(after, 2);
      seen.push(...p.changes.map((c: { note_id: string; deleted: boolean }) => `${c.note_id}${c.deleted ? ":deleted" : ""}`));
      pages.push({ checkpoint: p.checkpoint, has_more: p.has_more });
      after = p.checkpoint;
      if (!p.has_more) break;
    }
    // the first page (after=0) leaves tombstones out; later pages of the same download carry them (clients ignore
    // tombstones of notes they do not have)
    expect(seen).toEqual([ids[0], ids[2], ids[3], ids[4], `${ids[1]}:deleted`]);
    expect(pages).toEqual([{ checkpoint: 3, has_more: true }, { checkpoint: 5, has_more: true }, { checkpoint: 6, has_more: false }]);
    // an incremental pull from before the delete pages through the tombstone
    const inc = await s.pull(1, 1);
    expect(inc).toMatchObject({ checkpoint: 3, has_more: true });
    expect((await s.pull(5, 1)).changes).toEqual([
      { note_id: ids[1], path: "p1.md", version: 2, deleted: true, content_hash: null, content: null, seq: 6 }
    ]);
    expect((await call(app, { method: "GET", url: `/v1/workspaces/${s.ws.id}/sync/pull?client_id=${s.client}&limit=501`, as: s.owner })).statusCode).toBe(400);
  });

  it("caps a page at about 8 MiB of content (always at least one change)", async () => {
    const s = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await s.create(`big${i}.md`, String(i).repeat(3 * MiB)));
    const p1 = await s.pull(0);
    expect(p1.changes.map((c: { note_id: string }) => c.note_id)).toEqual([ids[0], ids[1]]);
    expect(p1).toMatchObject({ checkpoint: 2, has_more: true });
    const p2 = await s.pull(2);
    expect(p2.changes.map((c: { note_id: string }) => c.note_id)).toEqual([ids[2]]);
    expect(p2).toMatchObject({ checkpoint: 3, has_more: false });
  });

  it("requires a registered device and viewer access", async () => {
    const s = await setup();
    const viewer = await createUser();
    await prisma.membership.create({ data: { id: randomUUID(), workspaceId: s.ws.id, userId: viewer.id, role: "viewer" } });
    const vc = await registerClient(app, viewer);
    await s.create("shared.md", "for everyone");
    expect((await s.pull(0, undefined, viewer, vc)).changes[0]).toMatchObject({ content: "for everyone" });
    expect((await call(app, { method: "GET", url: `/v1/workspaces/${s.ws.id}/sync/pull?client_id=${randomUUID()}`, as: s.owner })).statusCode).toBe(400);
    expect((await call(app, { method: "GET", url: `/v1/workspaces/${s.ws.id}/sync/pull`, as: s.owner })).statusCode).toBe(400);
  });
});

describe("roles and workspace scoping", () => {
  it("viewers may pull but every pushed change is rejected `forbidden` (replays too); editors push", async () => {
    const s = await setup();
    const viewer = await createUser();
    const editor = await createUser();
    await prisma.membership.createMany({
      data: [
        { id: randomUUID(), workspaceId: s.ws.id, userId: viewer.id, role: "viewer" },
        { id: randomUUID(), workspaceId: s.ws.id, userId: editor.id, role: "editor" }
      ]
    });
    const id = await s.create("team.md", "v1");
    const vc = await registerClient(app, viewer);
    const c = change({ note_id: id, base_version: 1, content: "viewer edit" });
    const r = await s.send([c, change({ note_id: randomUUID(), path: "v.md", content: "x" })], viewer, vc);
    expect(r).toEqual({
      accepted: [],
      rejected: [
        { op_id: c.op_id, note_id: id, reason: "forbidden", message: expect.stringMatching(/read-only/), current: null },
        expect.objectContaining({ reason: "forbidden" })
      ],
      checkpoint: 1
    });
    expect(await s.row(id)).toMatchObject({ version: 1, content: "v1" });
    // promoted: the same op_id now goes through (forbidden outcomes are not stored)
    await prisma.membership.updateMany({ where: { workspaceId: s.ws.id, userId: viewer.id }, data: { role: "editor" } });
    expect((await s.send([c], viewer, vc)).accepted).toHaveLength(1);
    const ec = await registerClient(app, editor);
    expect((await s.send([change({ note_id: id, base_version: 2, content: "editor edit" })], editor, ec)).accepted[0]).toMatchObject({ version: 3 });
    expect(await s.row(id)).toMatchObject({ updatedById: editor.id, updatedByClientId: ec });
  });

  it("foreign ids: notes of another workspace are 404 through this workspace's routes and never touched by its pushes", async () => {
    const a = await setup();
    const b = await setup();
    const bNote = await b.create("b.md", "B only");
    expect((await call(app, { method: "GET", url: `/v1/workspaces/${a.ws.id}/notes/${bNote}`, as: a.owner })).statusCode).toBe(404);
    const r = await a.send([
      change({ note_id: bNote, base_version: 1, content: "x" }),
      change({ note_id: bNote, op: "delete", base_version: 1 })
    ]);
    expect(r.rejected.map((x: { reason: string }) => x.reason)).toEqual(["not_found", "not_found"]);
    expect((await a.pull(0)).changes).toEqual([]);
    expect(await b.row(bNote)).toMatchObject({ content: "B only", version: 1 });
    // a's device cannot be used by b's owner, and b's owner is a stranger to a
    expect((await push(app, b.owner, b.ws.id, a.client, [])).statusCode).toBe(400);
    expect((await push(app, b.owner, a.ws.id, b.client, [])).statusCode).toBe(403);
  });

  it("deleting the workspace removes its notes and push outcomes; members then get 403", async () => {
    const s = await setup();
    await s.create("doomed.md");
    expect((await call(app, { method: "DELETE", url: `/v1/workspaces/${s.ws.id}`, as: s.owner })).statusCode).toBe(200);
    expect(await prisma.note.count({ where: { workspaceId: s.ws.id } })).toBe(0);
    expect(await prisma.syncOp.count({ where: { workspaceId: s.ws.id } })).toBe(0);
    expect((await push(app, s.owner, s.ws.id, s.client, [])).statusCode).toBe(403);
  });

  it("rate limits sync requests per user (429 + Retry-After)", async () => {
    const limited = await makeApp({ GOO_SYNC_RATE_LIMIT_PER_MINUTE: "3" });
    try {
      const u = await createUser();
      const ws = await setupWorkspace(limited, u);
      const client = await registerClient(limited, u); // 1
      expect((await push(limited, u, ws.id, client, [])).statusCode).toBe(200); // 2
      expect((await push(limited, u, ws.id, client, [])).statusCode).toBe(200); // 3
      const r = await push(limited, u, ws.id, client, []);
      expect(r.statusCode).toBe(429);
      expect(r.json().error.code).toBe("rate_limited");
      expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
      // the dashboard's note routes are not sync routes
      expect((await call(limited, { method: "GET", url: `/v1/workspaces/${ws.id}/notes`, as: u })).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe("dashboard note routes", () => {
  it("lists live notes (metadata only, filter, paging) and returns one with content", async () => {
    const s = await setup();
    const ids: string[] = [];
    for (const p of ["Ideas.md", "work/ideas-2.md", "work/todo.md"]) ids.push(await s.create(p, `content of ${p}`));
    await s.send([change({ note_id: ids[2], op: "delete", base_version: 1 })]);
    const base = `/v1/workspaces/${s.ws.id}/notes`;
    const list = (await call(app, { method: "GET", url: base, as: s.owner })).json();
    expect(list.items.map((n: { path: string }) => n.path)).toEqual(["Ideas.md", "work/ideas-2.md"]);
    expect(list.items[0]).toEqual({
      id: ids[0], workspace_id: s.ws.id, path: "Ideas.md", version: 1, size: Buffer.byteLength("content of Ideas.md"),
      created_at: expect.any(String), updated_at: expect.any(String), updated_by: { id: s.owner.id, display_name: `User ${s.owner.email}` }
    });
    expect(JSON.stringify(list)).not.toContain("content of");
    expect((await call(app, { method: "GET", url: `${base}?q=IDEAS-`, as: s.owner })).json().items.map((n: { id: string }) => n.id)).toEqual([ids[1]]);
    const p1 = (await call(app, { method: "GET", url: `${base}?limit=1`, as: s.owner })).json();
    expect(p1.page.has_more).toBe(true);
    const p2 = (await call(app, { method: "GET", url: `${base}?limit=1&cursor=${p1.page.next_cursor}`, as: s.owner })).json();
    expect(p2.items.map((n: { id: string }) => n.id)).toEqual([ids[1]]);

    const one = (await call(app, { method: "GET", url: `${base}/${ids[1]}`, as: s.owner })).json();
    expect(one.note).toMatchObject({ id: ids[1], path: "work/ideas-2.md", content: "content of work/ideas-2.md", content_hash: sha("content of work/ideas-2.md") });
    expect((await call(app, { method: "GET", url: `${base}/${ids[2]}`, as: s.owner })).statusCode).toBe(404); // deleted
    expect((await call(app, { method: "GET", url: `${base}/${uniq()}`, as: s.owner })).statusCode).toBe(404);
  });

  it("note changes are not audited", async () => {
    const s = await setup();
    await s.create("quiet.md");
    const logs = await prisma.auditLog.findMany({ where: { workspaceId: s.ws.id } });
    expect(logs.map((l) => l.action)).toEqual(["workspace.created"]);
  });
});

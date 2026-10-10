import type { Note, Prisma, PrismaClient, SyncOp } from "@prisma/client";
import { createHash } from "node:crypto";
import { AppError } from "../lib/errors.js";
import { isUuid } from "../lib/ids.js";

type Tx = Prisma.TransactionClient;

/** Largest note content in UTF-8 bytes (the desktop enforces the same cap, so nothing a user can save is refused). */
export const MAX_NOTE_BYTES = 4 * 1024 * 1024;
/** Most changes in one push. */
export const MAX_PUSH_CHANGES = 200;
/** Soft cap on the note content returned by one pull page (at least one change is always returned). */
export const PULL_PAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PATH_CHARS = 1024;
export const MAX_SEGMENT_CHARS = 200;
export const NOTE_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd"] as const;

export const REJECTION_REASONS = ["version_mismatch", "path_taken", "not_found", "too_large", "invalid", "forbidden"] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export type PushChange = {
  op_id: string;
  note_id: string;
  op: "upsert" | "delete";
  base_version: number;
  /** Upsert only; absent = unchanged. */
  path?: string;
  /** Upsert only; absent = unchanged. */
  content?: string;
};

/** The server's state of a note, sent with `version_mismatch` / `path_taken` so the client can merge or rename. */
export type CurrentState = { version: number; path: string; deleted: boolean; content: string | null };

export type Outcome =
  | { status: "accepted"; op_id: string; note_id: string; version: number; seq: number }
  | { status: "rejected"; op_id: string; note_id: string; reason: RejectionReason; message: string; current: CurrentState | null };

export type ChangeContext = { workspaceId: string; userId: string; clientId: string };

// ---------------------------------------------------------------- paths and content

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Why `path` is not a valid note path, or null when it is: relative, `/`-separated, no empty / `.` / `..` segments, no
 * backslash or control characters, segments <= 200 and the whole path <= 1024 characters, a Markdown extension.
 */
export function pathProblem(path: string): string | null {
  if (path === "") return "path is empty";
  if ([...path].length > MAX_PATH_CHARS) return `path is longer than ${MAX_PATH_CHARS} characters`;
  if (path.includes("\\")) return "path must use / as the separator (no backslash)";
  if (CONTROL_CHARS.test(path)) return "path must not contain control characters";
  if (path.startsWith("/")) return "path must be relative (no leading /)";
  const segments = path.split("/");
  for (const s of segments) {
    if (s === "") return "path must not contain empty segments (// or a trailing /)";
    if (s === "." || s === "..") return "path must not contain . or .. segments";
    if ([...s].length > MAX_SEGMENT_CHARS) return `a path segment is longer than ${MAX_SEGMENT_CHARS} characters`;
  }
  const name = segments[segments.length - 1]!.toLowerCase();
  if (!NOTE_EXTENSIONS.some((ext) => name.endsWith(ext))) return `path must end in ${NOTE_EXTENSIONS.join(", ")}`;
  return null;
}

/** Comparison key of a path: case-insensitive and Unicode-normalised, like the file systems of macOS and Windows. */
export function pathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Why `content` cannot be stored, or null. */
function contentProblem(content: string): { reason: RejectionReason; message: string } | null {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_NOTE_BYTES) return { reason: "too_large", message: `content is ${bytes} bytes; the limit is ${MAX_NOTE_BYTES}` };
  // PostgreSQL text cannot hold NUL.
  if (content.includes("\u0000")) return { reason: "invalid", message: "content must not contain NUL characters" };
  return null;
}

const currentOf = (n: Note): CurrentState => ({ version: n.version, path: n.path, deleted: n.deleted, content: n.deleted ? null : n.content });

// ---------------------------------------------------------------- push

/**
 * Applies one push change in its own transaction. The workspace row is locked first, so every change of a workspace is
 * serialized: the idempotency lookup, the version and path checks and the checkpoint increment cannot race, and seq
 * values are gap-free and committed in order. The outcome (accepted or rejected) is stored by `op_id`; a replay returns
 * it again and changes nothing (a replayed rejection carries the note's state as it is now).
 */
export async function applyChange(db: PrismaClient, ctx: ChangeContext, ch: PushChange): Promise<Outcome> {
  return db.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM workspaces WHERE id = ${ctx.workspaceId} FOR UPDATE`;
      if (locked.length === 0) throw new AppError("not_found", "workspace not found");

      const prior = await tx.syncOp.findUnique({ where: { workspaceId_opId: { workspaceId: ctx.workspaceId, opId: ch.op_id } } });
      if (prior) return replay(tx, ctx.workspaceId, ch.op_id, prior);

      const outcome = await decide(tx, ctx, ch);
      await tx.syncOp.create({
        data: {
          workspaceId: ctx.workspaceId, opId: ch.op_id, noteId: outcome.note_id,
          outcome: outcome.status === "accepted" ? "accepted" : outcome.reason,
          version: outcome.status === "accepted" ? outcome.version : null,
          seq: outcome.status === "accepted" ? outcome.seq : null,
          message: outcome.status === "rejected" ? outcome.message : null
        }
      });
      return outcome;
    },
    // Changes of one workspace queue on its row lock; give a busy workspace time instead of failing the push.
    { maxWait: 10_000, timeout: 30_000 }
  );
}

async function replay(tx: Tx, workspaceId: string, opId: string, prior: SyncOp): Promise<Outcome> {
  if (prior.outcome === "accepted") {
    return { status: "accepted", op_id: opId, note_id: prior.noteId, version: prior.version!, seq: prior.seq! };
  }
  const reason = prior.outcome as RejectionReason;
  let current: CurrentState | null = null;
  if (reason === "version_mismatch" || reason === "path_taken") {
    const n = await tx.note.findUnique({ where: { workspaceId_id: { workspaceId, id: prior.noteId } } });
    current = n ? currentOf(n) : null;
  }
  return { status: "rejected", op_id: opId, note_id: prior.noteId, reason, message: prior.message ?? "", current };
}

/** Takes the next checkpoint of the workspace (the row is already locked by this transaction). */
async function nextSeq(tx: Tx, workspaceId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ checkpoint: number }>>`
    UPDATE workspaces SET checkpoint = checkpoint + 1 WHERE id = ${workspaceId} RETURNING checkpoint`;
  return Number(rows[0]!.checkpoint);
}

/** Another live note of the workspace that already uses `path` (case-insensitively), or null. */
function pathOwner(tx: Tx, workspaceId: string, noteId: string, path: string) {
  return tx.note.findFirst({
    where: { workspaceId, pathKey: pathKey(path), deleted: false, id: { not: noteId } },
    select: { id: true }
  });
}

async function decide(tx: Tx, ctx: ChangeContext, ch: PushChange): Promise<Outcome> {
  const { workspaceId } = ctx;
  const noteId = ch.note_id;
  const rejected = (reason: RejectionReason, message: string, current: CurrentState | null = null): Outcome => ({
    status: "rejected", op_id: ch.op_id, note_id: noteId, reason, message, current
  });
  const accepted = (version: number, seq: number): Outcome => ({ status: "accepted", op_id: ch.op_id, note_id: noteId, version, seq });

  // Checks of the change itself, before looking at the server state.
  if (!isUuid(noteId)) return rejected("invalid", "note_id must be a UUID");
  if (ch.op === "upsert") {
    if (ch.path !== undefined) {
      const problem = pathProblem(ch.path);
      if (problem) return rejected("invalid", problem);
    }
    if (ch.content !== undefined) {
      const problem = contentProblem(ch.content);
      if (problem) return rejected(problem.reason, problem.message);
    }
  }
  const stamp = { updatedById: ctx.userId, updatedByClientId: ctx.clientId };

  const cur = await tx.note.findUnique({ where: { workspaceId_id: { workspaceId, id: noteId } } });

  // ---- new note
  if (!cur) {
    if (ch.op === "delete") return rejected("not_found", "note does not exist on the server");
    if (ch.base_version > 0) return rejected("not_found", "note does not exist on the server (push it as new with base_version 0)");
    if (ch.path === undefined || ch.content === undefined) return rejected("invalid", "a new note needs both path and content");
    if (await pathOwner(tx, workspaceId, noteId, ch.path)) return rejected("path_taken", `another note already uses the path ${ch.path}`);
    const seq = await nextSeq(tx, workspaceId);
    await tx.note.create({
      data: {
        id: noteId, workspaceId, path: ch.path, pathKey: pathKey(ch.path), content: ch.content,
        contentHash: contentHash(ch.content), size: Buffer.byteLength(ch.content, "utf8"), version: 1, seq, ...stamp
      }
    });
    return accepted(1, seq);
  }

  // ---- existing note (live or tombstone): exactly the version the client last saw
  if (ch.base_version !== cur.version) {
    return rejected(
      "version_mismatch",
      ch.base_version === 0
        ? "a note with this id already exists; pull and merge"
        : `base_version ${ch.base_version} does not match the server version ${cur.version}; pull and merge`,
      currentOf(cur)
    );
  }

  if (ch.op === "delete") {
    if (cur.deleted) return accepted(cur.version, cur.seq); // already a tombstone: nothing to do
    const seq = await nextSeq(tx, workspaceId);
    const version = cur.version + 1;
    await tx.note.update({
      where: { workspaceId_id: { workspaceId, id: noteId } },
      data: { deleted: true, content: "", contentHash: contentHash(""), size: 0, version, seq, ...stamp }
    });
    return accepted(version, seq);
  }

  // Upsert: edit, rename or revive a tombstone. Absent fields keep the server value (a tombstone's content is "").
  const path = ch.path ?? cur.path;
  const content = ch.content ?? cur.content;
  if (!cur.deleted && path === cur.path && content === cur.content) return accepted(cur.version, cur.seq); // no-op
  if ((cur.deleted || pathKey(path) !== cur.pathKey) && (await pathOwner(tx, workspaceId, noteId, path))) {
    return rejected("path_taken", `another note already uses the path ${path}`, currentOf(cur));
  }
  const seq = await nextSeq(tx, workspaceId);
  const version = cur.version + 1;
  await tx.note.update({
    where: { workspaceId_id: { workspaceId, id: noteId } },
    data: {
      path, pathKey: pathKey(path), content, contentHash: contentHash(content), size: Buffer.byteLength(content, "utf8"),
      deleted: false, version, seq, ...stamp
    }
  });
  return accepted(version, seq);
}

// ---------------------------------------------------------------- pull

export type PullChange = {
  note_id: string;
  path: string;
  version: number;
  deleted: boolean;
  content_hash: string | null;
  content: string | null;
  seq: number;
};

/**
 * Notes whose last change is after `after`, ordered by seq (each note once, with its latest state). `after = 0` is the
 * initial download and leaves tombstones out. Pages are capped by `limit` and by about 8 MiB of content: the page is cut
 * from metadata first so no more content than needed is loaded. The returned checkpoint is the seq of the last change
 * when there is more, else the workspace checkpoint read before the page (which also covers left-out tombstones).
 */
export async function readPullPage(db: PrismaClient, workspaceId: string, after: number, limit: number) {
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { checkpoint: true } });
  const head = ws.checkpoint;
  const meta = await db.note.findMany({
    where: { workspaceId, seq: { gt: after, lte: head }, ...(after === 0 && { deleted: false }) },
    orderBy: { seq: "asc" },
    take: limit + 1,
    select: { id: true, seq: true, size: true }
  });
  let page = meta.length > limit ? meta.slice(0, limit) : meta;
  let hasMore = meta.length > limit;
  let bytes = 0;
  for (let i = 0; i < page.length; i++) {
    bytes += page[i]!.size;
    if (bytes > PULL_PAGE_BYTES && i > 0) {
      page = page.slice(0, i);
      hasMore = true;
      break;
    }
  }
  const rows = page.length
    ? await db.note.findMany({ where: { workspaceId, id: { in: page.map((r) => r.id) } }, orderBy: { seq: "asc" } })
    : [];
  const changes: PullChange[] = rows.map((n) => ({
    note_id: n.id, path: n.path, version: n.version, deleted: n.deleted,
    content_hash: n.deleted ? null : n.contentHash, content: n.deleted ? null : n.content, seq: n.seq
  }));
  // A note changed again between the two queries has a seq beyond this page: it comes with a later pull.
  const inPage = changes.filter((c) => c.seq <= (hasMore ? page[page.length - 1]!.seq : head));
  return { changes: inPage, checkpoint: hasMore ? page[page.length - 1]!.seq : head, has_more: hasMore };
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { defineRoute } from "../lib/route.js";
import { ROLE_RANK, requireWorkspaceRole } from "../auth/middleware.js";
import {
  MAX_NOTE_BYTES, MAX_PUSH_CHANGES, PULL_PAGE_BYTES, REJECTION_REASONS, applyChange, readPullPage, type Outcome
} from "../services/sync.js";

const id = z.string().min(1).max(64);

/** Sync protocol version advertised at client registration. */
export const SYNC_PROTOCOL_VERSION = 1;
/** Optional protocol features the server supports (none yet; grows additively, absent fields mean "unchanged"). */
export const SYNC_FEATURES: readonly string[] = [];

const changeSchema = z.object({
  op_id: id,
  /** Client-made UUID of the note; checked per change (a malformed one is rejected `invalid`). */
  note_id: id,
  op: z.enum(["upsert", "delete"]),
  base_version: z.number().int().min(0),
  path: z.string().optional(),
  content: z.string().optional()
});

const currentSchema = z.object({
  version: z.number().int(),
  path: z.string(),
  deleted: z.boolean(),
  /** null for tombstones, and when the push response already carries about 8 MiB of `current` content (pull instead). */
  content: z.string().nullable()
});
const acceptedSchema = z.object({ op_id: z.string(), note_id: z.string(), version: z.number().int(), seq: z.number().int() });
const rejectedSchema = z.object({
  op_id: z.string(),
  note_id: z.string(),
  reason: z.enum(REJECTION_REASONS),
  message: z.string(),
  /** The server's state of the note for `version_mismatch` and `path_taken` (when the note exists), else null. */
  current: currentSchema.nullable()
});
const pullChangeSchema = z.object({
  note_id: z.string(),
  path: z.string(),
  version: z.number().int(),
  deleted: z.boolean(),
  content_hash: z.string().nullable(),
  content: z.string().nullable(),
  seq: z.number().int()
});

/** Per-user request budget for every sync endpoint, on the shared rate limit store. Sets Retry-After on 429. */
function syncRateLimit(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const max = app.config.syncRateLimitPerMinute;
    const hit = await app.rateLimitStore.hit(`sync|${req.auth!.user.id}`, 60_000);
    if (hit.count > max) {
      const retry = Math.max(1, Math.ceil(hit.ttlMs / 1000));
      reply.header("Retry-After", String(retry));
      throw new AppError("rate_limited", "too many sync requests, slow down", { retry_after_seconds: retry });
    }
  };
}

/** The caller's registered device, which must belong to them; also records that the device was seen. */
async function ownClient(userId: string, clientId: string) {
  const c = await prisma.syncClient.findFirst({ where: { id: clientId, userId } });
  if (!c) throw new AppError("invalid_request", "unknown client_id; register the device first");
  await prisma.syncClient.update({ where: { id: c.id }, data: { lastSeenAt: new Date() } });
  return c;
}

export function registerSyncRoutes(app: FastifyInstance): void {
  const limit = syncRateLimit(app);

  defineRoute(app, {
    method: "POST",
    url: "/v1/sync/clients/register",
    summary: "Register a device for sync",
    description:
      "Creates the device (`client_id`, listed under GET /v1/me/devices) and answers the sync `protocol_version` and the " +
      "optional `features` the server supports. A device registered with a desktop access token is linked to that " +
      "sign-in, so signing the device out (DELETE /v1/me/devices/{id}) revokes its refresh tokens.",
    tags: ["Sync"],
    auth: "user",
    pre: [limit],
    body: z.object({
      device_name: z.string().trim().min(1).max(200),
      platform: z.string().trim().min(1).max(50),
      app_version: z.string().trim().min(1).max(50)
    }),
    responses: {
      201: z.object({ client_id: z.string(), protocol_version: z.number().int(), features: z.array(z.string()) })
    },
    errors: [400, 401, 429],
    handler: async ({ req, body }) => {
      const c = await prisma.syncClient.create({
        data: {
          id: newId(), userId: req.auth!.user.id, deviceName: body.device_name, platform: body.platform,
          appVersion: body.app_version, tokenFamily: req.auth!.tokenFamily ?? null
        }
      });
      return { client_id: c.id, protocol_version: SYNC_PROTOCOL_VERSION, features: [...SYNC_FEATURES] };
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces/:workspaceId/sync/push",
    summary: "Push note changes. Each change is accepted or rejected on its own.",
    description:
      `At most ${MAX_PUSH_CHANGES} changes; the body limit of this route is larger than elsewhere (GOO_SYNC_BODY_LIMIT_BYTES, ` +
      "default 26 MiB, so one note always fits; clients batch by about 8 MiB of content). Changes apply in array order, each in its own transaction, and are idempotent by `op_id`: a " +
      "replayed change returns its original answer and changes nothing. `base_version` is 0 for a new note and otherwise " +
      "the version the client last saw. On upsert `path` and `content` are each optional (absent = unchanged); a new " +
      `note needs both. Content is at most ${MAX_NOTE_BYTES} UTF-8 bytes; \`content_hash\` (SHA-256) is computed by the ` +
      "server. Paths are relative, `/`-separated, case-insensitively unique among live notes and end in .md, .markdown, " +
      ".mdown or .mkd. A delete leaves a tombstone; an upsert with the tombstone's version revives it. Rejection " +
      "`reason`s: `version_mismatch` (with `current`), `path_taken` (with `current` when the note exists), `not_found`, " +
      "`too_large`, `invalid`, `forbidden` (the caller is a viewer: every change is refused, nothing is written). The " +
      "client branches on `reason`, never on the HTTP status. `checkpoint` is the workspace checkpoint after the push " +
      "(do not advance the pull checkpoint with it).",
    access: "any active member (changes of viewers are rejected `forbidden`), or platform admin",
    tags: ["Sync"],
    auth: "user",
    pre: [limit, requireWorkspaceRole("viewer")],
    bodyLimit: app.config.syncBodyLimitBytes,
    params: z.object({ workspaceId: id }),
    body: z.object({ client_id: id, changes: z.array(changeSchema).max(MAX_PUSH_CHANGES) }),
    responses: {
      200: z.object({ accepted: z.array(acceptedSchema), rejected: z.array(rejectedSchema), checkpoint: z.number().int() })
    },
    errors: [400, 401, 403, 404, 413, 429],
    handler: async ({ req, body }) => {
      const { workspace, membership } = req.workspaceCtx!;
      const user = req.auth!.user;
      const client = await ownClient(user.id, body.client_id);
      const canWrite =
        user.platformRole === "super_admin" || user.platformRole === "platform_admin" ||
        (membership !== null && ROLE_RANK[membership.role] >= ROLE_RANK.editor);

      const accepted: z.infer<typeof acceptedSchema>[] = [];
      const rejected: z.infer<typeof rejectedSchema>[] = [];
      let currentBytes = 0;
      for (const ch of body.changes) {
        const outcome: Outcome = canWrite
          ? await applyChange(prisma, { workspaceId: workspace.id, userId: user.id, clientId: client.id }, ch)
          : {
              status: "rejected", op_id: ch.op_id, note_id: ch.note_id, reason: "forbidden",
              message: "this workspace is read-only for your role (viewer)", current: null
            };
        if (outcome.status === "accepted") {
          const { status: _s, ...a } = outcome;
          accepted.push(a);
          continue;
        }
        const { status: _s, ...r } = outcome;
        // Keep the answer bounded: past ~8 MiB of `current` content the client gets the state without the text.
        if (r.current?.content != null) {
          currentBytes += Buffer.byteLength(r.current.content, "utf8");
          if (currentBytes > PULL_PAGE_BYTES) r.current = { ...r.current, content: null };
        }
        rejected.push(r);
      }
      const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id }, select: { checkpoint: true } });
      return { accepted, rejected, checkpoint: ws.checkpoint };
    }
  });

  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces/:workspaceId/sync/pull",
    summary: "Pull the notes changed after a checkpoint (repeat with the returned checkpoint while has_more)",
    description:
      "Each changed note appears once with its latest state (edits made while a device was offline are coalesced), " +
      "ordered by `seq`. `content` and `content_hash` are null for tombstones. `after=0` is the initial download and leaves " +
      "tombstones out; later pages and pulls deliver them (ignore tombstones of unknown notes). A page holds at most " +
      `\`limit\` changes and about ${PULL_PAGE_BYTES / 1024 / 1024} MiB of content (always at least one change). Store ` +
      "the returned `checkpoint` only after applying the page.",
    access: "any active workspace member, or platform admin",
    tags: ["Sync"],
    auth: "user",
    pre: [limit, requireWorkspaceRole("viewer")],
    params: z.object({ workspaceId: id }),
    query: z.object({
      client_id: id,
      after: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(500).default(200)
    }),
    responses: {
      200: z.object({ changes: z.array(pullChangeSchema), checkpoint: z.number().int(), has_more: z.boolean() })
    },
    errors: [400, 401, 403, 404, 429],
    handler: async ({ req, params, query }) => {
      await ownClient(req.auth!.user.id, query.client_id);
      return readPullPage(prisma, params.workspaceId, query.after, query.limit);
    }
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { defineRoute } from "../lib/route.js";
import { pageArgs, paginationQuerySchema, toPage, withCursor } from "../lib/pagination.js";
import { noteMetaSchema, noteSchema, paged, toNote, toNoteMeta } from "../lib/dto.js";
import { requireWorkspaceRole } from "../auth/middleware.js";

const idParam = z.string().min(1).max(64);
const author = { select: { id: true, displayName: true } } as const;

/** Read-only note access for the dashboard. Notes are written only through sync push. */
export function registerNoteRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces/:workspaceId/notes",
    summary: "List the live notes of a workspace (metadata only, no content)",
    description: "`q` filters by a case-insensitive substring of the path. Deleted notes (tombstones) are not listed.",
    access: "any active workspace member, or platform admin",
    tags: ["Notes"],
    auth: "user",
    pre: [requireWorkspaceRole("viewer")],
    params: z.object({ workspaceId: idParam }),
    query: paginationQuerySchema.extend({ q: z.string().trim().max(200).optional() }),
    responses: { 200: paged(noteMetaSchema) },
    errors: [400, 401, 403, 404],
    handler: async ({ params, query }) => {
      const args = pageArgs(query);
      const rows = await prisma.note.findMany({
        where: withCursor(
          {
            workspaceId: params.workspaceId,
            deleted: false,
            ...(query.q && { path: { contains: query.q, mode: "insensitive" as const } })
          },
          args
        ),
        omit: { content: true },
        include: { updatedBy: author },
        orderBy: args.orderBy,
        take: args.take
      });
      return toPage(rows, query.limit, toNoteMeta);
    }
  });

  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces/:workspaceId/notes/:noteId",
    summary: "One live note with its content",
    description: "Looked up by `(workspace, note id)`: ids of other workspaces and deleted notes are `404 not_found`.",
    access: "any active workspace member, or platform admin",
    tags: ["Notes"],
    auth: "user",
    pre: [requireWorkspaceRole("viewer")],
    params: z.object({ workspaceId: idParam, noteId: idParam }),
    responses: { 200: z.object({ note: noteSchema }) },
    errors: [401, 403, 404],
    handler: async ({ params }) => {
      const note = await prisma.note.findFirst({
        where: { workspaceId: params.workspaceId, id: params.noteId, deleted: false },
        include: { updatedBy: author }
      });
      if (!note) throw new AppError("not_found", "note not found");
      return { note: toNote(note) };
    }
  });
}

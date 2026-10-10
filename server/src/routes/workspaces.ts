import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { defineRoute } from "../lib/route.js";
import { pageArgs, paginationQuerySchema, toPage, withCursor } from "../lib/pagination.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { assertVersionIfGiven, ensureUpdated } from "../lib/versioned.js";
import { ok, okSchema, paged, toWorkspace, workspaceListItemSchema, workspaceRoleEnum, workspaceSchema } from "../lib/dto.js";
import { requireWorkspaceRole } from "../auth/middleware.js";

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase letters, digits and single hyphens");

const nameSchema = z.string().trim().min(1).max(120);
const descriptionSchema = z.string().max(2000);
const version = z.number().int().min(1);
const idParam = z.string().min(1).max(64);
const wsParams = z.object({ workspaceId: idParam });

export function slugFromName(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return `${base.length >= 3 ? base : "workspace"}-${randomBytes(2).toString("hex")}`;
}

const membershipSchema = z.object({ role: workspaceRoleEnum });

export function registerWorkspaceRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces",
    summary: "Workspaces the caller is an active member of (with the caller's role)",
    description: "Platform admins see every workspace via GET /v1/admin/workspaces instead.",
    tags: ["Workspaces"],
    auth: "user",
    query: paginationQuerySchema,
    responses: { 200: paged(workspaceListItemSchema) },
    errors: [400, 401],
    handler: async ({ req, query }) => {
      const args = pageArgs(query);
      const userId = req.auth!.user.id;
      const rows = await prisma.workspace.findMany({
        where: withCursor({ memberships: { some: { userId, status: "active" as const } } }, args),
        include: { memberships: { where: { userId, status: "active" }, include: { addedBy: { select: { id: true, displayName: true } } } } },
        orderBy: args.orderBy,
        take: args.take
      });
      return toPage(rows, query.limit, (w) => {
        const m = w.memberships[0]!;
        return {
          ...toWorkspace(w), role: m.role, joined_at: m.joinedAt.toISOString(),
          added_by: m.addedBy ? { id: m.addedBy.id, display_name: m.addedBy.displayName } : null
        };
      });
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces",
    summary: "Create a workspace (a synced notes folder); the caller becomes its owner",
    tags: ["Workspaces"],
    auth: "user",
    body: z.object({ name: nameSchema, slug: slugSchema.optional(), description: descriptionSchema.default("") }),
    responses: { 201: z.object({ workspace: workspaceSchema }) },
    errors: [400, 401, 409],
    handler: async ({ req, body }) => {
      const userId = req.auth!.user.id;
      const ws = await prisma.$transaction(async (tx) => {
        const w = await tx.workspace.create({
          data: {
            id: newId(),
            slug: body.slug ?? slugFromName(body.name),
            name: body.name,
            description: body.description,
            ownerUserId: userId
          }
        });
        await tx.membership.create({ data: { id: newId(), workspaceId: w.id, userId, role: "owner" } });
        await writeAuditLog(tx, {
          actorUserId: userId, action: "workspace.created", resourceType: "workspace", resourceId: w.id,
          workspaceId: w.id, requestId: req.id, details: { slug: w.slug, name: w.name }
        });
        return w;
      });
      return { workspace: toWorkspace(ws) };
    }
  });

  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces/:workspaceId",
    summary: "Workspace metadata and the caller's membership",
    access: "any active member, or platform admin (membership is null for non-member platform admins)",
    tags: ["Workspaces"],
    auth: "user",
    pre: [requireWorkspaceRole("viewer")],
    params: wsParams,
    responses: { 200: z.object({ workspace: workspaceSchema, membership: membershipSchema.nullable() }) },
    errors: [401, 403, 404],
    handler: async ({ req }) => {
      const { workspace, membership } = req.workspaceCtx!;
      return { workspace: toWorkspace(workspace), membership: membership ? { role: membership.role } : null };
    }
  });

  defineRoute(app, {
    method: "PATCH",
    url: "/v1/workspaces/:workspaceId",
    summary: "Rename a workspace or change its description (optimistic concurrency via `version`)",
    access: "workspace owner, or platform admin",
    tags: ["Workspaces"],
    auth: "user",
    pre: [requireWorkspaceRole("owner")],
    params: wsParams,
    body: z.object({ name: nameSchema.optional(), description: descriptionSchema.optional(), version }).strict(),
    responses: { 200: z.object({ workspace: workspaceSchema }) },
    errors: [400, 401, 403, 404, 409],
    handler: async ({ req, body }) => {
      const wsId = req.workspaceCtx!.workspace.id;
      const updated = await prisma.$transaction(async (tx) => {
        const res = await tx.workspace.updateMany({
          where: { id: wsId, version: body.version },
          data: {
            ...(body.name !== undefined && { name: body.name }),
            ...(body.description !== undefined && { description: body.description }),
            version: { increment: 1 }
          }
        });
        await ensureUpdated(res.count, () => tx.workspace.findUnique({ where: { id: wsId } }));
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "workspace.updated", resourceType: "workspace", resourceId: wsId,
          workspaceId: wsId, requestId: req.id,
          details: { fields: Object.keys(body).filter((k) => k !== "version") }
        });
        return tx.workspace.findUniqueOrThrow({ where: { id: wsId } });
      });
      return { workspace: toWorkspace(updated) };
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces/:workspaceId/transfer",
    summary: "Transfer ownership to another active member; the previous owner stays as admin",
    description:
      "`member_id` is the membership id of the new owner (from the members list); `version` is the workspace version " +
      "(optimistic concurrency, 409 `version_mismatch` when stale). The workspace version is bumped.",
    access: "workspace owner, or super_admin",
    tags: ["Workspaces"],
    auth: "user",
    pre: [requireWorkspaceRole("owner", { platformBypass: "super_admin" })],
    params: wsParams,
    body: z.object({ member_id: idParam, version }).strict(),
    responses: { 200: z.object({ workspace: workspaceSchema }) },
    errors: [400, 401, 403, 404, 409],
    handler: async ({ req, body }) => {
      const ws = req.workspaceCtx!.workspace;
      const updated = await prisma.$transaction(async (tx) => {
        const target = await tx.membership.findFirst({ where: { id: body.member_id, workspaceId: ws.id, status: "active" } });
        if (!target) throw new AppError("not_found", "member not found");
        if (target.userId === ws.ownerUserId) throw new AppError("invalid_request", "that member already owns the workspace");
        const res = await tx.workspace.updateMany({
          where: { id: ws.id, version: body.version },
          data: { ownerUserId: target.userId, version: { increment: 1 } }
        });
        await ensureUpdated(res.count, () => tx.workspace.findUnique({ where: { id: ws.id } }));
        await tx.membership.updateMany({
          where: { workspaceId: ws.id, userId: ws.ownerUserId, status: "active" },
          data: { role: "admin", version: { increment: 1 } }
        });
        await tx.membership.update({ where: { id: target.id }, data: { role: "owner", version: { increment: 1 } } });
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "workspace.ownership_transferred", resourceType: "workspace", resourceId: ws.id,
          workspaceId: ws.id, requestId: req.id, details: { from_user_id: ws.ownerUserId, to_user_id: target.userId }
        });
        return tx.workspace.findUniqueOrThrow({ where: { id: ws.id } });
      });
      return { workspace: toWorkspace(updated) };
    }
  });

  defineRoute(app, {
    method: "DELETE",
    url: "/v1/workspaces/:workspaceId",
    summary: "Delete a workspace and all of its notes",
    access: "workspace owner, or super_admin (platform_admin is NOT sufficient)",
    tags: ["Workspaces"],
    auth: "user",
    pre: [requireWorkspaceRole("owner", { platformBypass: "super_admin" })],
    params: wsParams,
    query: z.object({ version: z.coerce.number().int().min(1).optional() }),
    responses: { 200: okSchema },
    errors: [401, 403, 404, 409],
    handler: async ({ req, query }) => {
      const ws = req.workspaceCtx!.workspace;
      assertVersionIfGiven(ws, query.version);
      await prisma.$transaction(async (tx) => {
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "workspace.deleted", resourceType: "workspace", resourceId: ws.id,
          workspaceId: ws.id, requestId: req.id, details: { slug: ws.slug, name: ws.name }
        });
        await tx.workspace.delete({ where: { id: ws.id } });
      });
      return ok();
    }
  });
}

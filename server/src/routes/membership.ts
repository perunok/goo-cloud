import type { FastifyInstance } from "fastify";
import type { Membership, PlatformRole, WorkspaceRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { defineRoute } from "../lib/route.js";
import { pageArgs, paginationQuerySchema, toPage, withCursor } from "../lib/pagination.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { newId } from "../lib/ids.js";
import { assertVersionIfGiven, ensureUpdated } from "../lib/versioned.js";
import { assignableRoleEnum, inviteSchema, memberSchema, ok, okSchema, paged, toInvite, toMember } from "../lib/dto.js";
import { ROLE_RANK, requireWorkspaceRole, type WorkspaceCtx } from "../auth/middleware.js";
import { emailSchema } from "./auth.js";
import { activateMembership } from "../services/members.js";

const version = z.number().int().min(1);
const idParam = z.string().min(1).max(64);
const wsParams = z.object({ workspaceId: idParam });
const memberParams = z.object({ workspaceId: idParam, memberId: idParam });

const isPlatformAdmin = (r: PlatformRole) => r === "super_admin" || r === "platform_admin";

/** A member may grant at most their own role (platform admins may grant any assignable role). */
function assertCanGrant(ctx: WorkspaceCtx, platformRole: PlatformRole, role: WorkspaceRole): void {
  if (isPlatformAdmin(platformRole)) return;
  if (!ctx.membership || ROLE_RANK[role] > ROLE_RANK[ctx.membership.role]) {
    throw new AppError("forbidden", "you cannot grant a role above your own");
  }
}

/**
 * Who may change or remove `target`: never the workspace owner (use transfer); owners and platform admins anyone else;
 * a workspace admin only members below their own role (editors and viewers).
 */
function assertCanManage(ctx: WorkspaceCtx, platformRole: PlatformRole, target: Membership, verb: string): void {
  if (target.userId === ctx.workspace.ownerUserId || target.role === "owner") {
    throw new AppError("forbidden", `the workspace owner cannot be ${verb}`);
  }
  if (isPlatformAdmin(platformRole) || ctx.membership?.role === "owner") return;
  if (!ctx.membership || ROLE_RANK[target.role] >= ROLE_RANK[ctx.membership.role]) {
    throw new AppError("forbidden", "you can only manage members below your own role");
  }
}

export function registerMembershipRoutes(app: FastifyInstance): void {
  // ------------------------------------------------------------------ members
  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces/:workspaceId/members",
    summary: "List active members",
    access: "any active member, or platform admin",
    tags: ["Membership"],
    auth: "user",
    pre: [requireWorkspaceRole("viewer")],
    params: wsParams,
    query: paginationQuerySchema,
    responses: { 200: paged(memberSchema) },
    errors: [400, 401, 403, 404],
    handler: async ({ params, query }) => {
      const args = pageArgs(query);
      const rows = await prisma.membership.findMany({
        where: withCursor({ workspaceId: params.workspaceId, status: "active" as const }, args),
        include: { user: true },
        orderBy: args.orderBy,
        take: args.take
      });
      return toPage(rows, query.limit, toMember);
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces/:workspaceId/members",
    summary: "Add a member by email",
    description:
      "An existing account becomes an active member at once (`status: \"added\"`); the workspace then shows up in their " +
      "dashboard and desktop app. An email without an account gets a pending invite (`status: \"pending\"`, no token, no " +
      "expiry) that becomes a membership as soon as an account with that email is created or signs in. 409 when the " +
      "email is already an active member or already pending. Nobody can grant a role above their own.",
    access: "workspace owner/admin, or platform admin",
    tags: ["Membership"],
    auth: "user",
    pre: [requireWorkspaceRole("admin")],
    params: wsParams,
    body: z.object({ email: emailSchema, role: assignableRoleEnum }).strict(),
    responses: {
      201: z.discriminatedUnion("status", [
        z.object({ status: z.literal("added"), member: memberSchema }),
        z.object({ status: z.literal("pending"), invite: inviteSchema })
      ])
    },
    errors: [400, 401, 403, 404, 409],
    handler: async ({ req, body }) => {
      const ws = req.workspaceCtx!.workspace;
      const actor = req.auth!.user;
      assertCanGrant(req.workspaceCtx!, actor.platformRole, body.role);
      return prisma.$transaction(async (tx) => {
        const user = await tx.user.findFirst({ where: { email: { equals: body.email, mode: "insensitive" } } });
        if (user) {
          const existing = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ws.id, userId: user.id } } });
          if (existing?.status === "active") throw new AppError("conflict", "that user is already a member");
          const m = await activateMembership(tx, ws.id, user.id, body.role, actor.id);
          await writeAuditLog(tx, {
            actorUserId: actor.id, action: "member.added", resourceType: "membership", resourceId: m.id,
            workspaceId: ws.id, requestId: req.id, details: { email: user.email, role: m.role }
          });
          return { status: "added" as const, member: toMember(m) };
        }
        const pending = await tx.invite.findFirst({
          where: { workspaceId: ws.id, email: { equals: body.email, mode: "insensitive" }, status: "pending" }
        });
        if (pending) throw new AppError("conflict", "that email is already pending; it joins when its account is created");
        const inv = await tx.invite.create({
          data: { id: newId(), workspaceId: ws.id, email: body.email, role: body.role, invitedByUserId: actor.id }
        });
        await writeAuditLog(tx, {
          actorUserId: actor.id, action: "invite.created", resourceType: "invite", resourceId: inv.id,
          workspaceId: ws.id, requestId: req.id, details: { email: body.email, role: body.role }
        });
        return { status: "pending" as const, invite: toInvite(inv) };
      });
    }
  });

  defineRoute(app, {
    method: "PATCH",
    url: "/v1/workspaces/:workspaceId/members/:memberId",
    summary: "Change a member's role (the workspace owner's role cannot be changed; use transfer)",
    description:
      "A workspace admin may change only editors and viewers and grant at most `admin`; the owner and platform admins may " +
      "change anyone but the owner.",
    access: "workspace owner/admin, or platform admin",
    tags: ["Membership"],
    auth: "user",
    pre: [requireWorkspaceRole("admin")],
    params: memberParams,
    body: z.object({ role: assignableRoleEnum, version }).strict(),
    responses: { 200: z.object({ member: memberSchema }) },
    errors: [400, 401, 403, 404, 409],
    handler: async ({ req, params, body }) => {
      const ctx = req.workspaceCtx!;
      const ws = ctx.workspace;
      const member = await prisma.membership.findFirst({ where: { id: params.memberId, workspaceId: ws.id, status: "active" } });
      if (!member) throw new AppError("not_found", "member not found");
      assertCanManage(ctx, req.auth!.user.platformRole, member, "changed");
      assertCanGrant(ctx, req.auth!.user.platformRole, body.role);
      const updated = await prisma.$transaction(async (tx) => {
        const res = await tx.membership.updateMany({
          where: { id: member.id, workspaceId: ws.id, status: "active", version: body.version },
          data: { role: body.role, version: { increment: 1 } }
        });
        await ensureUpdated(res.count, () => tx.membership.findFirst({ where: { id: member.id, workspaceId: ws.id } }));
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "member.role_changed", resourceType: "membership",
          resourceId: member.id, workspaceId: ws.id, requestId: req.id,
          details: { user_id: member.userId, from: member.role, to: body.role }
        });
        return tx.membership.findUniqueOrThrow({ where: { id: member.id }, include: { user: true } });
      });
      return { member: toMember(updated) };
    }
  });

  defineRoute(app, {
    method: "DELETE",
    url: "/v1/workspaces/:workspaceId/members/:memberId",
    summary: "Remove a member (soft: status becomes `removed`); the owner cannot be removed",
    description: "A workspace admin may remove only editors and viewers.",
    access: "workspace owner/admin, or platform admin",
    tags: ["Membership"],
    auth: "user",
    pre: [requireWorkspaceRole("admin")],
    params: memberParams,
    query: z.object({ version: z.coerce.number().int().min(1).optional() }),
    responses: { 200: okSchema },
    errors: [401, 403, 404, 409],
    handler: async ({ req, params, query }) => {
      const ctx = req.workspaceCtx!;
      const ws = ctx.workspace;
      const member = await prisma.membership.findFirst({ where: { id: params.memberId, workspaceId: ws.id, status: "active" } });
      if (!member) throw new AppError("not_found", "member not found");
      assertCanManage(ctx, req.auth!.user.platformRole, member, "removed");
      assertVersionIfGiven(member, query.version);
      await prisma.$transaction(async (tx) => {
        await tx.membership.update({ where: { id: member.id }, data: { status: "removed", version: { increment: 1 } } });
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "member.removed", resourceType: "membership",
          resourceId: member.id, workspaceId: ws.id, requestId: req.id,
          details: { user_id: member.userId, role: member.role }
        });
      });
      return ok();
    }
  });

  defineRoute(app, {
    method: "POST",
    url: "/v1/workspaces/:workspaceId/leave",
    summary: "Leave a workspace (the owner must transfer ownership or delete the workspace instead)",
    access: "any active member except the owner",
    tags: ["Membership"],
    auth: "user",
    pre: [requireWorkspaceRole("viewer", { platformBypass: "none" })],
    params: wsParams,
    responses: { 200: okSchema },
    errors: [401, 403, 404],
    handler: async ({ req }) => {
      const { workspace: ws, membership } = req.workspaceCtx!;
      const m = membership!;
      if (m.role === "owner" || m.userId === ws.ownerUserId) {
        throw new AppError("forbidden", "the owner cannot leave; transfer ownership or delete the workspace");
      }
      await prisma.$transaction(async (tx) => {
        await tx.membership.update({ where: { id: m.id }, data: { status: "removed", version: { increment: 1 } } });
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "member.left", resourceType: "membership", resourceId: m.id,
          workspaceId: ws.id, requestId: req.id, details: { role: m.role }
        });
      });
      return ok();
    }
  });

  // ------------------------------------------------------------------ invites (pending additions)
  defineRoute(app, {
    method: "GET",
    url: "/v1/workspaces/:workspaceId/invites",
    summary: "List people added before they had an account (`?status=pending` for the open ones)",
    access: "workspace owner/admin, or platform admin",
    tags: ["Membership"],
    auth: "user",
    pre: [requireWorkspaceRole("admin")],
    params: wsParams,
    query: paginationQuerySchema.extend({ status: z.enum(["pending", "accepted", "revoked"]).optional() }),
    responses: { 200: paged(inviteSchema) },
    errors: [400, 401, 403, 404],
    handler: async ({ params, query }) => {
      const args = pageArgs(query);
      const rows = await prisma.invite.findMany({
        where: withCursor({ workspaceId: params.workspaceId, ...(query.status && { status: query.status }) }, args),
        orderBy: args.orderBy,
        take: args.take
      });
      return toPage(rows, query.limit, toInvite);
    }
  });

  defineRoute(app, {
    method: "DELETE",
    url: "/v1/workspaces/:workspaceId/invites/:inviteId",
    summary: "Cancel a pending addition (the person is not added when their account is created)",
    access: "workspace owner/admin, or platform admin",
    tags: ["Membership"],
    auth: "user",
    pre: [requireWorkspaceRole("admin")],
    params: z.object({ workspaceId: idParam, inviteId: idParam }),
    responses: { 200: z.object({ invite: inviteSchema }) },
    errors: [401, 403, 404, 409],
    handler: async ({ req, params }) => {
      const ws = req.workspaceCtx!.workspace;
      const invite = await prisma.$transaction(async (tx) => {
        const inv = await tx.invite.findFirst({ where: { id: params.inviteId, workspaceId: ws.id } });
        if (!inv) throw new AppError("not_found", "invite not found");
        const res = await tx.invite.updateMany({
          where: { id: inv.id, workspaceId: ws.id, status: "pending" },
          data: { status: "revoked", version: { increment: 1 } }
        });
        if (res.count !== 1) throw new AppError("conflict", `invite is already ${inv.status}`);
        await writeAuditLog(tx, {
          actorUserId: req.auth!.user.id, action: "invite.revoked", resourceType: "invite", resourceId: inv.id,
          workspaceId: ws.id, requestId: req.id, details: { email: inv.email }
        });
        return tx.invite.findUniqueOrThrow({ where: { id: inv.id } });
      });
      return { invite: toInvite(invite) };
    }
  });
}

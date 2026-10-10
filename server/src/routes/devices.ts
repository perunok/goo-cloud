import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { defineRoute } from "../lib/route.js";
import { pageArgs, paginationQuerySchema, toPage, withCursor } from "../lib/pagination.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { deviceSchema, ok, okSchema, paged, toDevice } from "../lib/dto.js";

/** The caller's own sync devices (`SyncClient` rows, created by POST /v1/sync/clients/register). */
export function registerDeviceRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: "GET",
    url: "/v1/me/devices",
    summary: "The caller's registered sync devices",
    tags: ["Auth"],
    auth: "user",
    query: paginationQuerySchema,
    responses: { 200: paged(deviceSchema) },
    errors: [400, 401],
    handler: async ({ req, query }) => {
      const args = pageArgs(query);
      const rows = await prisma.syncClient.findMany({
        where: withCursor({ userId: req.auth!.user.id }, args),
        orderBy: args.orderBy,
        take: args.take
      });
      return toPage(rows, query.limit, toDevice);
    }
  });

  defineRoute(app, {
    method: "DELETE",
    url: "/v1/me/devices/:deviceId",
    summary: "Sign a device out: drops the refresh tokens of the sign-in it registered with and removes it",
    description:
      "The device can no longer refresh its access token (the current one expires within its lifetime, 1 h by default) " +
      "and its `client_id` stops working for sync. The refresh tokens are deleted rather than marked revoked, so the " +
      "signed-out device trying to refresh is a plain 401, not a reuse that would sign out every other device. Notes it " +
      "changed keep their content. Audited (`device.signed_out`).",
    tags: ["Auth"],
    auth: "user",
    params: z.object({ deviceId: z.string().min(1).max(64) }),
    responses: { 200: okSchema },
    errors: [401, 404],
    handler: async ({ req, params }) => {
      const userId = req.auth!.user.id;
      await prisma.$transaction(async (tx) => {
        const device = await tx.syncClient.findFirst({ where: { id: params.deviceId, userId } });
        if (!device) throw new AppError("not_found", "device not found");
        if (device.tokenFamily) await tx.refreshToken.deleteMany({ where: { userId, familyId: device.tokenFamily } });
        await tx.syncClient.delete({ where: { id: device.id } });
        await writeAuditLog(tx, {
          actorUserId: userId, action: "device.signed_out", resourceType: "device", resourceId: device.id, requestId: req.id,
          details: { device_name: device.deviceName, platform: device.platform }
        });
      });
      return ok();
    }
  });
}

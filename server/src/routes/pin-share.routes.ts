import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db.js";
import { parseInput, uuidSchema } from "../lib/validation.js";
import { auditContext, type Guards } from "./route-helpers.js";
import {
  getPinDashboard,
  getPinStatus,
  hideSharedItem,
  listActiveShareUsers,
  pinItem,
  revokeSharedItem,
  shareItem,
  unpinItem,
} from "../services/pin-share.service.js";

const itemTypeSchema = z.enum(["catalog", "supplier", "product"]);
const itemSchema = z.object({ itemType: itemTypeSchema, itemId: uuidSchema });
const shareSchema = itemSchema.extend({
  recipientIds: z.array(uuidSchema).min(1).max(100),
  note: z.string().trim().max(500).nullable().optional(),
});
const shareIdSchema = z.object({ id: uuidSchema });
const hideSchema = z.object({ hidden: z.boolean() });

const dashboardQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  pinType: itemTypeSchema.optional(),
  shareType: itemTypeSchema.optional(),
  senderId: uuidSchema.optional(),
  hidden: z.enum(["true", "false"]).optional().transform((value) => value === undefined ? undefined : value === "true"),
});

export function registerPinShareRoutes(app: FastifyInstance, db: Database, guards: Guards): void {
  app.get("/pins/users", { preHandler: guards.requireUser }, async (request) => {
    const query = parseInput(z.object({ q: z.string().trim().max(200).optional() }), request.query);
    return {
      users: await listActiveShareUsers(db, request.auth!.user.id, query.q ?? ""),
    };
  });

  app.get("/pins/dashboard", { preHandler: guards.requireUser }, async (request) => {
    const query = parseInput(dashboardQuerySchema, request.query);
    return getPinDashboard(db, auditContext(request), query);
  });

  app.get("/pins/:itemType/:itemId/status", { preHandler: guards.requireUser }, async (request) => {
    const body = parseInput(itemSchema, { itemType: (request.params as { itemType?: string }).itemType, itemId: (request.params as { itemId?: string }).itemId });
    return { pinned: await getPinStatus(db, auditContext(request), body) };
  });

  app.post("/pins", { preHandler: guards.requireUser }, async (request) => {
    const body = parseInput(itemSchema, request.body);
    await pinItem(db, auditContext(request), body);
    return { pinned: true };
  });

  app.delete("/pins", { preHandler: guards.requireUser }, async (request) => {
    const body = parseInput(itemSchema, request.body);
    await unpinItem(db, auditContext(request), body);
    return { pinned: false };
  });

  app.post("/shares", { preHandler: guards.requireUser }, async (request) => {
    const body = parseInput(shareSchema, request.body);
    await shareItem(db, auditContext(request), {
      ...body,
      note: body.note?.trim() || null,
    });
    return { shared: true };
  });

  app.patch("/shares/:id", { preHandler: guards.requireUser }, async (request) => {
    const { id } = parseInput(shareIdSchema, request.params);
    const body = parseInput(hideSchema, request.body);
    await hideSharedItem(db, auditContext(request), id, body.hidden);
    return { hidden: body.hidden };
  });

  app.delete("/shares/:id", { preHandler: guards.requireUser }, async (request, reply) => {
    const { id } = parseInput(shareIdSchema, request.params);
    await revokeSharedItem(db, auditContext(request), id);
    return reply.status(204).send();
  });
}

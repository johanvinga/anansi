import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "../db.js";
import { parseInput, paginationSchema, uuidSchema } from "../lib/validation.js";
import { AuditAction, getAuditLog, listAuditLogs, recordAudit } from "../services/audit.service.js";

const listQuerySchema = paginationSchema.extend({
  userId: uuidSchema.optional(),
  action: z.string().trim().min(1).max(50).optional(),
  entityType: z.string().trim().min(1).max(50).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

interface Guards {
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export function registerAuditRoutes(app: FastifyInstance, db: Database, guards: Guards): void {
  const auditContext = (request: FastifyRequest) => ({
    requestId: request.id,
    ipAddress: request.ip,
    actor: { userId: request.auth!.user.id, email: request.auth!.user.email },
  });

  app.get("/audit-log", { preHandler: guards.requireAdmin }, async (request) => {
    const query = parseInput(listQuerySchema, request.query);
    const result = await listAuditLogs(
      db,
      {
        userId: query.userId,
        action: query.action,
        entityType: query.entityType,
        from: query.from,
        to: query.to,
      },
      query.page,
      query.pageSize,
    );
    await recordAudit(db, auditContext(request), {
      action: AuditAction.AUDIT_LOG_LIST,
      outcome: "success",
    });
    return result;
  });

  app.get("/audit-log/:id", { preHandler: guards.requireAdmin }, async (request) => {
    const { id } = parseInput(z.object({ id: uuidSchema }), request.params);
    const entry = await getAuditLog(db, id);
    await recordAudit(db, auditContext(request), {
      action: AuditAction.AUDIT_LOG_VIEW,
      outcome: "success",
      entityType: "AuditLog",
      entityId: id,
    });
    return { entry };
  });
}

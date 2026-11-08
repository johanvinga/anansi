import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuditRequestContext } from "../services/audit.service.js";

export interface Guards {
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/** Audit context for an authenticated request. Call only after a guard has run. */
export function auditContext(request: FastifyRequest): AuditRequestContext {
  const user = request.auth?.user;
  if (!user) {
    throw new Error("auditContext called without an authenticated user");
  }
  return {
    requestId: request.id,
    ipAddress: request.ip,
    actor: { userId: user.id, email: user.email },
  };
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { optionalPaginationSchema, parseInput, uuidSchema } from "../lib/validation.js";
import { resolvePage } from "../lib/pagination.js";
import type { Database } from "../db.js";
import type { AuditRequestContext } from "../services/audit.service.js";
import { archiveTag, listTags, createTag, renameTag } from "../services/tag.service.js";

interface Guards {
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const createSchema = z.object({
  name: z.object({
    en: z.string().trim().min(1).max(100),
    fr: z.string().trim().min(1).max(100).optional(),
  }).transform((name) => ({ en: name.en, fr: name.fr ?? name.en })),
});

const updateSchema = z.object({
  name: z.object({
    en: z.string().trim().min(1).max(100),
    fr: z.string().trim().min(1).max(100),
  }).optional(),
  isArchived: z.boolean().optional(),
}).refine((value) => value.name !== undefined || value.isArchived !== undefined);

export function registerTagRoutes(app: FastifyInstance, db: Database, guards: Guards): void {
  const context = (request: FastifyRequest): AuditRequestContext => ({
    requestId: request.id,
    ipAddress: request.ip,
    actor: { userId: request.auth!.user.id, email: request.auth!.user.email },
  });

  app.get("/tags", { preHandler: guards.requireUser }, async (request) => {
    const query = parseInput(optionalPaginationSchema, request.query);
    return listTags(db, context(request), false, resolvePage(query));
  });

  app.post("/tags", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = parseInput(createSchema, request.body);
    const tag = await createTag(db, context(request), body);
    return reply.status(201).send({ tag });
  });

  app.put("/tags/:id", { preHandler: guards.requireAdmin }, async (request) => {
    const { id } = parseInput(z.object({ id: uuidSchema }), request.params);
    const body = parseInput(updateSchema, request.body);
    if (body.name) return { tag: await renameTag(db, context(request), id, body.name) };
    if (body.isArchived !== undefined) return { tag: await archiveTag(db, context(request), id, body.isArchived) };
  });
}

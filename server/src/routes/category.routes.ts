import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "../db.js";
import { parseInput, uuidSchema } from "../lib/validation.js";
import { translatedNameInput, translatedNameUpdate } from "../lib/translations.js";
import type { AuditRequestContext } from "../services/audit.service.js";
import {
  createCategory,
  deleteCategory,
  listCategories,
  renameCategory,
} from "../services/category.service.js";

interface Guards {
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
});

const categoryCreateSchema = z.object({ name: translatedNameInput(100) });
const categoryUpdateSchema = z.object({ name: translatedNameUpdate(100) });

export function registerCategoryRoutes(app: FastifyInstance, db: Database, guards: Guards): void {
  const context = (request: FastifyRequest): AuditRequestContext => ({
    requestId: request.id,
    ipAddress: request.ip,
    actor: { userId: request.auth!.user.id, email: request.auth!.user.email },
  });

  app.get("/categories", { preHandler: guards.requireUser }, async (request) => {
    const query = parseInput(listQuerySchema, request.query);
    return listCategories(db, context(request), query.q || undefined);
  });

  app.post("/categories", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = parseInput(categoryCreateSchema, request.body);
    const category = await createCategory(db, context(request), body.name);
    return reply.status(201).send({ category });
  });

  app.put("/categories/:id", { preHandler: guards.requireAdmin }, async (request) => {
    const { id } = parseInput(z.object({ id: uuidSchema }), request.params);
    const body = parseInput(categoryUpdateSchema, request.body);
    return { category: await renameCategory(db, context(request), id, body.name) };
  });

  app.delete("/categories/:id", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { id } = parseInput(z.object({ id: uuidSchema }), request.params);
    await deleteCategory(db, context(request), id);
    return reply.status(204).send();
  });
}

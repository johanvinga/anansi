import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db.js";
import { translatedNameInput, translatedNameUpdate } from "../lib/translations.js";
import { optionalPaginationSchema, parseInput, uuidSchema } from "../lib/validation.js";
import { resolvePage } from "../lib/pagination.js";
import { createIndependentAttribute, listIndependentAttributes, removeIndependentAttribute, renameIndependentAttribute } from "../services/independent-attribute.service.js";
import { migrateLegacyFields } from "../services/attribute-set.service.js";
import { auditContext, type Guards } from "./route-helpers.js";

const createSchema = z.object({
  name: translatedNameInput(100),
  dataType: z.enum(["text", "number", "decimal", "boolean", "date", "select"]).default("text"),
  unit: z.string().trim().max(20).nullish(),
  options: z.array(translatedNameInput(100)).max(100).optional(),
});
const updateSchema = z.object({ name: translatedNameUpdate(100) }).strict();
const paramsSchema = z.object({ id: uuidSchema });
const listQuerySchema = optionalPaginationSchema.extend({ q: z.string().trim().max(200).optional() });

export function registerIndependentAttributeRoutes(app: FastifyInstance, db: Database, guards: Guards) {
  app.get("/attributes", { preHandler: guards.requireUser }, async (request) => {
    const query = parseInput(listQuerySchema, request.query);
    return listIndependentAttributes(db, auditContext(request), { q: query.q || undefined, page: resolvePage(query) });
  });
  app.post("/attributes", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = parseInput(createSchema, request.body);
    const attribute = await createIndependentAttribute(db, auditContext(request), body);
    return reply.status(201).send({ attribute });
  });
  app.post("/attributes/migrate-legacy", { preHandler: guards.requireAdmin }, async (request) =>
    migrateLegacyFields(db, auditContext(request)),
  );
  app.put("/attributes/:id", { preHandler: guards.requireAdmin }, async (request) => {
    const { id } = parseInput(paramsSchema, request.params);
    const { name } = parseInput(updateSchema, request.body);
    return { attribute: await renameIndependentAttribute(db, auditContext(request), id, name) };
  });
  app.delete("/attributes/:id", { preHandler: guards.requireAdmin }, async (request) => {
    const { id } = parseInput(paramsSchema, request.params);
    return removeIndependentAttribute(db, auditContext(request), id);
  });
}

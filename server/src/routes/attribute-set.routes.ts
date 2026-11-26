import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db.js";
import { optionalPaginationSchema, parseInput, uuidSchema } from "../lib/validation.js";
import { resolvePage } from "../lib/pagination.js";
import { translatedNameInput, translatedNameUpdate } from "../lib/translations.js";
import {
  addField,
  addSharedField,
  createAttributeSet,
  createSharedField,
  deleteAttributeSet,
  getAttributeSet,
  listAttributeSets,
  makeFieldShared,
  removeField,
  renameAttributeSet,
  reorderFields,
  updateField,
} from "../services/attribute-set.service.js";
import { auditContext, type Guards } from "./route-helpers.js";

const setUpdateSchema = z.object({ name: translatedNameUpdate(100) });
const listQuerySchema = optionalPaginationSchema.extend({ q: z.string().trim().max(200).optional() });
const dataTypeSchema = z.enum(["text", "number", "decimal", "boolean", "date", "select"]);
const fieldNameSchema = translatedNameInput(100);
const unitSchema = z.string().trim().max(20).nullish();
const optionLabelSchema = translatedNameInput(100);

const createFieldSchema = z.object({
  name: fieldNameSchema,
  dataType: dataTypeSchema,
  unit: unitSchema,
  isRequired: z.boolean().optional(),
  options: z.array(optionLabelSchema).max(100).optional(),
});
const setCreateSchema = z.object({
  name: translatedNameInput(100),
  fields: z.array(createFieldSchema).max(100).optional(),
});

const updateFieldSchema = z
  .object({
    name: translatedNameUpdate(100).optional(),
    dataType: dataTypeSchema.optional(),
    unit: unitSchema,
    isRequired: z.boolean().optional(),
    sortOrder: z.number().int().min(1).max(100_000).optional(),
    options: z.array(z.object({ id: uuidSchema.optional(), label: optionLabelSchema })).max(100).optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "At least one field must be provided.",
  });

const reorderSchema = z.object({ fieldIds: z.array(uuidSchema).min(1).max(500) });
const setParams = z.object({ id: uuidSchema });
const fieldParams = z.object({ id: uuidSchema, fieldId: uuidSchema });

export function registerAttributeSetRoutes(app: FastifyInstance, db: Database, guards: Guards): void {
  app.get("/attribute-sets", { preHandler: guards.requireUser }, async (request) => {
    const query = parseInput(listQuerySchema, request.query);
    return listAttributeSets(db, auditContext(request), { q: query.q || undefined, page: resolvePage(query) });
  });

  app.post("/attribute-sets", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = parseInput(setCreateSchema, request.body);
    const attributeSet = await createAttributeSet(db, auditContext(request), body.name, body.fields);
    return reply.status(201).send({ attributeSet });
  });

  app.get("/attribute-sets/:id", { preHandler: guards.requireUser }, async (request) => {
    const { id } = parseInput(setParams, request.params);
    return { attributeSet: await getAttributeSet(db, auditContext(request), id) };
  });

  app.put("/attribute-sets/:id", { preHandler: guards.requireAdmin }, async (request) => {
    const { id } = parseInput(setParams, request.params);
    const body = parseInput(setUpdateSchema, request.body);
    return { attributeSet: await renameAttributeSet(db, auditContext(request), id, body.name) };
  });

  app.delete("/attribute-sets/:id", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { id } = parseInput(setParams, request.params);
    await deleteAttributeSet(db, auditContext(request), id);
    return reply.status(204).send();
  });

  app.post("/attribute-sets/:id/fields", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { id } = parseInput(setParams, request.params);
    const body = parseInput(createFieldSchema, request.body);
    const attributeSet = await addField(db, auditContext(request), id, body);
    return reply.status(201).send({ attributeSet });
  });

  app.post("/attribute-sets/:id/shared-fields", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { id } = parseInput(setParams, request.params);
    const body = parseInput(z.object({ attributeId: uuidSchema, isRequired: z.boolean().default(false) }), request.body);
    const attributeSet = await addSharedField(db, auditContext(request), id, body.attributeId, body.isRequired);
    return reply.status(201).send({ attributeSet });
  });

  app.post("/attribute-sets/:id/shared-fields/create", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { id } = parseInput(setParams, request.params);
    const input = parseInput(createFieldSchema, request.body);
    const attributeSet = await createSharedField(db, auditContext(request), id, input);
    return reply.status(201).send({ attributeSet });
  });

  app.post("/attribute-sets/:id/fields/:fieldId/share", { preHandler: guards.requireAdmin }, async (request) => {
    const { id, fieldId } = parseInput(fieldParams, request.params);
    const { attributeId } = parseInput(z.object({ attributeId: uuidSchema.nullable() }), request.body);
    return { attributeSet: await makeFieldShared(db, auditContext(request), id, fieldId, attributeId) };
  });

  app.post("/attribute-sets/:id/fields/reorder", { preHandler: guards.requireAdmin }, async (request) => {
    const { id } = parseInput(setParams, request.params);
    const body = parseInput(reorderSchema, request.body);
    return { attributeSet: await reorderFields(db, auditContext(request), id, body.fieldIds) };
  });

  app.put("/attribute-sets/:id/fields/:fieldId", { preHandler: guards.requireAdmin }, async (request) => {
    const { id, fieldId } = parseInput(fieldParams, request.params);
    const body = parseInput(updateFieldSchema, request.body);
    return { attributeSet: await updateField(db, auditContext(request), id, fieldId, body) };
  });

  app.delete("/attribute-sets/:id/fields/:fieldId", { preHandler: guards.requireAdmin }, async (request) => {
    const { id, fieldId } = parseInput(fieldParams, request.params);
    return removeField(db, auditContext(request), id, fieldId);
  });
}

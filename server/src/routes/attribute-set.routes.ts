import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db.js";
import { parseInput, uuidSchema } from "../lib/validation.js";
import {
  addField,
  createAttributeSet,
  deleteAttributeSet,
  getAttributeSet,
  listAttributeSets,
  removeField,
  renameAttributeSet,
  reorderFields,
  updateField,
} from "../services/attribute-set.service.js";
import { auditContext, type Guards } from "./route-helpers.js";

const setNameSchema = z.object({ name: z.string().trim().min(1, "Name is required.").max(100) });
const dataTypeSchema = z.enum(["text", "number", "decimal", "boolean", "date", "select"]);
const fieldNameSchema = z.string().trim().min(1, "Name is required.").max(100);
const unitSchema = z.string().trim().max(20).nullish();
const optionLabelSchema = z.string().trim().min(1, "Option labels cannot be empty.").max(100);

const createFieldSchema = z.object({
  name: fieldNameSchema,
  dataType: dataTypeSchema,
  unit: unitSchema,
  isRequired: z.boolean().optional(),
  options: z.array(optionLabelSchema).max(100).optional(),
});

const updateFieldSchema = z
  .object({
    name: fieldNameSchema.optional(),
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
  app.get("/attribute-sets", { preHandler: guards.requireUser }, async (request) =>
    listAttributeSets(db, auditContext(request)),
  );

  app.post("/attribute-sets", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = parseInput(setNameSchema, request.body);
    const attributeSet = await createAttributeSet(db, auditContext(request), body.name);
    return reply.status(201).send({ attributeSet });
  });

  app.get("/attribute-sets/:id", { preHandler: guards.requireUser }, async (request) => {
    const { id } = parseInput(setParams, request.params);
    return { attributeSet: await getAttributeSet(db, auditContext(request), id) };
  });

  app.put("/attribute-sets/:id", { preHandler: guards.requireAdmin }, async (request) => {
    const { id } = parseInput(setParams, request.params);
    const body = parseInput(setNameSchema, request.body);
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

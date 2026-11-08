import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db.js";
import { isCurrencyCode } from "../lib/currency.js";
import { paginationSchema, parseInput, uuidSchema } from "../lib/validation.js";
import {
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  listSupplierProducts,
  updateProduct,
} from "../services/product.service.js";
import { auditContext, type Guards } from "./route-helpers.js";

/** numeric(12,2): up to 10 integer digits, at most 2 decimal places, never negative. */
const COST_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;

const costSchema = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === "number" ? String(value) : value.trim()))
  .pipe(z.string().regex(COST_PATTERN, "Cost must be zero or more with at most 2 decimal places."));

const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isCurrencyCode, "Enter a valid ISO 4217 currency code.");

const attributeValueSchema = z.object({
  fieldId: uuidSchema,
  value: z.union([z.string().max(5000), z.number(), z.boolean(), z.null()]),
});

const productBodySchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(200),
  supplierSku: z.string().trim().min(1, "Supplier SKU is required.").max(100),
  minQuantity: z
    .number({ error: "Minimum quantity must be a whole number." })
    .int("Minimum quantity must be a whole number.")
    .min(0, "Minimum quantity cannot be negative.")
    .max(2_147_483_647),
  cost: costSchema,
  currency: currencySchema,
  attributeSetId: uuidSchema.nullish(),
  attributeValues: z.array(attributeValueSchema).max(200).optional(),
});

const productUpdateSchema = productBodySchema.extend({ supplierId: uuidSchema.optional() });

const listQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  supplierId: uuidSchema.optional(),
});

const idParams = z.object({ id: uuidSchema });

export function registerProductRoutes(app: FastifyInstance, db: Database, guards: Guards): void {
  app.get("/products", { preHandler: guards.requireUser }, async (request) => {
    const query = parseInput(listQuerySchema, request.query);
    return listProducts(db, auditContext(request), { ...query, q: query.q || undefined });
  });

  app.get("/suppliers/:id/products", { preHandler: guards.requireUser }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const query = parseInput(listQuerySchema.omit({ supplierId: true }), request.query);
    return listSupplierProducts(db, auditContext(request), id, { ...query, q: query.q || undefined });
  });

  app.post("/suppliers/:id/products", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(productBodySchema, request.body);
    const product = await createProduct(db, auditContext(request), id, body);
    return reply.status(201).send({ product });
  });

  app.get("/products/:id", { preHandler: guards.requireUser }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { product: await getProduct(db, auditContext(request), id) };
  });

  app.put("/products/:id", { preHandler: guards.requireAdmin }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(productUpdateSchema, request.body);
    return { product: await updateProduct(db, auditContext(request), id, body) };
  });

  app.delete("/products/:id", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    await deleteProduct(db, auditContext(request), id);
    return reply.status(204).send();
  });
}

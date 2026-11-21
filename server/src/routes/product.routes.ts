import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, errors } from "../errors.js";
import { MAX_PRODUCT_IMAGE_BYTES } from "../lib/product-image.js";
import type { AssetDeps } from "../services/asset.service.js";
import { deleteProductImage, getProductImage, uploadProductImage } from "../services/product-image.service.js";
import { categoryInputSchema } from "../lib/category-input.js";
import { isCurrencyCode } from "../lib/currency.js";
import { translatedNameInput, translatedNameUpdate, translatedTextInput } from "../lib/translations.js";
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
  name: translatedNameInput(200),
  description: translatedTextInput,
  supplierSku: z.string().trim().min(1, "Supplier SKU is required.").max(100),
  minQuantity: z
    .number({ error: "Minimum quantity must be a whole number." })
    .int("Minimum quantity must be a whole number.")
    .min(0, "Minimum quantity cannot be negative.")
    .max(2_147_483_647),
  cost: costSchema,
  currency: currencySchema,
  categories: z.array(categoryInputSchema).max(100).optional(),
  attributeSetId: uuidSchema.nullish(),
  attributeValues: z.array(attributeValueSchema).max(200).optional(),
  directAttributeValues: z.array(attributeValueSchema).max(200).optional(),
  catalogSource: z.object({
    catalogId: uuidSchema,
    pageNumbers: z.array(z.number().int().positive()).min(1).max(50),
  }).optional(),
});

const productUpdateSchema = productBodySchema.extend({
  name: translatedNameUpdate(200),
  supplierId: uuidSchema.optional(),
  minQuantity: productBodySchema.shape.minQuantity.nullable(),
  cost: costSchema.nullable(),
  currency: currencySchema.nullable(),
});

const listQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  supplierId: uuidSchema.optional(),
  category: z.preprocess(
    (value) => value === undefined ? [] : Array.isArray(value) ? value : [value],
    z.array(uuidSchema).max(20),
  ),
  uncategorized: z.enum(["true", "false"]).optional().transform((value) => value === "true"),
});

const idParams = z.object({ id: uuidSchema });

export function registerProductRoutes(app: FastifyInstance, deps: AssetDeps, guards: Guards): void {
  const { db } = deps;
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

  app.get("/products/:id/image", { preHandler: guards.requireUser }, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const image = await getProductImage(deps, auditContext(request), id);
    return reply.header("Content-Type", image.mimeType).header("Content-Length", String(image.sizeBytes))
      .header("X-Content-Type-Options", "nosniff").header("Cache-Control", "private, no-store").send(image.buffer);
  });

  app.put("/products/:id/image", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    let file: { buffer: Buffer; mimeType: string } | undefined;
    for await (const part of request.parts({ limits: { fileSize: MAX_PRODUCT_IMAGE_BYTES, files: 1, fields: 0, parts: 1 } })) {
      if (part.type !== "file" || part.fieldname !== "file" || file) {
        if (part.type === "file") part.file.resume();
        throw errors.validation([{ field: "file", message: "Provide exactly one image file." }]);
      }
      const buffer = await part.toBuffer();
      if (part.file.truncated) throw new AppError(413, "PAYLOAD_TOO_LARGE", "The image exceeds 5 MiB.");
      file = { buffer, mimeType: part.mimetype };
    }
    if (!file) throw errors.validation([{ field: "file", message: "An image file is required." }]);
    const result = await uploadProductImage(deps, auditContext(request), id, file.buffer, file.mimeType);
    if (result.cleanupPending) reply.header("X-Storage-Cleanup", "pending");
    return { image: result.image };
  });

  app.delete("/products/:id/image", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    await deleteProductImage(deps, auditContext(request), id);
    return reply.header("X-Storage-Cleanup", "pending").status(204).send();
  });

  app.put("/products/:id", { preHandler: guards.requireAdmin }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(productUpdateSchema, request.body);
    return { product: await updateProduct(db, auditContext(request), id, body) };
  });

  app.delete("/products/:id", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const cleanupPending = await deleteProduct(db, auditContext(request), id);
    if (cleanupPending) reply.header("X-Storage-Cleanup", "pending");
    return reply.status(204).send();
  });
}

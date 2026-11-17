import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, errors } from "../errors.js";
import { categoryInputSchema } from "../lib/category-input.js";
import { attachmentDisposition, PDF_MIME_TYPE } from "../lib/pdf.js";
import { paginationSchema, parseInput, uuidSchema } from "../lib/validation.js";
import type { AuditRequestContext } from "../services/audit.service.js";
import type { AssetDeps } from "../services/asset.service.js";
import type { CatalogExtractionQueue } from "../services/catalog-extraction.queue.js";
import { previewCatalogImport } from "../services/catalog-import-preview.js";
import { importCatalogProducts } from "../services/catalog-import.service.js";
import { isCurrencyCode } from "../lib/currency.js";
import {
  deleteCatalog,
  getCatalogExtraction,
  listAllCatalogs,
  listCatalogs,
  prepareCatalogDownload,
  prepareCatalogImage,
  startCatalogExtraction,
  updateCatalog,
  uploadCatalog,
} from "../services/catalog.service.js";

interface Guards {
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const nameSchema = z.string().trim().min(1, "Name is required.").max(200);
// Optional since FR-CLG-01 was relaxed at the user's request (2026-11-08).
const versionSchema = z.string().trim().max(50).nullish();
const categoriesSchema = z.array(categoryInputSchema).max(50);

const createCatalogSchema = z.object({
  name: nameSchema,
  version: versionSchema.transform((v) => v || null),
  supplierId: uuidSchema.nullish().transform((v) => v || null),
  categories: z.string().optional().transform((value, ctx) => {
    if (value === undefined) return [];
    try {
      const result = categoriesSchema.safeParse(JSON.parse(value));
      if (result.success) return result.data;
    } catch {
      // Report malformed JSON as a validation error.
    }
    ctx.addIssue({ code: "custom", message: "Invalid categories." });
    return z.NEVER;
  }),
});

const updateCatalogSchema = z
  .object({
    name: nameSchema.optional(),
    // undefined means unchanged; null clears the version.
    version: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .nullish()
      .transform((v) => (v === undefined ? undefined : v || null)),
    supplierId: uuidSchema.nullable().optional(),
    categories: categoriesSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.version !== undefined || value.supplierId !== undefined || value.categories !== undefined, {
    message: "At least one field must be provided.",
  });

const idParamsSchema = z.object({ id: uuidSchema });
const catalogParamsSchema = z.object({ catalogId: uuidSchema });
const catalogImageParamsSchema = z.object({ catalogId: uuidSchema, jobId: uuidSchema, imageId: uuidSchema });
const previewSchema = z.object({
  jobId: uuidSchema,
  indexes: z.array(z.number().int().min(0).max(999)).min(1).max(1000),
});
const importSchema = z.object({
  jobId: uuidSchema,
  supplierId: uuidSchema,
  products: z.array(z.object({
    index: z.number().int().min(0).max(999),
    sku: z.string().trim().min(1).max(100),
    imageId: uuidSchema.nullish(),
    cost: z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/).optional(),
    currency: z.string().trim().toUpperCase().refine(isCurrencyCode).optional(),
    minQuantity: z.number().int().min(0).max(2_147_483_647).optional(),
    categoryDecisions: z.array(z.discriminatedUnion("action", [
      z.object({ name: z.string().trim().min(1).max(100), action: z.literal("reuse"), categoryId: uuidSchema }),
      z.object({ name: z.string().trim().min(1).max(100), action: z.literal("create"), parentId: uuidSchema.nullable() }),
    ])).max(30).optional(),
    additionalCategoryIds: z.array(uuidSchema).max(30).optional(),
    attributeValues: z.array(z.object({
      name: z.string().trim().min(1).max(100),
      value: z.union([z.string().trim().min(1).max(2000), z.boolean()]),
    })).max(100).optional(),
  })).min(1).max(1000),
  mappings: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    attributeId: uuidSchema.nullable(),
    skip: z.boolean().optional(),
  }).refine((mapping) => !mapping.skip || mapping.attributeId === null, {
    message: "A skipped attribute cannot be mapped to an existing attribute.",
  })).max(10000).default([]),
  categoryTreeVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

/** Query for the global catalogs list (the catalogs page). */
const globalListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  // Accepts `category=<id>` once or repeated (`category=<id>&category=<id>`).
  category: z
    .preprocess(
      (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]),
      z.array(uuidSchema).max(20),
    )
    .default([]),
});

interface CatalogRouteDeps extends AssetDeps {
  extractionQueue: CatalogExtractionQueue | undefined;
}

export function registerCatalogRoutes(app: FastifyInstance, deps: CatalogRouteDeps, guards: Guards): void {
  const context = (request: FastifyRequest): AuditRequestContext => ({
    requestId: request.id,
    ipAddress: request.ip,
    actor: { userId: request.auth!.user.id, email: request.auth!.user.email },
  });

  app.get("/catalogs", { preHandler: guards.requireUser }, async (request) => {
    const query = parseInput(globalListQuerySchema, request.query);
    return listAllCatalogs(deps.db, context(request), {
      q: query.q || undefined,
      categoryIds: query.category,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  app.get("/suppliers/:id/catalogs", { preHandler: guards.requireUser }, async (request) => {
    const { id } = parseInput(idParamsSchema, request.params);
    return listCatalogs(deps.db, context(request), id);
  });

  const handleUpload = async (request: FastifyRequest, reply: FastifyReply, supplierId?: string) => {

    // Read all parts in one pass so text fields are available regardless of their order.
    const fields: Record<string, string> = {};
    let file: { buffer: Buffer; originalFileName: string; mimeType: string } | null = null;
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "file" || file) {
          part.file.resume();
          continue;
        }
        const buffer = await part.toBuffer();
        if (part.file.truncated) {
          throw new AppError(413, "PAYLOAD_TOO_LARGE", "The file exceeds the maximum upload size.");
        }
        file = { buffer, originalFileName: part.filename, mimeType: part.mimetype };
      } else {
        fields[part.fieldname] = String(part.value ?? "");
      }
    }

    if (!file) {
      throw errors.validation([{ field: "file", message: "A PDF file is required." }]);
    }
    const metadata = parseInput(createCatalogSchema, fields);
    if (supplierId && metadata.supplierId && supplierId !== metadata.supplierId) {
      throw errors.validation([{ field: "supplierId", message: "Supplier does not match the URL." }]);
    }
    const catalog = await uploadCatalog(deps, context(request), supplierId ?? metadata.supplierId, file, metadata);
    return reply.status(201).send({ catalog });
  };
  app.post("/catalogs", { preHandler: guards.requireAdmin }, async (request, reply) => handleUpload(request, reply));
  app.post("/suppliers/:id/catalogs", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params);
    return handleUpload(request, reply, id);
  });

  app.get("/catalogs/:catalogId/extraction", { preHandler: guards.requireUser }, async (request) => {
    if (!deps.extractionQueue) throw new AppError(503, "FEATURE_DISABLED", "Catalog analysis is disabled.");
    const { catalogId } = parseInput(catalogParamsSchema, request.params);
    return getCatalogExtraction(deps.db, context(request), catalogId);
  });

  app.post("/catalogs/:catalogId/extraction", { preHandler: guards.requireAdmin }, async (request, reply) => {
    if (!deps.extractionQueue) throw new AppError(503, "FEATURE_DISABLED", "Catalog analysis is disabled.");
    const { catalogId } = parseInput(catalogParamsSchema, request.params);
    const job = await startCatalogExtraction(deps, context(request), catalogId, deps.extractionQueue);
    return reply.status(202).send({ job });
  });

  app.post("/catalogs/:catalogId/extraction/preview", { preHandler: guards.requireAdmin }, async (request) => {
    if (!deps.extractionQueue) throw new AppError(503, "FEATURE_DISABLED", "Catalog analysis is disabled.");
    const { catalogId } = parseInput(catalogParamsSchema, request.params);
    const body = parseInput(previewSchema, request.body);
    return previewCatalogImport(deps.db, context(request), catalogId, body.jobId, body.indexes);
  });

  app.get("/catalogs/:catalogId/extraction/:jobId/images/:imageId", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { catalogId, jobId, imageId } = parseInput(catalogImageParamsSchema, request.params);
    const image = await prepareCatalogImage(deps, context(request), catalogId, jobId, imageId);
    return reply.header("Content-Type", image.mimeType).header("Content-Length", String(image.sizeBytes))
      .header("X-Content-Type-Options", "nosniff").header("Cache-Control", "private, no-store")
      .send(image.buffer);
  });

  app.post("/catalogs/:catalogId/extraction/import", { preHandler: guards.requireAdmin }, async (request) => {
    if (!deps.extractionQueue) throw new AppError(503, "FEATURE_DISABLED", "Catalog analysis is disabled.");
    const { catalogId } = parseInput(catalogParamsSchema, request.params);
    const body = parseInput(importSchema, request.body);
    return importCatalogProducts(deps, context(request), catalogId, body.jobId, body.supplierId, body.products, body.mappings, body.categoryTreeVersion);
  });

  app.get("/catalogs/:catalogId/download", { preHandler: guards.requireUser }, async (request, reply) => {
    const { catalogId } = parseInput(catalogParamsSchema, request.params);
    const download = await prepareCatalogDownload(deps, context(request), catalogId);

    reply.header("Content-Type", PDF_MIME_TYPE);
    reply.header("Content-Length", String(download.sizeBytes));
    reply.header("Content-Disposition", attachmentDisposition(download.fileName));
    reply.header("Cache-Control", "private, no-store");
    return reply.send(download.stream);
  });

  app.patch("/catalogs/:catalogId", { preHandler: guards.requireAdmin }, async (request) => {
    const { catalogId } = parseInput(catalogParamsSchema, request.params);
    const body = parseInput(updateCatalogSchema, request.body);
    return { catalog: await updateCatalog(deps.db, context(request), catalogId, body) };
  });

  app.delete("/catalogs/:catalogId", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { catalogId } = parseInput(catalogParamsSchema, request.params);
    await deleteCatalog(deps, context(request), catalogId);
    return reply.status(204).send();
  });
}

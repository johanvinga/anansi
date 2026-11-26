import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, errors } from "../errors.js";
import { attachmentDisposition, inlineDisposition, PDF_MIME_TYPE } from "../lib/pdf.js";
import { optionalPaginationSchema, paginationSchema, parseInput, uuidSchema } from "../lib/validation.js";
import { resolvePage } from "../lib/pagination.js";
import type { AuditRequestContext } from "../services/audit.service.js";
import type { CatalogExtractionQueue } from "../services/catalog-extraction.queue.js";
import {
  type CatalogDeps,
  deleteCatalog,
  getCatalog,
  getCatalogExtraction,
  listAllCatalogs,
  listCatalogs,
  listRecentCatalogViews,
  prepareCatalogDownload,
  prepareCatalogImage,
  prepareCatalogView,
  startCatalogExtraction,
  updateCatalog,
  uploadCatalog,
} from "../services/catalog.service.js";
import {
  applyCatalogSupplierReview,
  applyCatalogTagReview,
  reviewCatalogSupplierAnalysis,
  reviewCatalogTagAnalysis,
} from "../services/catalog-tag-review.service.js";

interface Guards {
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const nameSchema = z.string().trim().min(1, "Name is required.").max(200);
// Optional since FR-CLG-01 was relaxed at the user's request (2026-11-08).
const versionSchema = z.string().trim().max(50).nullish();
const tagsSchema = z.array(uuidSchema).max(50);

const createCatalogSchema = z.object({
  name: z.string().trim().max(200).optional().transform((value) => value || undefined),
  version: versionSchema.transform((v) => v || null),
  supplierId: uuidSchema.nullish().transform((v) => v || null),
  tags: z.string().optional().transform((value, ctx) => {
    if (value === undefined) return [];
    try {
      const result = tagsSchema.safeParse(JSON.parse(value));
      if (result.success) return result.data;
    } catch {
      // Report malformed JSON as a validation error.
    }
    ctx.addIssue({ code: "custom", message: "Invalid tags." });
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
    tags: tagsSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.version !== undefined || value.supplierId !== undefined || value.tags !== undefined, {
    message: "At least one field must be provided.",
  });

const idParamsSchema = z.object({ id: uuidSchema });
const catalogParamsSchema = z.object({ catalogId: uuidSchema });
const catalogImageParamsSchema = z.object({ catalogId: uuidSchema, jobId: uuidSchema, imageId: uuidSchema });
const startExtractionSchema = z.object({
  prompt: z.enum(["supplier", "tags"]).default("supplier"),
});

const tagReviewSchema = z.object({
  jobId: uuidSchema,
  catalogTagIds: z.array(uuidSchema).max(100).default([]),
  newCatalogTags: z.array(z.object({ en: z.string().trim().min(1).max(100), fr: z.string().trim().min(1).max(100).optional() })).max(100).default([]),
  productTagIds: z.array(z.object({
    productId: uuidSchema,
    tagIds: z.array(uuidSchema).max(100).default([]),
    newTags: z.array(z.object({ en: z.string().trim().min(1).max(100), fr: z.string().trim().min(1).max(100).optional() })).max(100).default([]),
  })).max(1000).default([]),
});

const supplierReviewSchema = z.object({
  jobId: uuidSchema,
  action: z.enum(["reuse", "create"]),
  supplierId: uuidSchema.optional(),
  name: z.string().trim().min(1).max(200),
  address: z.object({
    street: z.string().trim().max(200).nullable(),
    city: z.string().trim().max(100).nullable(),
    stateRegion: z.string().trim().max(100).nullable(),
    postalCode: z.string().trim().max(20).nullable(),
    country: z.string().trim().max(100).nullable(),
  }),
  website: z.string().trim().max(500).nullable().optional(),
  contacts: z.array(z.object({ name: z.string().trim().min(1).max(200), role: z.string().trim().max(200).nullable() })).max(20).default([]),
});

/** Query for the global catalogs list (the catalogs page). */
const globalListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  tag: z
    .preprocess(
      (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]),
      z.array(uuidSchema).max(20),
    )
    .default([]),
});

interface CatalogRouteDeps extends CatalogDeps {
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
      tagIds: query.tag,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  app.get("/catalogs/recent", { preHandler: guards.requireUser }, async (request) =>
    listRecentCatalogViews(deps.db, context(request)));

  app.get("/suppliers/:id/catalogs", { preHandler: guards.requireUser }, async (request) => {
    const { id } = parseInput(idParamsSchema, request.params);
    const query = parseInput(optionalPaginationSchema, request.query);
    return listCatalogs(deps.db, context(request), id, resolvePage(query));
  });

  app.get("/catalogs/:catalogId", { preHandler: guards.requireUser }, async (request) => {
    const { catalogId } = parseInput(catalogParamsSchema, request.params);
    return { catalog: await getCatalog(deps.db, context(request), catalogId) };
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
    const result = await uploadCatalog(deps, context(request), supplierId ?? metadata.supplierId, file, metadata);
    return reply.status(201).send({ catalog: result.catalog });
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
    const body = parseInput(startExtractionSchema, request.body);
    const job = await startCatalogExtraction(deps, context(request), catalogId, deps.extractionQueue, body.prompt);
    return reply.status(202).send({ job });
  });

  app.get("/catalogs/:catalogId/extraction/:jobId/tag-review", { preHandler: guards.requireUser }, async (request) => {
    const { catalogId, jobId } = parseInput(catalogImageParamsSchema.pick({ catalogId: true, jobId: true }), request.params);
    return reviewCatalogTagAnalysis(deps.db, context(request), catalogId, jobId);
  });

  app.post("/catalogs/:catalogId/extraction/tag-review", { preHandler: guards.requireAdmin }, async (request) => {
    const { catalogId } = parseInput(catalogParamsSchema, request.params);
    const body = parseInput(tagReviewSchema, request.body);
    return applyCatalogTagReview(deps.db, context(request), catalogId, {
      ...body,
      newCatalogTags: body.newCatalogTags.map((tag) => ({ en: tag.en, fr: tag.fr ?? tag.en })),
      productTagIds: body.productTagIds.map((assignment) => ({
        ...assignment,
        newTags: assignment.newTags.map((tag) => ({ en: tag.en, fr: tag.fr ?? tag.en })),
      })),
    });
  });

  app.get("/catalogs/:catalogId/extraction/:jobId/supplier-review", { preHandler: guards.requireUser }, async (request) => {
    const { catalogId, jobId } = parseInput(catalogImageParamsSchema.pick({ catalogId: true, jobId: true }), request.params);
    return reviewCatalogSupplierAnalysis(deps.db, context(request), catalogId, jobId);
  });

  app.post("/catalogs/:catalogId/extraction/supplier-review", { preHandler: guards.requireAdmin }, async (request) => {
    const { catalogId } = parseInput(catalogParamsSchema, request.params);
    const body = parseInput(supplierReviewSchema, request.body);
    return applyCatalogSupplierReview(deps.db, context(request), catalogId, body);
  });

  app.get("/catalogs/:catalogId/extraction/:jobId/images/:imageId", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { catalogId, jobId, imageId } = parseInput(catalogImageParamsSchema, request.params);
    const image = await prepareCatalogImage(deps, context(request), catalogId, jobId, imageId);
    return reply.header("Content-Type", image.mimeType).header("Content-Length", String(image.sizeBytes))
      .header("X-Content-Type-Options", "nosniff").header("Cache-Control", "private, no-store")
      .send(image.buffer);
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

  app.get("/catalogs/:catalogId/view", { preHandler: guards.requireUser }, async (request, reply) => {
    const { catalogId } = parseInput(catalogParamsSchema, request.params);
    const view = await prepareCatalogView(deps, context(request), catalogId);

    reply.header("Content-Type", PDF_MIME_TYPE);
    reply.header("Content-Length", String(view.sizeBytes));
    reply.header("Content-Disposition", inlineDisposition(view.fileName));
    reply.header("Content-Security-Policy", "default-src 'none'");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "private, no-store");
    return reply.send(view.stream);
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

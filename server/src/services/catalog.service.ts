import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { CatalogAnalysisStatus, CatalogExtractionJob, Prisma } from "../generated/prisma/client.js";
import type { Database } from "../db.js";
import { AppError, errors } from "../errors.js";
import { listResponse, optionalSkipTake, skipTake, type PageRequest } from "../lib/pagination.js";
import { hasPdfSignature, PDF_MIME_TYPE, sanitizeFileName } from "../lib/pdf.js";
import { nameKeyOf } from "../lib/text.js";
import type { CatalogExtractionQueue } from "./catalog-extraction.queue.js";
import {
  AuditAction,
  diffFields,
  recordAudit,
  type AuditRequestContext,
} from "./audit.service.js";
import { removeStoredFiles, type AssetDeps, type UploadedFile } from "./asset.service.js";
import { queueStoredFileRemoval } from "./stored-file-cleanup.js";
import { readPrivateImage } from "../lib/read-private-image.js";
import { resolveTagIds } from "./tag.service.js";
export interface CatalogDeps extends AssetDeps {
}

export interface CatalogMetadata {
  name?: string | undefined;
  /** Optional since FR-CLG-01 was relaxed at the user's request (2026-11-08). */
  version: string | null;
  tags?: string[] | undefined;
}

export interface CatalogUploadOptions {
  idempotencyKey?: string | undefined;
}

export interface CatalogUploadResult {
  catalog: CatalogDto;
  replayed: boolean;
}

export interface CatalogUpdate {
  name?: string | undefined;
  version?: string | null | undefined;
  supplierId?: string | null | undefined;
  tags?: string[] | undefined;
}

export interface CatalogDto {
  id: string;
  supplierId: string | null;
  name: string;
  version: string | null;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedById: string | null;
  analysisStatus: CatalogAnalysisStatus;
  createdAt: string;
  updatedAt: string;
  tags: { id: string; name: { en: string; fr: string } }[];
}

export interface CatalogSummaryDto extends CatalogDto {
  supplierName: string | null;
  supplierTagNames: string[];
  pinned: boolean;
}

export interface ListCatalogsFilters {
  q?: string | undefined;
  tagIds?: string[] | undefined;
  page: number;
  pageSize: number;
}

const catalogInclude = {
  tags: { include: { tag: true } },
} satisfies Prisma.CatalogInclude;
const summaryInclude = {
  ...catalogInclude,
  supplier: { select: { name: true } },
} satisfies Prisma.CatalogInclude;
type CatalogRow = Prisma.CatalogGetPayload<{ include: typeof catalogInclude }>;
type CatalogSummaryRow = Prisma.CatalogGetPayload<{ include: typeof summaryInclude }>;

export interface CatalogDownload {
  fileName: string;
  sizeBytes: number;
  stream: Readable;
}

export function catalogNameFromFileName(fileName: string): string {
  const stem = sanitizeFileName(fileName).replace(/\.pdf$/i, "").trim();
  let name = "";
  for (const character of stem) {
    if (name.length + character.length > 200) break;
    name += character;
  }
  return name.trim() || "Catalog";
}

export interface CatalogExtractionJobDto {
  jobId: string;
  prompt: "supplier" | "tags";
  status: CatalogAnalysisStatus;
  stage: string;
  progress: number;
  currentPage: number;
  totalPages: number;
  productsIdentified: number;
  error: string | null;
  results: Prisma.JsonValue | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toExtractionJobDto(job: CatalogExtractionJob): CatalogExtractionJobDto {
  return {
    jobId: job.id,
    prompt: job.prompt,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    currentPage: job.currentPage,
    totalPages: job.totalPages,
    productsIdentified: job.productsIdentified,
    error: job.processingError,
    results: job.results,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

async function enqueueExtraction(
  db: Database,
  queue: CatalogExtractionQueue,
  job: { id: string; catalogId: string; prompt: "supplier" | "tags" },
  log: AssetDeps["log"],
): Promise<void> {
  try {
    await queue.enqueue(job.id, job.prompt);
  } catch (error) {
    await db.$transaction([
      db.catalogExtractionJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          stage: "failed",
          processingError: "The extraction job could not be queued. Retry the analysis.",
          completedAt: new Date(),
        },
      }),
      db.catalog.update({ where: { id: job.catalogId }, data: { analysisStatus: "failed" } }),
    ]);
    log.error(
      { catalogId: job.catalogId, errorName: error instanceof Error ? error.name : "UnknownError" },
      "Could not queue catalog extraction",
    );
  }
}

/**
 * Lists catalogs across all suppliers (the catalogs page). Search matches catalog name,
 * version, supplier name, or catalog tag name; tagIds matches catalog or effective supplier tags.
 * Sorted newest first, the last-added order the page defaults to.
 */
export async function listAllCatalogs(
  db: Database,
  request: AuditRequestContext,
  filters: ListCatalogsFilters,
) {
  const where: Prisma.CatalogWhereInput = {
    OR: filters.q
      ? [
          { name: { contains: filters.q, mode: "insensitive" } },
          { version: { contains: filters.q, mode: "insensitive" } },
          { supplier: { name: { contains: filters.q, mode: "insensitive" } } },
          {
            tags: {
              some: {
                tag: {
                  OR: [
                    { nameEn: { contains: filters.q, mode: "insensitive" } },
                    { nameFr: { contains: filters.q, mode: "insensitive" } },
                  ],
                },
              },
            },
          },
        ]
      : undefined,
    AND: (filters.tagIds ?? []).length > 0 ? [{
      OR: [
        { tags: { some: { tagId: { in: filters.tagIds } } } },
        { supplier: { tags: { some: { tagId: { in: filters.tagIds } } } } },
        { supplier: { products: { some: { tags: { some: { tagId: { in: filters.tagIds } } } } } } },
      ],
    }] : undefined,
  };

  const [total, rows] = await db.$transaction([
    db.catalog.count({ where }),
    db.catalog.findMany({
      where,
      include: summaryInclude,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      ...skipTake(filters),
    }),
  ]);

  const tagNamesBySupplier = new Map<string, string[]>();
  await Promise.all(
    [...new Set(rows.flatMap((row) => row.supplierId ? [row.supplierId] : []))].map(async (supplierId) => {
      const tags = await db.tag.findMany({
        where: {
          OR: [
            { suppliers: { some: { supplierId } } },
            { products: { some: { product: { supplierId } } } },
          ],
        },
        select: { nameEn: true },
      });
      tagNamesBySupplier.set(
        supplierId,
        tags.map((tag) => tag.nameEn).sort(),
      );
    }),
  );

  const pinnedRows = request.actor.userId && rows.length > 0
    ? await db.pinnedItem.findMany({
        where: { userId: request.actor.userId, itemType: "catalog", itemId: { in: rows.map((row) => row.id) } },
        select: { itemId: true },
      })
    : [];
  const pinnedIds = new Set(pinnedRows.map((row) => row.itemId));

  const toSummaryDto = (row: CatalogSummaryRow): CatalogSummaryDto => ({
    ...toCatalogDto(row),
    pinned: pinnedIds.has(row.id),
    supplierName: row.supplier?.name ?? null,
    supplierTagNames: row.supplierId ? tagNamesBySupplier.get(row.supplierId) ?? [] : [],
  });

  await recordAudit(db, request, {
    action: AuditAction.CATALOG_LIST,
    outcome: "success",
    entityType: "Catalog",
  });
  return { items: rows.map(toSummaryDto), total, page: filters.page, pageSize: filters.pageSize };
}

function toCatalogDto(row: CatalogRow): CatalogDto {
  return {
    id: row.id,
    supplierId: row.supplierId,
    name: row.name,
    version: row.version,
    originalFileName: row.originalFileName,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    uploadedById: row.uploadedById,
    analysisStatus: row.analysisStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    tags: row.tags.map(({ tag }) => ({
      id: tag.id, name: { en: tag.nameEn, fr: tag.nameFr },
    })).sort((a, b) => a.name.en.localeCompare(b.name.en)),
  };
}

export async function getCatalog(
  db: Database,
  request: AuditRequestContext,
  catalogId: string,
): Promise<CatalogDto> {
  const row = await db.catalog.findUnique({ where: { id: catalogId }, include: catalogInclude });
  if (!row) throw errors.notFound("Catalog");
  await recordAudit(db, request, {
    action: AuditAction.CATALOG_VIEW,
    outcome: "success",
    entityType: "Catalog",
    entityId: catalogId,
  });
  return toCatalogDto(row);
}

function catalogSnapshot(row: CatalogRow): Record<string, unknown> {
  return { name: row.name, version: row.version, supplierId: row.supplierId, tags: row.tags.map((link) => link.tagId).sort() };
}

async function assertSupplierExists(db: Database | Prisma.TransactionClient, supplierId: string): Promise<void> {
  const supplier = await db.supplier.findUnique({ where: { id: supplierId }, select: { id: true } });
  if (!supplier) throw errors.notFound("Supplier");
}

export async function listCatalogs(
  db: Database,
  request: AuditRequestContext,
  supplierId: string,
  pageRequest: PageRequest | null = null,
) {
  await assertSupplierExists(db, supplierId);
  const where = { supplierId };
  const [total, rows] = await db.$transaction([
    db.catalog.count({ where }),
    db.catalog.findMany({
      where,
      include: catalogInclude,
      orderBy: [{ name: "asc" }, { version: "asc" }, { id: "asc" }],
      ...optionalSkipTake(pageRequest),
    }),
  ]);
  await recordAudit(db, request, {
    action: AuditAction.CATALOG_LIST,
    outcome: "success",
    entityType: "Supplier",
    entityId: supplierId,
  });
  return listResponse(rows.map(toCatalogDto), total, pageRequest);
}

export async function uploadCatalog(
  deps: CatalogDeps,
  request: AuditRequestContext,
  supplierId: string | null,
  file: UploadedFile,
  metadata: CatalogMetadata,
  options: CatalogUploadOptions = {},
): Promise<CatalogUploadResult> {
  if (file.mimeType !== PDF_MIME_TYPE || !hasPdfSignature(file.buffer)) {
    throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Only PDF files can be uploaded.");
  }
  if (supplierId) await assertSupplierExists(deps.db, supplierId);

  let name = metadata.name?.trim();
  name ??= catalogNameFromFileName(file.originalFileName);

  const idempotencyKey = options.idempotencyKey;
  const uploaderId = request.actor.userId;
  if (idempotencyKey && !uploaderId) {
    throw new Error("Idempotent catalog uploads require an authenticated uploader.");
  }
  let requestHash: string | null = null;
  if (idempotencyKey) {
    requestHash = createHash("sha256")
      .update(JSON.stringify([
        sanitizeFileName(file.originalFileName),
        name,
        createHash("sha256").update(file.buffer).digest("hex"),
      ]))
      .digest("hex");
    const existing = await deps.db.catalog.findFirst({
      where: {
        uploadedById: uploaderId,
        uploadIdempotencyKey: idempotencyKey,
      },
      include: catalogInclude,
    });
    if (existing) {
      if (existing.uploadRequestHash !== requestHash) {
        throw errors.conflict("This idempotency key was already used for a different upload.");
      }
      return { catalog: toCatalogDto(existing), replayed: true };
    }
  }

  // Store the file first, then write metadata in a transaction. If the transaction fails,
  // the file is removed so no orphaned data is left behind (NFR-11).
  const storageKey = idempotencyKey
    ? `catalogs/${storageUuid(uploaderId!, idempotencyKey, requestHash!)}.pdf`
    : `catalogs/${randomUUID()}.pdf`;
  let fileMayBelongToConcurrentRequest = false;
  try {
    if (!idempotencyKey || !await deps.storage.exists(storageKey)) {
      await deps.storage.save(storageKey, file.buffer, PDF_MIME_TYPE);
    } else {
      fileMayBelongToConcurrentRequest = true;
    }
  } catch (error) {
    if (idempotencyKey && await deps.storage.exists(storageKey)) {
      fileMayBelongToConcurrentRequest = true;
    } else {
      throw error;
    }
  }

  let saved: Awaited<ReturnType<typeof createCatalogWithExtractionJob>>;
  try {
    saved = await createCatalogWithExtractionJob(
      deps.db,
      request,
      supplierId,
      file,
      { ...metadata, name },
      storageKey,
      idempotencyKey ? { idempotencyKey, requestHash: requestHash! } : undefined,
    );
  } catch (error) {
    if (idempotencyKey && (error as { code?: string } | null)?.code === "P2002") {
      const existing = await deps.db.catalog.findFirstOrThrow({
        where: {
          uploadedById: uploaderId,
          uploadIdempotencyKey: idempotencyKey,
        },
        include: catalogInclude,
      });
      if (existing.uploadRequestHash !== requestHash) {
        if (!fileMayBelongToConcurrentRequest) {
          await removeStoredFiles(deps.storage, [storageKey], deps.log);
        }
        throw errors.conflict("This idempotency key was already used for a different upload.");
      }
      return { catalog: toCatalogDto(existing), replayed: true };
    }
    if (fileMayBelongToConcurrentRequest) throw error;
    await removeStoredFiles(deps.storage, [storageKey], deps.log);
    throw error;
  }
  const catalog = await deps.db.catalog.findUniqueOrThrow({ where: { id: saved.catalog.id }, include: catalogInclude });
  return { catalog: toCatalogDto(catalog), replayed: false };
}

function storageUuid(userId: string, idempotencyKey: string, requestHash: string): string {
  const bytes = Buffer.from(
    createHash("sha256").update(`${userId}:${idempotencyKey}:${requestHash}`).digest("hex").slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function createCatalogWithExtractionJob(
  db: Database,
  request: AuditRequestContext,
  supplierId: string | null,
  file: UploadedFile,
  metadata: CatalogMetadata & {
    name: string;
  },
  storageKey: string,
  idempotency?: {
    idempotencyKey: string;
    requestHash: string;
  },
) {
  return db.$transaction(async (tx) => {
  if (supplierId) await assertSupplierExists(tx, supplierId);
  const tagIds = await resolveTagIds(tx, request, metadata.tags ?? []);
  const row = await tx.catalog.create({
    data: {
      supplierId,
      name: metadata.name,
      version: metadata.version,
      originalFileName: sanitizeFileName(file.originalFileName),
      storageKey,
      mimeType: PDF_MIME_TYPE,
      sizeBytes: BigInt(file.buffer.byteLength),
      uploadedById: request.actor.userId,
      uploadIdempotencyKey: idempotency?.idempotencyKey,
      uploadRequestHash: idempotency?.requestHash,
      analysisStatus: "not_processed",
      tags: { create: tagIds.map((tagId) => ({ tagId })) },
    },
    include: catalogInclude,
  });
  await recordAudit(tx, request, {
    action: AuditAction.CATALOG_UPLOAD,
    outcome: "success",
    entityType: "Catalog",
    entityId: row.id,
    changes: diffFields(
      {},
      {
        name: row.name,
        version: row.version,
        originalFileName: row.originalFileName,
        sizeBytes: Number(row.sizeBytes),
        supplierId: row.supplierId,
        tags: tagIds.slice().sort(),
      },
    ),
  });
  return { catalog: row };
  });
}


export async function getCatalogExtraction(
  db: Database,
  request: AuditRequestContext,
  catalogId: string,
): Promise<{
  analysisStatus: CatalogAnalysisStatus;
  job: CatalogExtractionJobDto | null;
  matchingSupplier: { id: string; name: string } | null;
}> {
  const catalog = await db.catalog.findUnique({
  where: { id: catalogId },
  include: { extractionJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!catalog) throw errors.notFound("Catalog");
  await recordAudit(db, request, {
  action: AuditAction.CATALOG_ANALYSIS_VIEW,
  outcome: "success",
  entityType: "Catalog",
  entityId: catalogId,
  });
  const job = catalog.extractionJobs[0];
  const results = job?.results;
  const suggestion = results && typeof results === "object" && !Array.isArray(results)
    ? results.supplier
    : null;
  const suggestedName = suggestion && typeof suggestion === "object" && !Array.isArray(suggestion)
    ? suggestion.name
    : null;
  const matchingSupplier = !catalog.supplierId && typeof suggestedName === "string" && suggestedName.trim()
    ? await db.supplier.findUnique({
      where: { nameKey: nameKeyOf(suggestedName) },
      select: { id: true, name: true },
    })
    : null;
  return { analysisStatus: catalog.analysisStatus, job: job ? toExtractionJobDto(job) : null, matchingSupplier };
}

export async function prepareCatalogImage(
  deps: AssetDeps, request: AuditRequestContext, catalogId: string, jobId: string, imageId: string,
) {
  return deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM catalogs WHERE id = ${catalogId}::uuid FOR UPDATE`;
    const catalog = await tx.catalog.findUnique({
      where: { id: catalogId },
      include: { extractionJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const job = catalog?.extractionJobs[0];
    if (!job || job.id !== jobId || job.status !== "processed") throw errors.notFound("Catalog image");
    const image = await tx.catalogImageCandidate.findFirst({ where: { id: imageId, jobId } });
    if (!image) throw errors.notFound("Catalog image");
    const buffer = await readPrivateImage(deps.storage, image.storageKey, image.sizeBytes);
    await recordAudit(tx, request, {
      action: AuditAction.CATALOG_ANALYSIS_VIEW, outcome: "success", entityType: "Catalog", entityId: catalogId,
    });
    return { mimeType: image.mimeType, sizeBytes: image.sizeBytes, buffer };
  }, { timeout: 120_000 });
}

export async function startCatalogExtraction(
  deps: AssetDeps,
  request: AuditRequestContext,
  catalogId: string,
  extractionQueue: CatalogExtractionQueue,
  prompt: "supplier" | "tags" = "supplier",
): Promise<CatalogExtractionJobDto> {
  const job = await deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM catalogs WHERE id = ${catalogId}::uuid FOR UPDATE`;
    const existing = await tx.catalog.findUnique({
      where: { id: catalogId },
      include: { extractionJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!existing) throw errors.notFound("Catalog");
    const promptJob = await tx.catalogExtractionJob.findFirst({
      where: { catalogId, prompt, status: { in: ["queued", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (promptJob?.status === "processing") throw errors.conflict(`${prompt === "supplier" ? "Supplier" : "Tag"} analysis is already running.`);
    if (!promptJob) {
      const previousImages = await tx.catalogImageCandidate.findMany({
        where: { job: { catalogId } }, select: { storageKey: true },
      });
      for (const image of previousImages) await queueStoredFileRemoval(tx, image.storageKey);
      await tx.catalogImageCandidate.deleteMany({ where: { job: { catalogId } } });
    }
    const queued = promptJob?.status === "queued"
      ? promptJob
      : await tx.catalogExtractionJob.create({ data: { catalogId, prompt } });
    await tx.catalog.update({ where: { id: catalogId }, data: { analysisStatus: "queued" } });
    await recordAudit(tx, request, {
      action: AuditAction.CATALOG_ANALYSIS_START,
      outcome: "success",
      entityType: "Catalog",
      entityId: catalogId,
    });
    return queued;
  });
  await enqueueExtraction(deps.db, extractionQueue, job, deps.log);
  const queued = await deps.db.catalogExtractionJob.findUniqueOrThrow({ where: { id: job.id } });
  return toExtractionJobDto(queued);
}

/** Updates name and/or version. The file and its size are not changed here. */
export async function updateCatalog(
  db: Database,
  request: AuditRequestContext,
  catalogId: string,
  update: CatalogUpdate,
): Promise<CatalogDto> {
  return db.$transaction(async (tx) => {
    const existing = await tx.catalog.findUnique({ where: { id: catalogId }, include: catalogInclude });
    if (!existing) throw errors.notFound("Catalog");

    // Treated as absent when undefined so PATCH can leave an existing version untouched.
    const supplierId = update.supplierId === undefined ? existing.supplierId : update.supplierId;
    if (supplierId) await assertSupplierExists(tx, supplierId);
    const tagIds = update.tags === undefined
      ? existing.tags.map((link) => link.tagId)
      : await resolveTagIds(tx, request, update.tags);
    if (update.tags !== undefined) {
      await tx.catalogTag.deleteMany({ where: { catalogId } });
      await tx.catalogTag.createMany({ data: tagIds.map((tagId) => ({ catalogId, tagId })) });
    }
    const data: Prisma.CatalogUncheckedUpdateInput = { name: update.name, supplierId };
    if (update.version !== undefined) data.version = update.version;
    const row = await tx.catalog.update({ where: { id: catalogId }, data, include: catalogInclude });
    const changes = diffFields(catalogSnapshot(existing), catalogSnapshot(row));
    if (changes) {
      await recordAudit(tx, request, {
        action: AuditAction.CATALOG_UPDATE,
        outcome: "success",
        entityType: "Catalog",
        entityId: catalogId,
        changes,
      });
    }
    return toCatalogDto(row);
  });
}

export async function deleteCatalog(deps: AssetDeps, request: AuditRequestContext, catalogId: string): Promise<void> {
  const storageKey = await deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM catalogs WHERE id = ${catalogId}::uuid FOR UPDATE`;
    const existing = await tx.catalog.findUnique({ where: { id: catalogId } });
    if (!existing) throw errors.notFound("Catalog");
    const images = await tx.catalogImageCandidate.findMany({
      where: { job: { catalogId } }, select: { storageKey: true },
    });
    for (const image of images) await queueStoredFileRemoval(tx, image.storageKey);

    await tx.pinnedItem.deleteMany({ where: { itemType: "catalog", itemId: catalogId } });
    await tx.sharedItem.deleteMany({ where: { itemType: "catalog", itemId: catalogId } });
    await tx.catalog.delete({ where: { id: catalogId } });
    await recordAudit(tx, request, {
      action: AuditAction.CATALOG_DELETE,
      outcome: "success",
      entityType: "Catalog",
      entityId: catalogId,
      changes: diffFields({ name: existing.name, version: existing.version }, { name: null, version: null }),
    });
    return existing.storageKey;
  });

  await removeStoredFiles(deps.storage, [storageKey], deps.log);
}

/** Audits the download before the stream is returned (FR-AUD-01). */
export async function prepareCatalogDownload(
  deps: AssetDeps,
  request: AuditRequestContext,
  catalogId: string,
): Promise<CatalogDownload> {
  const row = await deps.db.catalog.findUnique({ where: { id: catalogId } });
  if (!row) throw errors.notFound("Catalog");
  if (!(await deps.storage.exists(row.storageKey))) throw errors.notFound("Catalog file");

  await recordAudit(deps.db, request, {
    action: AuditAction.CATALOG_DOWNLOAD,
    outcome: "success",
    entityType: "Catalog",
    entityId: catalogId,
  });
  return {
    fileName: row.originalFileName,
    sizeBytes: Number(row.sizeBytes),
    stream: deps.storage.openRead(row.storageKey),
  };
}

/** Audits an inline browser view before returning the private catalog stream. */
export async function prepareCatalogView(
  deps: AssetDeps,
  request: AuditRequestContext,
  catalogId: string,
): Promise<CatalogDownload> {
  const row = await deps.db.catalog.findUnique({ where: { id: catalogId } });
  if (!row) throw errors.notFound("Catalog");
  if (!(await deps.storage.exists(row.storageKey))) throw errors.notFound("Catalog file");

  await recordAudit(deps.db, request, {
    action: AuditAction.CATALOG_PDF_VIEW,
    outcome: "success",
    entityType: "Catalog",
    entityId: catalogId,
  });
  return {
    fileName: row.originalFileName,
    sizeBytes: Number(row.sizeBytes),
    stream: deps.storage.openRead(row.storageKey),
  };
}

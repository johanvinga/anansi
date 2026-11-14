import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { CatalogAnalysisStatus, CatalogExtractionJob, Prisma } from "../generated/prisma/client.js";
import type { Database } from "../db.js";
import { AppError, errors } from "../errors.js";
import { hasPdfSignature, PDF_MIME_TYPE, sanitizeFileName } from "../lib/pdf.js";
import type { CatalogExtractionQueue } from "./catalog-extraction.queue.js";
import {
  AuditAction,
  diffFields,
  recordAudit,
  type AuditRequestContext,
} from "./audit.service.js";
import { removeStoredFiles, type AssetDeps, type UploadedFile } from "./asset.service.js";
import { resolveCategoryIds, type CategoryInput } from "./category.service.js";

export interface CatalogMetadata {
  name: string;
  /** Optional since FR-CLG-01 was relaxed at the user's request (2026-11-08). */
  version: string | null;
  categories?: CategoryInput[] | undefined;
}

export interface CatalogUpdate {
  name?: string | undefined;
  version?: string | null | undefined;
  supplierId?: string | null | undefined;
  categories?: CategoryInput[] | undefined;
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
  categories: { id: string; name: { en: string; fr: string } }[];
}

export interface CatalogSummaryDto extends CatalogDto {
  supplierName: string | null;
  supplierCategoryNames: string[];
}

export interface ListCatalogsFilters {
  q?: string | undefined;
  categoryIds?: string[] | undefined;
  page: number;
  pageSize: number;
}

const catalogInclude = {
  categories: { include: { category: true } },
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

export interface CatalogExtractionJobDto {
  jobId: string;
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
  job: { id: string; catalogId: string },
  log: AssetDeps["log"],
): Promise<void> {
  try {
    await queue.enqueue(job.id);
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
 * version, or supplier name; categoryIds matches catalog or effective supplier categories.
 * Sorted newest first, the last-added order the page defaults to.
 */
export async function listAllCatalogs(
  db: Database,
  request: AuditRequestContext,
  filters: ListCatalogsFilters,
) {
  const categoryIds = filters.categoryIds ?? [];
  const where: Prisma.CatalogWhereInput = {
    OR: filters.q
      ? [
          { name: { contains: filters.q, mode: "insensitive" } },
          { version: { contains: filters.q, mode: "insensitive" } },
          { supplier: { name: { contains: filters.q, mode: "insensitive" } } },
        ]
      : undefined,
    AND: categoryIds.length > 0 ? [{
      OR: [
        { categories: { some: { categoryId: { in: categoryIds } } } },
        { supplier: { categories: { some: { categoryId: { in: categoryIds } } } } },
        { supplier: { products: { some: { categories: { some: { categoryId: { in: categoryIds } } } } } } },
      ],
    }] : undefined,
  };

  const [total, rows] = await db.$transaction([
    db.catalog.count({ where }),
    db.catalog.findMany({
      where,
      include: summaryInclude,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
  ]);

  // Category names are fetched once per distinct supplier, not once per catalog row.
  const categoryNamesBySupplier = new Map<string, string[]>();
  await Promise.all(
    [...new Set(rows.flatMap((row) => row.supplierId ? [row.supplierId] : []))].map(async (supplierId) => {
      const categories = await db.category.findMany({
        where: {
          OR: [
            { suppliers: { some: { supplierId } } },
            { products: { some: { product: { supplierId } } } },
          ],
        },
        select: { nameEn: true },
      });
      categoryNamesBySupplier.set(
        supplierId,
        categories.map((category) => category.nameEn).sort(),
      );
    }),
  );

  const toSummaryDto = (row: CatalogSummaryRow): CatalogSummaryDto => ({
    ...toCatalogDto(row),
    supplierName: row.supplier?.name ?? null,
    supplierCategoryNames: row.supplierId ? categoryNamesBySupplier.get(row.supplierId) ?? [] : [],
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
    categories: row.categories.map(({ category }) => ({
      id: category.id, name: { en: category.nameEn, fr: category.nameFr },
    })).sort((a, b) => a.name.en.localeCompare(b.name.en)),
  };
}

function catalogSnapshot(row: CatalogRow): Record<string, unknown> {
  return { name: row.name, version: row.version, supplierId: row.supplierId, categories: row.categories.map((link) => link.categoryId).sort() };
}

async function assertSupplierExists(db: Database | Prisma.TransactionClient, supplierId: string): Promise<void> {
  const supplier = await db.supplier.findUnique({ where: { id: supplierId }, select: { id: true } });
  if (!supplier) throw errors.notFound("Supplier");
}

export async function listCatalogs(db: Database, request: AuditRequestContext, supplierId: string) {
  await assertSupplierExists(db, supplierId);
  const rows = await db.catalog.findMany({
    where: { supplierId },
    include: catalogInclude,
    orderBy: [{ name: "asc" }, { version: "asc" }],
  });
  await recordAudit(db, request, {
    action: AuditAction.CATALOG_LIST,
    outcome: "success",
    entityType: "Supplier",
    entityId: supplierId,
  });
  return { items: rows.map(toCatalogDto) };
}

export async function uploadCatalog(
  deps: AssetDeps,
  request: AuditRequestContext,
  supplierId: string | null,
  file: UploadedFile,
  metadata: CatalogMetadata,
  extractionQueue: CatalogExtractionQueue | undefined,
): Promise<CatalogDto> {
  if (file.mimeType !== PDF_MIME_TYPE || !hasPdfSignature(file.buffer)) {
    throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Only PDF files can be uploaded.");
  }
  if (supplierId) await assertSupplierExists(deps.db, supplierId);

  // Store the file first, then write metadata in a transaction. If the transaction fails,
  // the file is removed so no orphaned data is left behind (NFR-11).
  const storageKey = `catalogs/${randomUUID()}.pdf`;
  await deps.storage.save(storageKey, file.buffer, PDF_MIME_TYPE);

  let saved: Awaited<ReturnType<typeof createCatalogWithExtractionJob>>;
  try {
    saved = await createCatalogWithExtractionJob(deps.db, request, supplierId, file, metadata, storageKey, Boolean(extractionQueue));
  } catch (error) {
    await removeStoredFiles(deps.storage, [storageKey], deps.log);
    throw error;
  }
  if (extractionQueue && saved.extractionJob) {
    await enqueueExtraction(deps.db, extractionQueue, saved.extractionJob, deps.log);
  }
  const catalog = await deps.db.catalog.findUniqueOrThrow({ where: { id: saved.catalog.id }, include: catalogInclude });
  return toCatalogDto(catalog);
}

async function createCatalogWithExtractionJob(
  db: Database,
  request: AuditRequestContext,
  supplierId: string | null,
  file: UploadedFile,
  metadata: CatalogMetadata,
  storageKey: string,
  extractionEnabled: boolean,
) {
  return db.$transaction(async (tx) => {
  if (supplierId) await assertSupplierExists(tx, supplierId);
  const categoryIds = await resolveCategoryIds(tx, request, metadata.categories ?? []);
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
      analysisStatus: extractionEnabled ? "queued" : "not_processed",
      categories: { create: categoryIds.map((categoryId) => ({ categoryId })) },
    },
    include: catalogInclude,
  });
  if (supplierId) await mergeSupplierCategories(tx, request, supplierId, categoryIds);
  const extractionJob = extractionEnabled
    ? await tx.catalogExtractionJob.create({ data: { catalogId: row.id } })
    : null;
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
        categories: categoryIds.slice().sort(),
      },
    ),
  });
  return { catalog: row, extractionJob };
  });
}

async function mergeSupplierCategories(
  tx: Prisma.TransactionClient,
  request: AuditRequestContext,
  supplierId: string,
  categoryIds: string[],
): Promise<void> {
  if (!categoryIds.length) return;
  const before = await tx.supplierCategory.findMany({
    where: { supplierId },
    select: { categoryId: true },
  });
  const existing = new Set(before.map((link) => link.categoryId));
  const additions = categoryIds.filter((id) => !existing.has(id));
  if (!additions.length) return;
  await tx.supplierCategory.createMany({
    data: additions.map((categoryId) => ({ supplierId, categoryId })),
    skipDuplicates: true,
  });
  const after = await tx.supplierCategory.findMany({ where: { supplierId }, select: { categoryId: true } });
  await recordAudit(tx, request, {
    action: AuditAction.SUPPLIER_UPDATE,
    outcome: "success",
    entityType: "Supplier",
    entityId: supplierId,
    changes: diffFields(
      { categoryIds: [...existing].sort() },
      { categoryIds: after.map((link) => link.categoryId).sort() },
    ),
  });
}

export async function getCatalogExtraction(
  db: Database,
  request: AuditRequestContext,
  catalogId: string,
): Promise<{ analysisStatus: CatalogAnalysisStatus; job: CatalogExtractionJobDto | null }> {
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
  return { analysisStatus: catalog.analysisStatus, job: job ? toExtractionJobDto(job) : null };
}

export async function startCatalogExtraction(
  deps: AssetDeps,
  request: AuditRequestContext,
  catalogId: string,
  extractionQueue: CatalogExtractionQueue,
): Promise<CatalogExtractionJobDto> {
  const existing = await deps.db.catalog.findUnique({
  where: { id: catalogId },
  include: { extractionJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!existing) throw errors.notFound("Catalog");
  const latest = existing.extractionJobs[0];
  if (latest?.status === "processing") {
  throw errors.conflict("Catalog analysis is already running.");
  }
  if (latest?.status === "queued") {
  await enqueueExtraction(deps.db, extractionQueue, latest, deps.log);
  const current = await deps.db.catalogExtractionJob.findUniqueOrThrow({ where: { id: latest.id } });
  return toExtractionJobDto(current);
  }

  const job = await deps.db.$transaction(async (tx) => {
  const created = await tx.catalogExtractionJob.create({ data: { catalogId } });
  await tx.catalog.update({ where: { id: catalogId }, data: { analysisStatus: "queued" } });
  await recordAudit(tx, request, {
    action: AuditAction.CATALOG_ANALYSIS_START,
    outcome: "success",
    entityType: "Catalog",
    entityId: catalogId,
  });
  return created;
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
    const categoryIds = update.categories === undefined
      ? existing.categories.map((link) => link.categoryId)
      : await resolveCategoryIds(tx, request, update.categories);
    if (update.categories !== undefined) {
      await tx.catalogCategory.deleteMany({ where: { catalogId } });
      await tx.catalogCategory.createMany({ data: categoryIds.map((categoryId) => ({ catalogId, categoryId })) });
    }
    if (supplierId) await mergeSupplierCategories(tx, request, supplierId, categoryIds);
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
    const existing = await tx.catalog.findUnique({ where: { id: catalogId } });
    if (!existing) throw errors.notFound("Catalog");

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

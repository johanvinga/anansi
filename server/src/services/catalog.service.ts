import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { Catalog, Prisma } from "../generated/prisma/client.js";
import type { Database } from "../db.js";
import { AppError, errors } from "../errors.js";
import { hasPdfSignature, PDF_MIME_TYPE, sanitizeFileName } from "../lib/pdf.js";
import {
  AuditAction,
  diffFields,
  recordAudit,
  type AuditRequestContext,
} from "./audit.service.js";
import { removeStoredFiles, type AssetDeps, type UploadedFile } from "./asset.service.js";

export interface CatalogMetadata {
  name: string;
  /** Optional since FR-CLG-01 was relaxed at the user's request (2026-11-08). */
  version: string | null;
}

export interface CatalogUpdate {
  name?: string | undefined;
  version?: string | null | undefined;
}

export interface CatalogDto {
  id: string;
  supplierId: string;
  name: string;
  version: string | null;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogSummaryDto extends CatalogDto {
  supplierName: string;
  supplierCategoryNames: string[];
}

export interface ListCatalogsFilters {
  q?: string | undefined;
  categoryIds?: string[] | undefined;
  page: number;
  pageSize: number;
}

type CatalogSummaryRow = Prisma.CatalogGetPayload<{ include: { supplier: { select: { name: true } } } }>;

const summaryInclude = {
  supplier: { select: { name: true } },
} satisfies Prisma.CatalogInclude;

export interface CatalogDownload {
  fileName: string;
  sizeBytes: number;
  stream: Readable;
}

/**
 * Lists catalogs across all suppliers (the catalogs page). Search matches catalog name,
 * version, or supplier name; categoryIds keeps catalogs whose supplier belongs to any of the
 * given categories. Sorted newest first, the last-added order the page defaults to.
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
    supplier:
      categoryIds.length > 0
        ? { categories: { some: { categoryId: { in: categoryIds } } } }
        : undefined,
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
    [...new Set(rows.map((row) => row.supplierId))].map(async (supplierId) => {
      const supplier = await db.supplier.findUnique({
        where: { id: supplierId },
        select: { categories: { select: { category: { select: { name: true } } } } },
      });
      categoryNamesBySupplier.set(
        supplierId,
        supplier?.categories.map((link) => link.category.name).sort() ?? [],
      );
    }),
  );

  const toSummaryDto = (row: CatalogSummaryRow): CatalogSummaryDto => ({
    ...toCatalogDto(row),
    supplierName: row.supplier.name,
    supplierCategoryNames: categoryNamesBySupplier.get(row.supplierId) ?? [],
  });

  await recordAudit(db, request, {
    action: AuditAction.CATALOG_LIST,
    outcome: "success",
    entityType: "Catalog",
  });
  return { items: rows.map(toSummaryDto), total, page: filters.page, pageSize: filters.pageSize };
}

function toCatalogDto(row: Catalog): CatalogDto {
  return {
    id: row.id,
    supplierId: row.supplierId,
    name: row.name,
    version: row.version,
    originalFileName: row.originalFileName,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    uploadedById: row.uploadedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function catalogSnapshot(row: Catalog): Record<string, unknown> {
  return { name: row.name, version: row.version };
}

async function assertSupplierExists(db: Database, supplierId: string): Promise<void> {
  const supplier = await db.supplier.findUnique({ where: { id: supplierId }, select: { id: true } });
  if (!supplier) throw errors.notFound("Supplier");
}

export async function listCatalogs(db: Database, request: AuditRequestContext, supplierId: string) {
  await assertSupplierExists(db, supplierId);
  const rows = await db.catalog.findMany({
    where: { supplierId },
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
  supplierId: string,
  file: UploadedFile,
  metadata: CatalogMetadata,
): Promise<CatalogDto> {
  if (file.mimeType !== PDF_MIME_TYPE || !hasPdfSignature(file.buffer)) {
    throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Only PDF files can be uploaded.");
  }
  await assertSupplierExists(deps.db, supplierId);

  // Store the file first, then write metadata in a transaction. If the transaction fails,
  // the file is removed so no orphaned data is left behind (NFR-11).
  const storageKey = `${randomUUID()}.pdf`;
  await deps.storage.save(storageKey, file.buffer);

  try {
    return await deps.db.$transaction(async (tx) => {
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
        },
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
          },
        ),
      });
      return toCatalogDto(row);
    });
  } catch (error) {
    await removeStoredFiles(deps.storage, [storageKey], deps.log);
    throw error;
  }
}

/** Updates name and/or version. The file and its size are not changed here. */
export async function updateCatalog(
  db: Database,
  request: AuditRequestContext,
  catalogId: string,
  update: CatalogUpdate,
): Promise<CatalogDto> {
  return db.$transaction(async (tx) => {
    const existing = await tx.catalog.findUnique({ where: { id: catalogId } });
    if (!existing) throw errors.notFound("Catalog");

    // Treated as absent when undefined so PATCH can leave an existing version untouched.
    const data: Prisma.CatalogUpdateInput = { name: update.name };
    if (update.version !== undefined) data.version = update.version;
    const row = await tx.catalog.update({ where: { id: catalogId }, data });
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

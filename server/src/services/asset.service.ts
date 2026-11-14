import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { FastifyBaseLogger } from "fastify";
import type { SupplierAsset } from "../generated/prisma/client.js";
import type { Database } from "../db.js";
import { errors } from "../errors.js";
import type { AssetStorage } from "../lib/asset-storage.js";
import { sanitizeFileName } from "../lib/pdf.js";
import {
  AuditAction,
  diffFields,
  recordAudit,
  type AuditRequestContext,
} from "./audit.service.js";

export interface AssetDeps {
  db: Database;
  storage: AssetStorage;
  log: FastifyBaseLogger;
}

export interface UploadedFile {
  buffer: Buffer;
  originalFileName: string;
  mimeType: string;
}

export interface AssetMetadata {
  title?: string | null | undefined;
  description?: string | null | undefined;
}

export interface AssetDto {
  id: string;
  supplierId: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  title: string | null;
  description: string | null;
  uploadedById: string | null;
  uploadedByName: string | null;
  createdAt: string;
}

function toAssetDto(row: SupplierAsset): AssetDto {
  return {
    id: row.id,
    supplierId: row.supplierId,
    originalFileName: row.originalFileName,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    title: row.title,
    description: row.description,
    uploadedById: row.uploaderId ?? row.uploadedById,
    uploadedByName: row.uploaderName,
    createdAt: row.createdAt.toISOString(),
  };
}

function assetSnapshot(row: SupplierAsset): Record<string, unknown> {
  return { title: row.title, description: row.description };
}

export async function removeStoredFiles(
  storage: AssetStorage,
  keys: string[],
  log: FastifyBaseLogger,
): Promise<void> {
  for (const key of keys) {
    try {
      await storage.remove(key);
    } catch (error) {
      log.warn({ err: { name: (error as Error).name } }, "Could not remove stored asset file");
    }
  }
}

async function assertSupplierExists(db: Database, supplierId: string): Promise<void> {
  const supplier = await db.supplier.findUnique({ where: { id: supplierId }, select: { id: true } });
  if (!supplier) throw errors.notFound("Supplier");
}

export async function listAssets(db: Database, request: AuditRequestContext, supplierId: string) {
  await assertSupplierExists(db, supplierId);
  const rows = await db.supplierAsset.findMany({
    where: { supplierId },
    orderBy: { createdAt: "desc" },
  });
  await recordAudit(db, request, {
    action: AuditAction.ASSET_LIST,
    outcome: "success",
    entityType: "Supplier",
    entityId: supplierId,
  });
  return { items: rows.map(toAssetDto) };
}

export async function uploadAsset(
  deps: AssetDeps,
  request: AuditRequestContext,
  supplierId: string,
  file: UploadedFile,
  metadata: AssetMetadata,
): Promise<AssetDto> {
  await assertSupplierExists(deps.db, supplierId);

  // Store the file first, then write metadata in a transaction. If the transaction fails,
  // the file is removed so no orphaned data is left behind (NFR-11).
  const storageKey = `assets/${randomUUID()}`;
  const mimeType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.mimeType) && file.mimeType.length <= 100
    ? file.mimeType.toLowerCase()
    : "application/octet-stream";
  await deps.storage.save(storageKey, file.buffer, mimeType);

  try {
    return await deps.db.$transaction(async (tx) => {
      if (!request.actor.userId) throw new Error("Asset upload requires an authenticated user");
      const uploader = await tx.user.findUniqueOrThrow({
        where: { id: request.actor.userId },
        select: { id: true, displayName: true, email: true },
      });
      const row = await tx.supplierAsset.create({
        data: {
          supplierId,
          originalFileName: sanitizeFileName(file.originalFileName, "file"),
          storageKey,
          mimeType,
          sizeBytes: BigInt(file.buffer.byteLength),
          title: metadata.title ?? null,
          description: metadata.description ?? null,
          uploadedById: request.actor.userId,
          uploaderId: uploader.id,
          uploaderName: uploader.displayName?.trim() || uploader.email,
        },
      });
      await recordAudit(tx, request, {
        action: AuditAction.ASSET_UPLOAD,
        outcome: "success",
        entityType: "SupplierAsset",
        entityId: row.id,
        changes: diffFields(
          {},
          { originalFileName: row.originalFileName, sizeBytes: Number(row.sizeBytes) },
        ),
      });
      return toAssetDto(row);
    });
  } catch (error) {
    await removeStoredFiles(deps.storage, [storageKey], deps.log);
    throw error;
  }
}

export async function updateAsset(
  db: Database,
  request: AuditRequestContext,
  assetId: string,
  metadata: AssetMetadata,
): Promise<AssetDto> {
  return db.$transaction(async (tx) => {
    const existing = await tx.supplierAsset.findUnique({ where: { id: assetId } });
    if (!existing) throw errors.notFound("Asset");

    const row = await tx.supplierAsset.update({
      where: { id: assetId },
      data: { title: metadata.title, description: metadata.description },
    });
    const changes = diffFields(assetSnapshot(existing), assetSnapshot(row));
    if (changes) {
      await recordAudit(tx, request, {
        action: AuditAction.ASSET_UPDATE,
        outcome: "success",
        entityType: "SupplierAsset",
        entityId: assetId,
        changes,
      });
    }
    return toAssetDto(row);
  });
}

export async function deleteAsset(deps: AssetDeps, request: AuditRequestContext, assetId: string): Promise<void> {
  const storageKey = await deps.db.$transaction(async (tx) => {
    const existing = await tx.supplierAsset.findUnique({ where: { id: assetId } });
    if (!existing) throw errors.notFound("Asset");

    await tx.supplierAsset.delete({ where: { id: assetId } });
    await recordAudit(tx, request, {
      action: AuditAction.ASSET_DELETE,
      outcome: "success",
      entityType: "SupplierAsset",
      entityId: assetId,
      changes: diffFields({ originalFileName: existing.originalFileName }, { originalFileName: null }),
    });
    return existing.storageKey;
  });

  await removeStoredFiles(deps.storage, [storageKey], deps.log);
}

export interface AssetDownload {
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  stream: Readable;
}

/** Audits the download before the stream is returned (FR-AUD-01). */
export async function prepareDownload(
  deps: AssetDeps,
  request: AuditRequestContext,
  assetId: string,
): Promise<AssetDownload> {
  const row = await deps.db.supplierAsset.findUnique({ where: { id: assetId } });
  if (!row) throw errors.notFound("Asset");
  if (!(await deps.storage.exists(row.storageKey))) throw errors.notFound("Asset file");

  await recordAudit(deps.db, request, {
    action: AuditAction.ASSET_DOWNLOAD,
    outcome: "success",
    entityType: "SupplierAsset",
    entityId: assetId,
  });
  return {
    fileName: row.originalFileName,
    sizeBytes: Number(row.sizeBytes),
    mimeType: row.mimeType,
    stream: deps.storage.openRead(row.storageKey),
  };
}

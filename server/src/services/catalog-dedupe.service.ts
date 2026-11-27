import { createHash } from "node:crypto";
import type { Database } from "../db.js";
import type { AssetStorage } from "../lib/asset-storage.js";
import { AuditAction, diffFields, recordAudit, type AuditRequestContext } from "./audit.service.js";
import { deleteCatalog } from "./catalog.service.js";

export interface DedupeDeps {
  db: Database;
  storage: AssetStorage;
  log: { warn(details: object, message: string): void };
}

export type DuplicateOutcome = "would-delete" | "deleted" | "failed";

export interface DuplicateCatalog {
  id: string;
  name: string;
  outcome: DuplicateOutcome;
}

export interface DuplicateGroup {
  sha256: string;
  keep: { id: string; name: string };
  duplicates: DuplicateCatalog[];
}

export interface DedupeReport {
  groups: DuplicateGroup[];
  /** Catalogs whose PDF could not be read from storage; they are never treated as duplicates. */
  unreadable: { id: string; name: string }[];
}

export interface DedupeOptions {
  apply?: boolean;
  /** Caps how many duplicate groups are handled. */
  limit?: number | undefined;
}

async function sha256Of(storage: AssetStorage, key: string): Promise<string | null> {
  try {
    if (!(await storage.exists(key))) return null;
    const hash = createHash("sha256");
    for await (const chunk of storage.openRead(key)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/** Finds catalogs whose PDF bytes are identical. Only files of equal size are read and hashed. */
export async function findDuplicateCatalogs(deps: DedupeDeps, options: DedupeOptions = {}): Promise<DedupeReport> {
  const rows = await deps.db.catalog.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      storageKey: true,
      sizeBytes: true,
      supplierId: true,
      createdAt: true,
      _count: { select: { tags: true, sourcedProducts: true, extractionJobs: { where: { status: "processed" } } } },
    },
  });

  const bySize = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.sizeBytes.toString();
    bySize.set(key, [...(bySize.get(key) ?? []), row]);
  }

  const byHash = new Map<string, typeof rows>();
  const unreadable: DedupeReport["unreadable"] = [];
  for (const sameSize of bySize.values()) {
    if (sameSize.length < 2) continue;
    for (const row of sameSize) {
      const hash = await sha256Of(deps.storage, row.storageKey);
      if (!hash) {
        unreadable.push({ id: row.id, name: row.name });
        continue;
      }
      byHash.set(hash, [...(byHash.get(hash) ?? []), row]);
    }
  }

  // The copy with the most data wins; the oldest copy breaks ties (rows are already oldest first).
  const richness = (row: (typeof rows)[number]) =>
    row._count.tags + row._count.sourcedProducts + row._count.extractionJobs + (row.supplierId ? 1 : 0);
  const groups: DuplicateGroup[] = [];
  for (const [sha256, copies] of byHash) {
    if (copies.length < 2) continue;
    const ranked = [...copies].sort((a, b) => richness(b) - richness(a));
    const [keep, ...duplicates] = ranked;
    groups.push({
      sha256,
      keep: { id: keep!.id, name: keep!.name },
      duplicates: duplicates.map((row) => ({ id: row.id, name: row.name, outcome: "would-delete" })),
    });
  }
  groups.sort((a, b) => a.keep.name.localeCompare(b.keep.name) || a.keep.id.localeCompare(b.keep.id));
  return { groups: options.limit === undefined ? groups : groups.slice(0, options.limit), unreadable };
}

/** Moves everything worth keeping from a duplicate onto the kept catalog. */
async function mergeInto(db: Database, request: AuditRequestContext, keepId: string, duplicateId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM catalogs WHERE id IN (${keepId}::uuid, ${duplicateId}::uuid) ORDER BY id FOR UPDATE`;
    const keeper = await tx.catalog.findUnique({ where: { id: keepId }, include: { tags: true } });
    const duplicate = await tx.catalog.findUnique({ where: { id: duplicateId }, include: { tags: true } });
    if (!keeper || !duplicate) return;

    const products = await tx.product.findMany({ where: { sourceCatalogId: duplicateId }, select: { id: true } });
    for (const product of products) {
      await tx.product.update({ where: { id: product.id }, data: { sourceCatalogId: keepId } });
      await recordAudit(tx, request, {
        action: AuditAction.PRODUCT_UPDATE,
        outcome: "success",
        entityType: "Product",
        entityId: product.id,
        changes: diffFields({ sourceCatalogId: duplicateId }, { sourceCatalogId: keepId }),
      });
    }

    const keeperPinners = new Set(
      (await tx.pinnedItem.findMany({ where: { itemType: "catalog", itemId: keepId }, select: { userId: true } }))
        .map((pin) => pin.userId),
    );
    let pinsMoved = 0;
    for (const pin of await tx.pinnedItem.findMany({ where: { itemType: "catalog", itemId: duplicateId } })) {
      if (keeperPinners.has(pin.userId)) continue;
      await tx.pinnedItem.update({ where: { id: pin.id }, data: { itemId: keepId } });
      pinsMoved += 1;
    }

    const keeperShares = new Set(
      (await tx.sharedItem.findMany({ where: { itemType: "catalog", itemId: keepId }, select: { senderId: true, recipientId: true } }))
        .map((share) => `${share.senderId}:${share.recipientId}`),
    );
    let sharesMoved = 0;
    for (const share of await tx.sharedItem.findMany({ where: { itemType: "catalog", itemId: duplicateId } })) {
      if (keeperShares.has(`${share.senderId}:${share.recipientId}`)) continue;
      await tx.sharedItem.update({ where: { id: share.id }, data: { itemId: keepId } });
      sharesMoved += 1;
    }

    const tagsBefore = keeper.tags.map((link) => link.tagId);
    const tagsAfter = [...new Set([...tagsBefore, ...duplicate.tags.map((link) => link.tagId)])];
    if (tagsAfter.length > tagsBefore.length) {
      await tx.catalogTag.createMany({
        data: tagsAfter.map((tagId) => ({ catalogId: keepId, tagId })),
        skipDuplicates: true,
      });
    }
    const supplierId = keeper.supplierId ?? duplicate.supplierId;
    if (supplierId !== keeper.supplierId) {
      await tx.catalog.update({ where: { id: keepId }, data: { supplierId } });
    }

    await recordAudit(tx, request, {
      action: AuditAction.CATALOG_UPDATE,
      outcome: "success",
      entityType: "Catalog",
      entityId: keepId,
      changes: diffFields(
        {
          supplierId: keeper.supplierId,
          tags: [...tagsBefore].sort(),
          mergedDuplicateCatalogId: null,
          productsMoved: 0,
          pinsMoved: 0,
          sharesMoved: 0,
        },
        {
          supplierId,
          tags: [...tagsAfter].sort(),
          mergedDuplicateCatalogId: duplicateId,
          productsMoved: products.length,
          pinsMoved,
          sharesMoved,
        },
      ),
    });
  }, { timeout: 60_000 });
}

/**
 * Finds catalogs with identical PDF bytes and, when `apply` is set, merges each duplicate's data into
 * the kept copy and deletes it through the normal catalog deletion (audited, file removed).
 * Without `apply` nothing is changed.
 */
export async function dedupeCatalogs(
  deps: DedupeDeps,
  request: AuditRequestContext,
  options: DedupeOptions = {},
): Promise<DedupeReport> {
  const report = await findDuplicateCatalogs(deps, options);
  if (!options.apply) return report;

  for (const group of report.groups) {
    for (const duplicate of group.duplicates) {
      try {
        await mergeInto(deps.db, request, group.keep.id, duplicate.id);
        await deleteCatalog(deps, request, duplicate.id);
        duplicate.outcome = "deleted";
      } catch (error) {
        deps.log.warn(
          { catalogId: duplicate.id, errorName: error instanceof Error ? error.name : "UnknownError" },
          "Could not remove duplicate catalog",
        );
        duplicate.outcome = "failed";
      }
    }
  }
  return report;
}

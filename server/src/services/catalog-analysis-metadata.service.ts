import { randomUUID } from "node:crypto";
import type { Catalog, Prisma } from "../generated/prisma/client.js";
import { catalogNameFromFileName } from "./catalog.service.js";
import { resolveCategoryPaths } from "./category.service.js";
import {
  AuditAction,
  diffFields,
  recordAudit,
  type AuditRequestContext,
} from "./audit.service.js";

interface CatalogAnalysisMetadata {
  name: string | null;
  categoryPath?: { en: string; fr: string }[] | null;
  categoryPaths?: { en: string; fr: string }[][];
}

const systemRequest = (): AuditRequestContext => ({
  requestId: randomUUID(),
  ipAddress: null,
  actor: { userId: null, email: "system:catalog-analysis" },
});

export async function applyCatalogAnalysisMetadata(
  tx: Prisma.TransactionClient,
  catalog: Catalog,
  metadata: CatalogAnalysisMetadata | null,
): Promise<void> {
  if (!metadata) return;
  const request = systemRequest();
  const existing = await tx.catalog.findUniqueOrThrow({
    where: { id: catalog.id },
    include: { categories: true },
  });
  const inferredName = metadata.name?.trim() || null;
  const shouldApplyName =
    inferredName !== null &&
    existing.name === catalogNameFromFileName(existing.originalFileName);
  const inferredPaths = metadata.categoryPaths ??
    (metadata.categoryPath?.length ? [metadata.categoryPath] : []);
  const inferredCategoryIds = inferredPaths.length
    ? await resolveCategoryPaths(tx, request, inferredPaths.map((path) => ({
        path: path.map((name) => ({ name })),
      })))
    : [];
  const existingCategoryIds = new Set(existing.categories.map((link) => link.categoryId));
  const addedCategoryIds = inferredCategoryIds.filter((id) => !existingCategoryIds.has(id));

  if (!shouldApplyName && addedCategoryIds.length === 0) return;
  if (addedCategoryIds.length > 0) {
    await tx.catalogCategory.createMany({
      data: addedCategoryIds.map((categoryId) => ({ catalogId: catalog.id, categoryId })),
    });
  }
  const name = shouldApplyName ? inferredName : existing.name;
  if (shouldApplyName) {
    await tx.catalog.update({ where: { id: catalog.id }, data: { name } });
  }

  const categoryIds = [...existingCategoryIds, ...addedCategoryIds].sort();
  await recordAudit(tx, request, {
    action: AuditAction.CATALOG_UPDATE,
    outcome: "success",
    entityType: "Catalog",
    entityId: catalog.id,
    changes: diffFields(
      {
        name: existing.name,
        categories: existing.categories.map((link) => link.categoryId).sort(),
      },
      { name, categories: categoryIds },
    ),
  });

  if (existing.supplierId && addedCategoryIds.length > 0) {
    const before = await tx.supplierCategory.findMany({
      where: { supplierId: existing.supplierId },
      select: { categoryId: true },
    });
    await tx.supplierCategory.createMany({
      data: addedCategoryIds.map((categoryId) => ({
        supplierId: existing.supplierId!,
        categoryId,
      })),
      skipDuplicates: true,
    });
    const after = await tx.supplierCategory.findMany({
      where: { supplierId: existing.supplierId },
      select: { categoryId: true },
    });
    const beforeIds = before.map((link) => link.categoryId).sort();
    const afterIds = after.map((link) => link.categoryId).sort();
    if (beforeIds.join() !== afterIds.join()) {
      await recordAudit(tx, request, {
        action: AuditAction.SUPPLIER_UPDATE,
        outcome: "success",
        entityType: "Supplier",
        entityId: existing.supplierId,
        changes: diffFields({ categoryIds: beforeIds }, { categoryIds: afterIds }),
      });
    }
  }
}

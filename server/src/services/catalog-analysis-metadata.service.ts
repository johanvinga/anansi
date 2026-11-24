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

interface CatalogAnalysisProduct {
  categories: string[];
}

const systemRequest = (): AuditRequestContext => ({
  requestId: randomUUID(),
  ipAddress: null,
  actor: { userId: null, email: "system:catalog-analysis" },
});

async function productCategoryPaths(
  tx: Prisma.TransactionClient,
  products: CatalogAnalysisProduct[],
): Promise<{ en: string; fr: string }[][]> {
  const names = [...new Set(
    products.flatMap((product) => product.categories)
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  )];
  if (names.length === 0) return [];

  const categories = await tx.category.findMany({
    select: { id: true, parentId: true, nameEn: true, nameFr: true },
  });
  const byId = new Map(categories.map((category) => [category.id, category]));

  const paths: { en: string; fr: string }[][] = [];
  for (const name of names) {
    const needle = name.toLocaleLowerCase();
    const matches = categories.filter((category) =>
      category.nameEn.trim().toLocaleLowerCase() === needle ||
      category.nameFr.trim().toLocaleLowerCase() === needle
    );

    if (matches.length === 1) {
      const path: { en: string; fr: string }[] = [];
      const visited = new Set<string>();
      let category: typeof categories[number] | undefined = matches[0];
      while (category) {
        if (visited.has(category.id)) break;
        visited.add(category.id);
        path.unshift({ en: category.nameEn, fr: category.nameFr });
        category = category.parentId ? byId.get(category.parentId) : undefined;
      }
      paths.push(path);
    } else if (matches.length === 0) {
      paths.push([{ en: name, fr: name }]);
    }
  }
  return paths;
}

export async function applyCatalogAnalysisMetadata(
  tx: Prisma.TransactionClient,
  catalog: Catalog,
  metadata: CatalogAnalysisMetadata | null,
  products: CatalogAnalysisProduct[] = [],
): Promise<void> {
  if (!metadata && products.length === 0) return;
  const request = systemRequest();
  const existing = await tx.catalog.findUniqueOrThrow({
    where: { id: catalog.id },
    include: { categories: true },
  });
  const inferredName = metadata?.name?.trim() || null;
  const shouldApplyName =
    inferredName !== null &&
    existing.name === catalogNameFromFileName(existing.originalFileName);
  const inferredPaths = metadata?.categoryPaths ??
    (metadata?.categoryPath?.length ? [metadata.categoryPath] : []);
  const individualProductPaths = await productCategoryPaths(tx, products);
  const allInferredPaths = [
    ...inferredPaths,
    ...individualProductPaths,
  ];
  const inferredCategoryIds = allInferredPaths.length
    ? await resolveCategoryPaths(tx, request, allInferredPaths.map((path) => ({
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

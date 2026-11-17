import { z } from "zod";
import type { Database } from "../db.js";
import { errors } from "../errors.js";
import { nameKeyOf } from "../lib/text.js";
import { AuditAction, recordAudit, type AuditRequestContext } from "./audit.service.js";
import { matchCatalogAttribute, normalizeAttributeName } from "./catalog-attribute-matching.js";
import { categoryTreeSnapshot } from "./category.service.js";

export const resultsSchema = z.object({
  imageWarnings: z.array(z.string().max(200)).max(100).optional(),
  products: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    sku: z.string().trim().max(100).nullable(),
    description: z.string().trim().max(2000).nullable().optional(),
    categories: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
    attributes: z.array(z.object({
      name: z.string().trim().min(1).max(100),
      value: z.string().trim().min(1).max(500),
    })).max(100),
    source: z.object({ pageNumbers: z.array(z.number().int().positive()) }).optional(),
  })).max(1000),
});

export async function previewCatalogImport(
  db: Database,
  request: AuditRequestContext,
  catalogId: string,
  jobId: string,
  indexes: number[],
) {
  const catalog = await db.catalog.findUnique({
    where: { id: catalogId },
    include: { extractionJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!catalog) throw errors.notFound("Catalog");
  const job = catalog.extractionJobs[0];
  if (!job || job.id !== jobId || job.status !== "processed") {
    throw errors.conflict("The selected analysis is no longer the latest completed analysis.");
  }
  const parsed = resultsSchema.safeParse(job.results);
  if (!parsed.success) throw errors.conflict("The saved analysis results cannot be previewed.");
  if (new Set(indexes).size !== indexes.length || indexes.some((index) => index >= parsed.data.products.length)) {
    throw errors.validation([{ field: "indexes", message: "Select distinct product candidates from this analysis." }]);
  }
  const fields = await db.attributeField.findMany({
    where: { isArchived: false },
    select: { id: true, nameEn: true, nameFr: true, dataType: true, unit: true, attributeSet: { select: { id: true, nameEn: true } } },
    orderBy: [{ nameEn: "asc" }, { id: "asc" }],
  });
  const matchable = fields.map((field) => ({
    id: field.id, name: field.nameEn, aliases: [field.nameFr], dataType: field.dataType, unit: field.unit,
  }));
  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const grouped = new Map<string, { name: string; examples: string[] }>();
  const selected = indexes.map((index) => ({ index, ...parsed.data.products[index]! }));
  const imageCandidates = await db.catalogImageCandidate.findMany({
    where: { jobId }, select: { id: true, pageNumber: true }, orderBy: [{ pageNumber: "asc" }, { id: "asc" }],
  });
  const tree = await categoryTreeSnapshot(db);
  for (const product of selected) {
    for (const attribute of product.attributes) {
      const key = normalizeAttributeName(attribute.name);
      const group = grouped.get(key) ?? { name: attribute.name, examples: [] };
      if (!group.examples.includes(attribute.value) && group.examples.length < 3) group.examples.push(attribute.value);
      grouped.set(key, group);
    }
  }
  const attributes = [...grouped.values()].map((group) => {
    const match = matchCatalogAttribute({ name: group.name, dataType: "text", unit: null }, matchable);
    const candidates = match.kind === "reuse" ? [match.attribute] : match.kind === "review" ? match.candidates : [];
    return {
      ...group,
      status: match.kind === "reuse" && fieldById.get(match.attribute.id)?.attributeSet ? "review" : match.kind,
      candidates: candidates.map((candidate) => {
        const field = fieldById.get(candidate.id)!;
        return { ...candidate, set: field.attributeSet ? { id: field.attributeSet.id, name: field.attributeSet.nameEn } : null };
      }),
    };
  });
  const skus = selected.flatMap((product) => product.sku?.trim() ? [nameKeyOf(product.sku)] : []);
  const existing = catalog.supplierId && skus.length > 0
    ? await db.product.findMany({
      where: { supplierId: catalog.supplierId, skuKey: { in: skus } },
      select: { skuKey: true },
    })
    : [];
  const existingSkus = new Set(existing.map((product) => product.skuKey));
  const skuCounts = new Map<string, number>();
  for (const sku of skus) skuCounts.set(sku, (skuCounts.get(sku) ?? 0) + 1);
  const products = selected.map((product) => {
    const sku = product.sku?.trim() ? nameKeyOf(product.sku) : null;
    return {
      index: product.index,
      name: product.name,
      sku: product.sku,
      images: imageCandidates.filter((image) => product.source?.pageNumbers.includes(image.pageNumber)),
      categories: [...new Map((product.categories ?? []).map((name) => [nameKeyOf(name), name.trim()])).values()].map((name) => ({
        name,
        matches: tree.categories.filter((category) => nameKeyOf(category.name.en) === nameKeyOf(name)).map((category) => category.id),
      })),
      duplicateExisting: sku !== null && existingSkus.has(sku),
      duplicateInSelection: sku !== null && (skuCounts.get(sku) ?? 0) > 1,
      attributeNames: [...new Set(product.attributes.map((attribute) =>
        grouped.get(normalizeAttributeName(attribute.name))!.name))],
      attributeValues: product.attributes.map((attribute) => ({
        name: grouped.get(normalizeAttributeName(attribute.name))!.name,
        value: attribute.value,
      })),
      missing: sku ? [] : ["sku"],
    };
  });
  await recordAudit(db, request, {
    action: AuditAction.CATALOG_ANALYSIS_VIEW,
    outcome: "success",
    entityType: "Catalog",
    entityId: catalogId,
  });
  return { jobId, supplierId: catalog.supplierId, products, attributes, categoryTree: tree, imageWarnings: parsed.data.imageWarnings ?? [] };
}

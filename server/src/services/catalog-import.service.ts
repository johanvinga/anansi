import { errors } from "../errors.js";
import { nameKeyOf, PRISMA_UNIQUE_VIOLATION } from "../lib/text.js";
import { AuditAction, recordAudit, type AuditRequestContext } from "./audit.service.js";
import { matchCatalogAttribute, normalizeAttributeName } from "./catalog-attribute-matching.js";
import { resultsSchema } from "./catalog-import-preview.js";
import { createIndependentAttributeInTransaction } from "./independent-attribute.service.js";
import { createProductInTransaction } from "./product.service.js";
import { validateAttributeValues, type RawAttributeValue } from "./attribute-values.js";
import { categoryTreeSnapshot, createCategoryInTransaction, lockCategoryTree } from "./category.service.js";
import type { AssetDeps } from "./asset.service.js";
import { readPrivateImage } from "../lib/read-private-image.js";
import { commitStagedImage, discardStagedImage, stageImage } from "./stored-file-cleanup.js";

export interface ImportProductInput {
  index: number;
  sku: string;
  imageId?: string | null | undefined;
  cost?: string | undefined;
  currency?: string | undefined;
  minQuantity?: number | undefined;
  attributeValues?: { name: string; value: string | boolean }[] | undefined;
  categoryDecisions?: ({ name: string; action: "reuse"; categoryId: string } | { name: string; action: "create"; parentId: string | null })[] | undefined;
  additionalCategoryIds?: string[] | undefined;
}

export interface ImportMapping {
  name: string;
  attributeId: string | null;
  skip?: boolean | undefined;
}

export async function importCatalogProducts(
  deps: AssetDeps,
  request: AuditRequestContext,
  catalogId: string,
  jobId: string,
  supplierId: string,
  products: ImportProductInput[],
  mappings: ImportMapping[],
  categoryTreeVersion?: string,
) {
  const { db } = deps;
  const staged = new Map<number, { key: string; imageId: string; pageNumber: number; mimeType: string; sizeBytes: number }>();
  const committed = new Set<number>();
  try {
    if (new Set(products.map((product) => product.index)).size !== products.length) {
      throw errors.validation([{ field: "products", message: "Select distinct product candidates from this analysis." }]);
    }
    for (const product of products) {
      const imageId = product.imageId;
      if (!imageId) continue;
      const { image, buffer } = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM catalogs WHERE id = ${catalogId}::uuid FOR UPDATE`;
        const image = await tx.catalogImageCandidate.findFirst({ where: { id: imageId, jobId, job: { catalogId } } });
        if (!image) throw errors.conflict("A selected image is no longer available. Review the analysis again.");
        return { image, buffer: await readPrivateImage(deps.storage, image.storageKey, image.sizeBytes) };
      }, { timeout: 120_000 });
      const key = await stageImage(db, deps.storage, buffer, image.mimeType);
      staged.set(product.index, { key, imageId: image.id, pageNumber: image.pageNumber, mimeType: image.mimeType, sizeBytes: buffer.length });
    }
    const outcome = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM catalogs WHERE id = ${catalogId}::uuid FOR UPDATE`;
      const catalog = await tx.catalog.findUnique({
        where: { id: catalogId },
        include: { extractionJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
      });
      if (!catalog) throw errors.notFound("Catalog");
      if (!catalog.supplierId || catalog.supplierId !== supplierId) {
        throw errors.conflict("Confirm and assign the supplier before importing.");
      }
      await tx.$queryRaw`SELECT id FROM suppliers WHERE id = ${supplierId}::uuid FOR UPDATE`;
      const job = catalog.extractionJobs[0];
      if (!job || job.id !== jobId || job.status !== "processed") throw errors.conflict("The analysis changed. Review it again.");
      const parsed = resultsSchema.safeParse(job.results);
      if (!parsed.success) throw errors.conflict("The saved analysis results cannot be imported.");
      if (new Set(products.map((p) => p.index)).size !== products.length || products.some((p) => p.index >= parsed.data.products.length)) {
        throw errors.validation([{ field: "products", message: "Select distinct product candidates from this analysis." }]);
      }
      for (const selection of products) {
        const stagedImage = staged.get(selection.index);
        if (!stagedImage) continue;
        const candidate = await tx.catalogImageCandidate.findFirst({
          where: { id: stagedImage.imageId, jobId, pageNumber: stagedImage.pageNumber },
        });
        if (!candidate || !parsed.data.products[selection.index]!.source?.pageNumbers.includes(stagedImage.pageNumber)) {
          throw errors.conflict("A selected image is not available for this product. Review the analysis again.");
        }
      }
      const skuKeys = products.map((p) => nameKeyOf(p.sku));
      const existing = await tx.product.findMany({
        where: { supplierId, skuKey: { in: skuKeys } }, select: { skuKey: true },
      });
      const seen = new Set(existing.map((p) => p.skuKey));
      const selected: ImportProductInput[] = [];
      const skipped: number[] = [];
      for (const product of products) {
        const key = nameKeyOf(product.sku);
        if (seen.has(key)) skipped.push(product.index);
        else { seen.add(key); selected.push(product); }
      }
      const needsCategories = selected.some((selection) =>
        (parsed.data.products[selection.index]!.categories?.length ?? 0) > 0 ||
        (selection.categoryDecisions?.length ?? 0) > 0 || (selection.additionalCategoryIds?.length ?? 0) > 0);
      const categoryIdsByProduct = new Map<number, string[]>();
      if (needsCategories) {
        await lockCategoryTree(tx);
        const tree = await categoryTreeSnapshot(tx);
        if (!categoryTreeVersion || tree.version !== categoryTreeVersion) {
          throw errors.conflict("The category tree changed or was not reviewed. Refresh the import preview.");
        }
        const categories = new Map(tree.categories.map((category) => [category.id, category]));
        const created = new Map<string, string>();
        for (const selection of selected) {
          const suggestions = new Map((parsed.data.products[selection.index]!.categories ?? []).map((name) => [nameKeyOf(name), name]));
          const decisions = new Map<string, NonNullable<ImportProductInput["categoryDecisions"]>[number]>();
          for (const decision of selection.categoryDecisions ?? []) {
            const key = nameKeyOf(decision.name);
            if (!suggestions.has(key) || decisions.has(key)) throw errors.validation([{ field: "products", message: "Invalid or repeated category decision." }]);
            decisions.set(key, decision);
          }
          const ids = new Set<string>();
          for (const [key, name] of suggestions) {
            const decision = decisions.get(key);
            if (!decision) throw errors.validation([{ field: "products", message: `Review the category "${name}" before importing.` }]);
            if (decision.action === "reuse") {
              if (!categories.has(decision.categoryId)) throw errors.conflict(`The selected category for "${name}" is no longer available.`);
              ids.add(decision.categoryId);
            } else {
              if (decision.parentId && !categories.has(decision.parentId)) throw errors.conflict(`The parent for "${name}" is no longer available.`);
              const identity = `${decision.parentId ?? "root"}:${key}`;
              let id = created.get(identity);
              if (!id) {
                if (tree.categories.some((category) => category.parentId === decision.parentId && nameKeyOf(category.name.en) === key)) {
                  throw errors.conflict(`The category "${name}" already exists under the selected parent. Review it again.`);
                }
                const row = await createCategoryInTransaction(tx, request, { en: name, fr: name }, decision.parentId);
                id = row.id;
                created.set(identity, id);
              }
              ids.add(id);
            }
          }
          for (const id of selection.additionalCategoryIds ?? []) {
            if (!categories.has(id)) throw errors.conflict("A selected category is no longer available.");
            ids.add(id);
          }
          categoryIdsByProduct.set(selection.index, [...ids]);
        }
      }
      const needed = new Map<string, string>();
      for (const selection of selected) {
        for (const attribute of parsed.data.products[selection.index]!.attributes) {
          needed.set(normalizeAttributeName(attribute.name), attribute.name);
        }
      }
      const decisions = new Map<string, ImportMapping>();
      for (const mapping of mappings) {
        const key = normalizeAttributeName(mapping.name);
        if (decisions.has(key)) throw errors.validation([{ field: "mappings", message: "Each extracted attribute requires one mapping." }]);
        decisions.set(key, mapping);
      }
      const independentFields = await tx.attributeField.findMany({
        where: { attributeSetId: null, isArchived: false },
        select: { id: true, nameEn: true, nameFr: true, dataType: true, unit: true },
      });
      for (const [key, name] of needed) {
        if (decisions.has(key)) continue;
        const match = matchCatalogAttribute({ name, dataType: "text", unit: null }, independentFields.map((field) => ({
          id: field.id, name: field.nameEn, aliases: [field.nameFr], dataType: field.dataType, unit: field.unit,
        })));
        if (match.kind !== "reuse") {
          throw errors.validation([{ field: "mappings", message: `Choose whether to create, map, or skip the attribute "${name}" before importing.` }]);
        }
        decisions.set(key, { name, attributeId: match.attribute.id });
      }
      const definitions = new Map<string, { id: string; dataType: "text" | "number" | "decimal" | "boolean" | "date" | "select"; unit: string | null; name: string; isArchived: boolean; options: { id: string; label: string }[] }>();
      const mappedIds = [...new Set([...needed.keys()].flatMap((key) => {
        const id = decisions.get(key)!.attributeId;
        return id ? [id] : [];
      }))].sort();
      for (const id of mappedIds) {
        await tx.$queryRaw`SELECT id FROM attribute_fields WHERE id = ${id}::uuid FOR UPDATE`;
      }
      for (const [key, name] of [...needed].sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)) {
        const mapping = decisions.get(key)!;
        if (mapping.skip) continue;
        if (mapping.attributeId) {
          const field = await tx.attributeField.findFirst({
            where: { id: mapping.attributeId, attributeSetId: null, isArchived: false },
            include: { options: true },
          });
          if (!field) throw errors.conflict(`The selected attribute for "${name}" is no longer available.`);
          definitions.set(key, { id: field.id, dataType: field.dataType, unit: field.unit, name: field.nameEn, isArchived: field.isArchived,
            options: field.options.map((option) => ({ id: option.id, label: option.labelEn })) });
        } else {
          const existingField = await tx.attributeField.findFirst({
            where: { attributeSetId: null, nameEn: { equals: name, mode: "insensitive" } },
          });
          if (existingField) throw errors.conflict(`An independent attribute named "${name}" already exists. Review the mapping again.`);
          const field = await createIndependentAttributeInTransaction(tx, request, { en: name, fr: name });
          definitions.set(key, { id: field.id, dataType: field.dataType, unit: field.unit, name: field.name.en, isArchived: false, options: [] });
        }
      }
      const productValues = new Map<number, { fieldId: string; value: RawAttributeValue }[]>();
      for (const selection of selected) {
        const candidate = parsed.data.products[selection.index]!;
        const overrides = new Map<string, string | boolean>();
        for (const value of selection.attributeValues ?? []) {
          const key = normalizeAttributeName(value.name);
          if (overrides.has(key) || !candidate.attributes.some((attribute) => normalizeAttributeName(attribute.name) === key)) {
            throw errors.validation([{ field: "products", message: `Invalid or repeated reviewed attribute for "${candidate.name}".` }]);
          }
          if (decisions.get(key)?.skip) {
            throw errors.validation([{ field: "products", message: `A skipped attribute cannot have a reviewed value for "${candidate.name}".` }]);
          }
          overrides.set(key, value.value);
        }
        const directValues = candidate.attributes.flatMap((attribute) => {
          const key = normalizeAttributeName(attribute.name);
          if (decisions.get(key)!.skip) return [];
          const definition = definitions.get(key)!;
          const reviewed = overrides.get(key);
          if ((definition.dataType !== "text" || definition.unit !== null) && reviewed === undefined) {
            throw errors.validation([{ field: "products", message: `Review the value for "${attribute.name}" on "${candidate.name}".` }]);
          }
          return [{ fieldId: definition.id, value: reviewed ?? attribute.value }];
        });
        const fieldDefinitions = [...definitions.values()].map((field) => ({ ...field, isRequired: false }));
        const validation = validateAttributeValues(fieldDefinitions, directValues);
        if (validation.errors.length) {
          throw errors.validation(validation.errors.map((problem) => ({ ...problem, message: `${candidate.name}: ${problem.message}` })));
        }
        productValues.set(selection.index, directValues);
      }
      const created: string[] = [];
      for (const selection of selected) {
        const candidate = parsed.data.products[selection.index]!;
        const product = await createProductInTransaction(tx, request, supplierId, {
          name: { en: candidate.name, fr: candidate.name },
          description: { en: candidate.description ?? null, fr: candidate.description ?? null },
          supplierSku: selection.sku, cost: selection.cost ?? null, currency: selection.currency ?? null,
          minQuantity: selection.minQuantity ?? null, categories: (categoryIdsByProduct.get(selection.index) ?? []).map((id) => ({ id })),
          directAttributeValues: productValues.get(selection.index)!,
          ...(candidate.source?.pageNumbers.length
            ? { catalogSource: { catalogId, pageNumbers: candidate.source.pageNumbers } }
            : {}),
        });
        const image = staged.get(selection.index);
        if (image) {
          await tx.productImage.create({
            data: { productId: product.id, storageKey: image.key, mimeType: image.mimeType, sizeBytes: image.sizeBytes },
          });
          await commitStagedImage(tx, image.key);
          await recordAudit(tx, request, {
            action: AuditAction.PRODUCT_IMAGE_UPDATE, outcome: "success", entityType: "Product", entityId: product.id,
            changes: { image: { before: null, after: { mimeType: image.mimeType, sizeBytes: image.sizeBytes } } },
          });
        }
        created.push(product.id);
      }
      await recordAudit(tx, request, {
        action: AuditAction.CATALOG_ANALYSIS_VIEW, outcome: "success",
        entityType: "Catalog", entityId: catalogId,
      });
      return { created, skipped, importedIndexes: selected.map((selection) => selection.index) };
    }, { timeout: 120_000 });
    for (const index of outcome.importedIndexes) committed.add(index);
    for (const [index, image] of staged) if (!committed.has(index)) await discardStagedImage(db, image.key);
    return { created: outcome.created, skipped: outcome.skipped };
  } catch (error) {
    for (const [index, image] of staged) if (!committed.has(index)) await discardStagedImage(db, image.key);
    if ((error as { code?: string } | null)?.code === PRISMA_UNIQUE_VIOLATION) {
      throw errors.conflict("An attribute or SKU changed during import. Review and retry.");
    }
    throw error;
  }
}

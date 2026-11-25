import type { Prisma } from "../generated/prisma/client.js";
import type { Database } from "../db.js";
import { AppError, errors } from "../errors.js";
import { nameKeyOf, PRISMA_UNIQUE_VIOLATION } from "../lib/text.js";
import type { Translated, TranslatedText } from "../lib/translations.js";
import { loadFieldDefinitions } from "./attribute-set.service.js";
import { expandCategoryIds, resolveCategoryIds, type CategoryInput } from "./category.service.js";
import {
  fromValueColumns,
  toValueColumns,
  validateAttributeValues,
  type AttributeDataType,
  type AttributeValueInput,
} from "./attribute-values.js";
import {
  AuditAction,
  diffFields,
  recordAudit,
  type AuditRequestContext,
} from "./audit.service.js";
import { queueStoredFileRemoval } from "./stored-file-cleanup.js";

type Tx = Prisma.TransactionClient;

export interface ProductInput {
  name: Translated;
  /** Optional in both locales; omitted or empty values are stored as null (FR-PRD-10). */
  description: TranslatedText;
  supplierSku: string;
  minQuantity: number | null;
  /** Decimal string with at most 2 decimal places; validated by the route schema. */
  cost: string | null;
  currency: string | null;
  /** Replaces product categories when supplied on update. */
  categories?: CategoryInput[] | undefined;
  /** `undefined` keeps the current set on update; `null` removes it. */
  attributeSetId?: string | null | undefined;
  /** When omitted on update and the set is unchanged, existing values are kept. */
  attributeValues?: AttributeValueInput[] | undefined;
  directAttributeValues?: AttributeValueInput[] | undefined;
  catalogSource?: { catalogId: string; pageNumbers: number[] } | undefined;
}

export interface ProductUpdateInput extends ProductInput {
  /** Moves the product to another supplier (used to clear a supplier before deleting it, SPEC §8.3). */
  supplierId?: string | undefined;
}

export interface ListProductsFilters {
  supplierId?: string | undefined;
  q?: string | undefined;
  category?: string[] | undefined;
  uncategorized?: boolean | undefined;
  page: number;
  pageSize: number;
}

const listInclude = {
  supplier: { select: { id: true, name: true } },
  attributeSet: { select: { id: true, nameEn: true, nameFr: true } },
  categories: { include: { category: true } },
  image: true,
  sourceCatalog: { select: { id: true, name: true, version: true } },
} satisfies Prisma.ProductInclude;

const detailInclude = {
  ...listInclude,
  values: { include: { field: { include: { sets: true } }, option: true } },
} satisfies Prisma.ProductInclude;

type ListRow = Prisma.ProductGetPayload<{ include: typeof listInclude }>;
type DetailRow = Prisma.ProductGetPayload<{ include: typeof detailInclude }>;

function toProductSummary(row: ListRow) {
  return {
    id: row.id,
    supplierId: row.supplierId,
    supplierName: row.supplier.name,
    name: { en: row.nameEn, fr: row.nameFr },
    supplierSku: row.supplierSku,
    minQuantity: row.minQuantity,
    cost: row.cost?.toFixed(2) ?? null,
    currency: row.currency,
    image: row.image ? { mimeType: row.image.mimeType, sizeBytes: row.image.sizeBytes } : null,
    catalogSource: row.sourceCatalog
      ? {
          id: row.sourceCatalog.id,
          name: row.sourceCatalog.name,
          version: row.sourceCatalog.version,
          pageNumbers: [...row.sourcePageNumbers].sort((a, b) => a - b),
        }
      : null,
    attributeSet: row.attributeSet
      ? { id: row.attributeSet.id, name: { en: row.attributeSet.nameEn, fr: row.attributeSet.nameFr } }
      : null,
    categories: row.categories
      .map((link) => ({
        id: link.category.id,
        name: { en: link.category.nameEn, fr: link.category.nameFr },
      }))
      .sort((a, b) => a.name.en.localeCompare(b.name.en)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type ProductSummaryDto = ReturnType<typeof toProductSummary>;

function toProductDetail(row: DetailRow) {
  return {
    ...toProductSummary(row),
    description: { en: row.descriptionEn, fr: row.descriptionFr },
    // Includes archived fields: their values are preserved and returned (SPEC §8.1).
    attributeValues: [...row.values]
      .sort((a, b) => a.field.sortOrder - b.field.sortOrder)
      .map((value) => ({
        fieldId: value.attributeFieldId,
        code: value.field.code,
        name: { en: value.field.nameEn, fr: value.field.nameFr },
        dataType: value.field.dataType,
        unit: value.field.unit,
        isArchived: value.field.isArchived || value.field.sets.some((membership) => membership.attributeSetId === row.attributeSetId && membership.isArchived),
        value: fromValueColumns(value.field.dataType as AttributeDataType, value),
        optionLabel: value.option ? { en: value.option.labelEn, fr: value.option.labelFr } : null,
      })),
  };
}

export type ProductDetailDto = ReturnType<typeof toProductDetail>;

/** Flattened audit snapshot so each attribute change appears as its own entry. */
function snapshotOf(row: DetailRow): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    supplier: row.supplier.name,
    "name.en": row.nameEn,
    "name.fr": row.nameFr,
    "description.en": row.descriptionEn,
    "description.fr": row.descriptionFr,
    supplierSku: row.supplierSku,
    minQuantity: row.minQuantity,
    cost: row.cost?.toFixed(2) ?? null,
    currency: row.currency,
    attributeSet: row.attributeSet?.nameEn ?? null,
    categories: row.categories.map((link) => link.category.nameEn).sort(),
    catalogSource: row.sourceCatalog?.name ?? null,
    catalogPages: row.sourcePageNumbers,
  };
  for (const value of row.values) {
    const output = fromValueColumns(value.field.dataType as AttributeDataType, value);
    snapshot[`attribute.${value.field.code}`] = value.option?.labelEn ?? output;
  }
  return snapshot;
}

const duplicateSku = () => errors.conflict("This supplier already has a product with this SKU.");

function nameAndDescriptionColumns(input: ProductInput) {
  return {
    nameEn: input.name.en.trim(),
    nameFr: input.name.fr.trim(),
    descriptionEn: input.description.en,
    descriptionFr: input.description.fr,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === PRISMA_UNIQUE_VIOLATION;
}

async function assertSkuAvailable(db: Database | Tx, supplierId: string, sku: string, exceptId?: string) {
  const match = await db.product.findUnique({
    where: { supplierId_skuKey: { supplierId, skuKey: nameKeyOf(sku) } },
    select: { id: true },
  });
  if (match && match.id !== exceptId) throw duplicateSku();
}

async function loadDetail(db: Database | Tx, id: string): Promise<DetailRow> {
  const row = await db.product.findUnique({ where: { id }, include: detailInclude });
  if (!row) throw errors.notFound("Product");
  return row;
}

/**
 * Validates values against the set and returns rows ready to insert.
 * Throws a VALIDATION_ERROR listing every problem at once so forms can show all errors inline.
 */
async function prepareValues(tx: Tx, attributeSetId: string | null, inputs: AttributeValueInput[]) {
  if (!attributeSetId) {
    if (inputs.length > 0) {
      throw errors.validation([{ field: "attributeValues", message: "Assign an attribute set before entering attribute values." }]);
    }
    return [];
  }
  await tx.$queryRaw`SELECT id FROM attribute_sets WHERE id = ${attributeSetId}::uuid FOR UPDATE`;
  const set = await tx.attributeSet.findUnique({ where: { id: attributeSetId }, select: { id: true } });
  if (!set) {
    throw errors.validation([{ field: "attributeSetId", message: "The selected attribute set does not exist." }]);
  }
  const fields = await loadFieldDefinitions(tx, attributeSetId);
  const { values, errors: problems } = validateAttributeValues(fields, inputs);
  if (problems.length > 0) {
    throw new AppError(400, "VALIDATION_ERROR", "Some attribute values are invalid.", problems);
  }
  return [...values.entries()].map(([attributeFieldId, value]) => ({ attributeFieldId, ...toValueColumns(value) }));
}

async function prepareDirectValues(tx: Tx, inputs: AttributeValueInput[]) {
  for (const id of [...new Set(inputs.map((input) => input.fieldId))].sort()) {
    await tx.$queryRaw`SELECT id FROM attribute_fields WHERE id = ${id}::uuid FOR UPDATE`;
  }
  const fields = await tx.attributeField.findMany({
    where: { attributeSetId: null, id: { in: inputs.map((input) => input.fieldId) } },
    include: { options: true },
  });
  const definitions = fields.map((field) => ({
    id: field.id, name: field.nameEn, dataType: field.dataType,
    isRequired: false, isArchived: field.isArchived,
    options: field.options.map((option) => ({ id: option.id, label: option.labelEn })),
  }));
  const { values, errors: problems } = validateAttributeValues(definitions, inputs);
  if (problems.length) throw new AppError(400, "VALIDATION_ERROR", "Some attribute values are invalid.", problems);
  return [...values.entries()].map(([attributeFieldId, value]) => ({ attributeFieldId, ...toValueColumns(value) }));
}

async function assertSupplierExists(db: Database | Tx, supplierId: string, asValidation = false) {
  const supplier = await db.supplier.findUnique({ where: { id: supplierId }, select: { id: true } });
  if (!supplier) {
    if (asValidation) throw errors.validation([{ field: "supplierId", message: "The selected supplier does not exist." }]);
    throw errors.notFound("Supplier");
  }
}

async function assertCatalogSource(
  tx: Tx,
  supplierId: string,
  source: ProductInput["catalogSource"],
) {
  if (!source) return;
  const pages = [...new Set(source.pageNumbers)].sort((a, b) => a - b);
  if (pages.length === 0 || pages.some((page) => !Number.isInteger(page) || page <= 0)) {
    throw errors.validation([{ field: "catalogSource.pageNumbers", message: "Catalog page numbers must be positive integers." }]);
  }
  const catalog = await tx.catalog.findUnique({
    where: { id: source.catalogId },
    select: {
      supplierId: true,
      extractionJobs: {
        where: { status: "processed" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { totalPages: true },
      },
    },
  });
  if (!catalog || catalog.supplierId !== supplierId) {
    throw errors.validation([{ field: "catalogSource.catalogId", message: "The source catalog must belong to this product's supplier." }]);
  }
  const totalPages = catalog.extractionJobs[0]?.totalPages;
  if (pages.some((page) => totalPages !== undefined && page > totalPages)) {
    throw errors.validation([{ field: "catalogSource.pageNumbers", message: "A catalog page number is outside the analyzed catalog." }]);
  }
  return pages;
}

export async function listProducts(db: Database, request: AuditRequestContext, filters: ListProductsFilters) {
  const categoryIds = await expandCategoryIds(db, filters.category ?? []);
  const categoryFilters: Prisma.ProductWhereInput[] = [];
  if (categoryIds.length) categoryFilters.push({ categories: { some: { categoryId: { in: categoryIds } } } });
  if (filters.uncategorized) categoryFilters.push({ categories: { none: {} } });
  const where: Prisma.ProductWhereInput = {
    supplierId: filters.supplierId,
    OR: filters.q
      ? [
          { nameEn: { contains: filters.q, mode: "insensitive" } },
          { nameFr: { contains: filters.q, mode: "insensitive" } },
          { supplierSku: { contains: filters.q, mode: "insensitive" } },
        ]
      : undefined,
    AND: categoryFilters.length ? [{ OR: categoryFilters }] : undefined,
  };
  const [total, rows] = await db.$transaction([
    db.product.count({ where }),
    db.product.findMany({
      where,
      include: listInclude,
      orderBy: [{ nameEn: "asc" }, { id: "asc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
  ]);
  await recordAudit(db, request, {
    action: AuditAction.PRODUCT_LIST,
    outcome: "success",
    entityType: filters.supplierId ? "Supplier" : undefined,
    entityId: filters.supplierId,
  });
  return { items: rows.map(toProductSummary), total, page: filters.page, pageSize: filters.pageSize };
}

export async function listSupplierProducts(db: Database, request: AuditRequestContext, supplierId: string, filters: Omit<ListProductsFilters, "supplierId">) {
  await assertSupplierExists(db, supplierId);
  return listProducts(db, request, { ...filters, supplierId });
}

export async function getProduct(db: Database, request: AuditRequestContext, id: string): Promise<ProductDetailDto> {
  const row = await loadDetail(db, id);
  await recordAudit(db, request, {
    action: AuditAction.PRODUCT_VIEW,
    outcome: "success",
    entityType: "Product",
    entityId: id,
  });
  return toProductDetail(row);
}

export async function createProduct(
  db: Database,
  request: AuditRequestContext,
  supplierId: string,
  input: ProductInput,
): Promise<ProductDetailDto> {
  await assertSupplierExists(db, supplierId);
  await assertSkuAvailable(db, supplierId, input.supplierSku);
  try {
    return await db.$transaction(async (tx) => {
      return createProductInTransaction(tx, request, supplierId, input);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateSku();
    throw error;
  }
}

export async function createProductInTransaction(
  tx: Tx,
  request: AuditRequestContext,
  supplierId: string,
  input: ProductInput,
): Promise<ProductDetailDto> {
  const attributeSetId = input.attributeSetId ?? null;
  const values = await prepareValues(tx, attributeSetId, input.attributeValues ?? []);
  const directValues = await prepareDirectValues(tx, input.directAttributeValues ?? []);
  const setFieldIds = attributeSetId ? (await loadFieldDefinitions(tx, attributeSetId)).map((field) => field.id) : [];
  if ((input.directAttributeValues ?? []).some((value) => setFieldIds.includes(value.fieldId))) {
    throw errors.validation([{ field: "directAttributeValues", message: "An attribute cannot be submitted both directly and through the set." }]);
  }
  const categoryIds = await resolveCategoryIds(tx, request, input.categories ?? []);
  const sourcePageNumbers = await assertCatalogSource(tx, supplierId, input.catalogSource);
  const created = await tx.product.create({
    data: {
      supplierId, ...nameAndDescriptionColumns(input), supplierSku: input.supplierSku.trim(),
      skuKey: nameKeyOf(input.supplierSku), minQuantity: input.minQuantity, cost: input.cost,
      currency: input.currency, attributeSetId, values: { create: [...values, ...directValues] },
      sourceCatalogId: input.catalogSource?.catalogId ?? null,
      sourcePageNumbers,
      categories: { create: categoryIds.map((categoryId) => ({ categoryId })) },
    },
  });
  const row = await loadDetail(tx, created.id);
  await recordAudit(tx, request, {
    action: AuditAction.PRODUCT_CREATE, outcome: "success", entityType: "Product",
    entityId: row.id, changes: diffFields({}, snapshotOf(row)),
  });
  return toProductDetail(row);
}

export async function updateProduct(
  db: Database,
  request: AuditRequestContext,
  id: string,
  input: ProductUpdateInput,
): Promise<ProductDetailDto> {
  try {
    return await db.$transaction(async (tx) => {
      const existing = await loadDetail(tx, id);
      const supplierId = input.supplierId ?? existing.supplierId;
      if (supplierId !== existing.supplierId) {
        await assertSupplierExists(tx, supplierId, true);
      }
      await assertSkuAvailable(tx, supplierId, input.supplierSku, id);

      const attributeSetId = input.attributeSetId === undefined ? existing.attributeSetId : input.attributeSetId;
      const setChanged = attributeSetId !== existing.attributeSetId;
      for (const setId of [...new Set([existing.attributeSetId, attributeSetId].filter((value): value is string => value !== null))].sort()) {
        await tx.$queryRaw`SELECT id FROM attribute_sets WHERE id = ${setId}::uuid FOR UPDATE`;
      }
      const membershipIds = attributeSetId
        ? (await tx.attributeSetField.findMany({ where: { attributeSetId }, select: { attributeFieldId: true, isArchived: true } }))
        : [];
      if (input.directAttributeValues?.some((value) => membershipIds.some((member) => member.attributeFieldId === value.fieldId))) {
        throw errors.validation([{ field: "directAttributeValues", message: "Set attributes must be submitted through attributeValues." }]);
      }
      if (input.categories !== undefined) {
        const categoryIds = await resolveCategoryIds(tx, request, input.categories);
        await tx.productCategory.deleteMany({ where: { productId: id } });
        await tx.productCategory.createMany({
          data: categoryIds.map((categoryId) => ({ productId: id, categoryId })),
        });
      }

      if (setChanged) {
        // Values for fields outside the new set are removed (FR-PRD-07, SPEC §8.2).
        const values = await prepareValues(tx, attributeSetId, input.attributeValues ?? []);
        await tx.productAttributeValue.deleteMany({ where: { productId: id, field: { attributeSetId: { not: null } } } });
        await tx.productAttributeValue.deleteMany({ where: { productId: id, attributeFieldId: { in: membershipIds.filter((member) => !member.isArchived).map((member) => member.attributeFieldId) } } });
        await tx.productAttributeValue.createMany({ data: values.map((v) => ({ productId: id, ...v })) });
      } else if (input.attributeValues !== undefined) {
        // Archived field values are kept; only active fields are replaced.
        const values = await prepareValues(tx, attributeSetId, input.attributeValues);
        await tx.productAttributeValue.deleteMany({ where: { productId: id, field: { isArchived: false, attributeSetId: { not: null } } } });
        await tx.productAttributeValue.deleteMany({ where: { productId: id, attributeFieldId: { in: membershipIds.filter((member) => !member.isArchived).map((member) => member.attributeFieldId) } } });
        await tx.productAttributeValue.createMany({ data: values.map((v) => ({ productId: id, ...v })) });
      }
      if (input.directAttributeValues !== undefined) {
        const values = await prepareDirectValues(tx, input.directAttributeValues);
        await tx.productAttributeValue.deleteMany({ where: { productId: id, attributeFieldId: { notIn: membershipIds.map((member) => member.attributeFieldId) }, field: { isArchived: false, attributeSetId: null } } });
        await tx.productAttributeValue.createMany({ data: values.map((v) => ({ productId: id, ...v })) });
      }

      await tx.product.update({
        where: { id },
        data: {
          supplierId,
          ...nameAndDescriptionColumns(input),
          supplierSku: input.supplierSku.trim(),
          skuKey: nameKeyOf(input.supplierSku),
          minQuantity: input.minQuantity,
          cost: input.cost,
          currency: input.currency,
          attributeSetId,
        },
      });

      const row = await loadDetail(tx, id);
      const changes = diffFields(snapshotOf(existing), snapshotOf(row));
      if (changes) {
        await recordAudit(tx, request, {
          action: AuditAction.PRODUCT_UPDATE,
          outcome: "success",
          entityType: "Product",
          entityId: id,
          changes,
        });
      }
      return toProductDetail(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateSku();
    throw error;
  }
}

export async function deleteProduct(db: Database, request: AuditRequestContext, id: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM products WHERE id = ${id}::uuid FOR UPDATE`;
    const existing = await loadDetail(tx, id);
    if (existing.image) await queueStoredFileRemoval(tx, existing.image.storageKey);
    // Attribute values are removed by the database cascade (SPEC §8.3).
    await tx.pinnedItem.deleteMany({ where: { itemType: "product", itemId: id } });
    await tx.sharedItem.deleteMany({ where: { itemType: "product", itemId: id } });
    await tx.product.delete({ where: { id } });
    await recordAudit(tx, request, {
      action: AuditAction.PRODUCT_DELETE,
      outcome: "success",
      entityType: "Product",
      entityId: id,
      changes: diffFields(snapshotOf(existing), {}),
    });
    return existing.image !== null;
  });
}

import type { Prisma } from "../generated/prisma/client.js";
import type { Database } from "../db.js";
import { AppError, errors } from "../errors.js";
import { nameKeyOf, PRISMA_UNIQUE_VIOLATION } from "../lib/text.js";
import { loadFieldDefinitions } from "./attribute-set.service.js";
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

type Tx = Prisma.TransactionClient;

export interface ProductInput {
  name: string;
  supplierSku: string;
  minQuantity: number;
  /** Decimal string with at most 2 decimal places; validated by the route schema. */
  cost: string;
  currency: string;
  /** `undefined` keeps the current set on update; `null` removes it. */
  attributeSetId?: string | null | undefined;
  /** When omitted on update and the set is unchanged, existing values are kept. */
  attributeValues?: AttributeValueInput[] | undefined;
}

export interface ProductUpdateInput extends ProductInput {
  /** Moves the product to another supplier (used to clear a supplier before deleting it, SPEC §8.3). */
  supplierId?: string | undefined;
}

export interface ListProductsFilters {
  supplierId?: string | undefined;
  q?: string | undefined;
  page: number;
  pageSize: number;
}

const listInclude = {
  supplier: { select: { id: true, name: true } },
  attributeSet: { select: { id: true, name: true } },
} satisfies Prisma.ProductInclude;

const detailInclude = {
  ...listInclude,
  values: { include: { field: true, option: true } },
} satisfies Prisma.ProductInclude;

type ListRow = Prisma.ProductGetPayload<{ include: typeof listInclude }>;
type DetailRow = Prisma.ProductGetPayload<{ include: typeof detailInclude }>;

function toProductSummary(row: ListRow) {
  return {
    id: row.id,
    supplierId: row.supplierId,
    supplierName: row.supplier.name,
    name: row.name,
    supplierSku: row.supplierSku,
    minQuantity: row.minQuantity,
    cost: row.cost.toFixed(2),
    currency: row.currency,
    attributeSet: row.attributeSet,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type ProductSummaryDto = ReturnType<typeof toProductSummary>;

function toProductDetail(row: DetailRow) {
  return {
    ...toProductSummary(row),
    // Includes archived fields: their values are preserved and returned (SPEC §8.1).
    attributeValues: [...row.values]
      .sort((a, b) => a.field.sortOrder - b.field.sortOrder)
      .map((value) => ({
        fieldId: value.attributeFieldId,
        code: value.field.code,
        name: value.field.name,
        dataType: value.field.dataType,
        unit: value.field.unit,
        isArchived: value.field.isArchived,
        value: fromValueColumns(value.field.dataType as AttributeDataType, value),
        optionLabel: value.option?.label ?? null,
      })),
  };
}

export type ProductDetailDto = ReturnType<typeof toProductDetail>;

/** Flattened audit snapshot so each attribute change appears as its own entry. */
function snapshotOf(row: DetailRow): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    supplier: row.supplier.name,
    name: row.name,
    supplierSku: row.supplierSku,
    minQuantity: row.minQuantity,
    cost: row.cost.toFixed(2),
    currency: row.currency,
    attributeSet: row.attributeSet?.name ?? null,
  };
  for (const value of row.values) {
    const output = fromValueColumns(value.field.dataType as AttributeDataType, value);
    snapshot[`attribute.${value.field.code}`] = value.option?.label ?? output;
  }
  return snapshot;
}

const duplicateSku = () => errors.conflict("This supplier already has a product with this SKU.");

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

async function assertSupplierExists(db: Database | Tx, supplierId: string, asValidation = false) {
  const supplier = await db.supplier.findUnique({ where: { id: supplierId }, select: { id: true } });
  if (!supplier) {
    if (asValidation) throw errors.validation([{ field: "supplierId", message: "The selected supplier does not exist." }]);
    throw errors.notFound("Supplier");
  }
}

export async function listProducts(db: Database, request: AuditRequestContext, filters: ListProductsFilters) {
  const where: Prisma.ProductWhereInput = {
    supplierId: filters.supplierId,
    OR: filters.q
      ? [
          { name: { contains: filters.q, mode: "insensitive" } },
          { supplierSku: { contains: filters.q, mode: "insensitive" } },
        ]
      : undefined,
  };
  const [total, rows] = await db.$transaction([
    db.product.count({ where }),
    db.product.findMany({
      where,
      include: listInclude,
      orderBy: [{ name: "asc" }, { id: "asc" }],
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
      const attributeSetId = input.attributeSetId ?? null;
      const values = await prepareValues(tx, attributeSetId, input.attributeValues ?? []);
      const created = await tx.product.create({
        data: {
          supplierId,
          name: input.name.trim(),
          supplierSku: input.supplierSku.trim(),
          skuKey: nameKeyOf(input.supplierSku),
          minQuantity: input.minQuantity,
          cost: input.cost,
          currency: input.currency,
          attributeSetId,
          values: { create: values },
        },
      });
      const row = await loadDetail(tx, created.id);
      await recordAudit(tx, request, {
        action: AuditAction.PRODUCT_CREATE,
        outcome: "success",
        entityType: "Product",
        entityId: row.id,
        changes: diffFields({}, snapshotOf(row)),
      });
      return toProductDetail(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateSku();
    throw error;
  }
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

      if (setChanged) {
        // Values for fields outside the new set are removed (FR-PRD-07, SPEC §8.2).
        const values = await prepareValues(tx, attributeSetId, input.attributeValues ?? []);
        await tx.productAttributeValue.deleteMany({ where: { productId: id } });
        await tx.productAttributeValue.createMany({ data: values.map((v) => ({ productId: id, ...v })) });
      } else if (input.attributeValues !== undefined) {
        // Archived field values are kept; only active fields are replaced.
        const values = await prepareValues(tx, attributeSetId, input.attributeValues);
        await tx.productAttributeValue.deleteMany({ where: { productId: id, field: { isArchived: false } } });
        await tx.productAttributeValue.createMany({ data: values.map((v) => ({ productId: id, ...v })) });
      }

      await tx.product.update({
        where: { id },
        data: {
          supplierId,
          name: input.name.trim(),
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

export async function deleteProduct(db: Database, request: AuditRequestContext, id: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const existing = await loadDetail(tx, id);
    // Attribute values are removed by the database cascade (SPEC §8.3).
    await tx.product.delete({ where: { id } });
    await recordAudit(tx, request, {
      action: AuditAction.PRODUCT_DELETE,
      outcome: "success",
      entityType: "Product",
      entityId: id,
      changes: diffFields(snapshotOf(existing), {}),
    });
  });
}

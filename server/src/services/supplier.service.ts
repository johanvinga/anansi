import type { FastifyBaseLogger } from "fastify";
import { Prisma } from "../generated/prisma/client.js";
import type { Database } from "../db.js";
import { errors } from "../errors.js";
import type { AssetStorage } from "../lib/asset-storage.js";
import { nameKeyOf, PRISMA_UNIQUE_VIOLATION } from "../lib/text.js";
import {
  AuditAction,
  diffFields,
  recordAudit,
  type AuditRequestContext,
} from "./audit.service.js";
import { removeStoredFiles } from "./asset.service.js";
import { resolveCategoryIds, type CategoryInput } from "./category.service.js";

export interface SupplierInput {
  name: string;
  street?: string | null | undefined;
  city?: string | null | undefined;
  stateRegion?: string | null | undefined;
  postalCode?: string | null | undefined;
  country?: string | null | undefined;
  /** When omitted on update, existing category links are kept. */
  categories?: CategoryInput[] | undefined;
}

export interface ListSuppliersFilters {
  q?: string | undefined;
  categoryIds: string[];
  page: number;
  pageSize: number;
}

const detailInclude = {
  categories: { include: { category: true } },
} satisfies Prisma.SupplierInclude;

type SupplierRow = Prisma.SupplierGetPayload<{ include: typeof detailInclude }>;
type CategoryRefDto = { id: string; name: { en: string; fr: string } };

export type SupplierDto = ReturnType<typeof toSupplierDto>;

function toCategoryRef(category: { id: string; nameEn: string; nameFr: string }): CategoryRefDto {
  return { id: category.id, name: { en: category.nameEn, fr: category.nameFr } };
}

function toSupplierDto(row: SupplierRow, inheritedCategories: CategoryRefDto[] = []) {
  const assignedCategories = row.categories.map((link) => toCategoryRef(link.category));
  const effective = new Map(
    [...assignedCategories, ...inheritedCategories].map((category) => [category.id, category]),
  );
  return {
    id: row.id,
    name: row.name,
    street: row.street,
    city: row.city,
    stateRegion: row.stateRegion,
    postalCode: row.postalCode,
    country: row.country,
    categories: [...effective.values()].sort((a, b) => a.name.en.localeCompare(b.name.en)),
    assignedCategories: assignedCategories.sort((a, b) => a.name.en.localeCompare(b.name.en)),
    inheritedCategories: inheritedCategories
      .filter((category) => !row.categories.some((link) => link.categoryId === category.id))
      .sort((a, b) => a.name.en.localeCompare(b.name.en)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function inheritedCategoriesBySupplier(
  db: Database | Prisma.TransactionClient,
  supplierIds: string[],
): Promise<Map<string, CategoryRefDto[]>> {
  const categoriesBySupplier = new Map<string, Map<string, CategoryRefDto>>();
  if (supplierIds.length === 0) return new Map<string, CategoryRefDto[]>();
  const links = await db.productCategory.findMany({
    where: { product: { supplierId: { in: supplierIds } } },
    select: {
      product: { select: { supplierId: true } },
      category: { select: { id: true, nameEn: true, nameFr: true } },
    },
  });
  for (const link of links) {
    let categories = categoriesBySupplier.get(link.product.supplierId);
    if (!categories) {
      categories = new Map();
      categoriesBySupplier.set(link.product.supplierId, categories);
    }
    categories.set(link.category.id, toCategoryRef(link.category));
  }
  return new Map(
    [...categoriesBySupplier].map(([supplierId, categories]) => [
      supplierId,
      [...categories.values()].sort((a, b) => a.name.en.localeCompare(b.name.en)),
    ]),
  );
}

/** Audit snapshot of the editable fields. Categories are recorded by name for readability. */
function snapshotOf(row: SupplierRow): Record<string, unknown> {
  return {
    name: row.name,
    street: row.street,
    city: row.city,
    stateRegion: row.stateRegion,
    postalCode: row.postalCode,
    country: row.country,
    categories: row.categories.map((link) => link.category.nameEn).sort(),
  };
}

const duplicateName = () => errors.conflict("A supplier with this name already exists.");

async function assertNameAvailable(db: Database | Prisma.TransactionClient, name: string, exceptId?: string) {
  const match = await db.supplier.findUnique({ where: { nameKey: nameKeyOf(name) } });
  if (match && match.id !== exceptId) {
    throw duplicateName();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === PRISMA_UNIQUE_VIOLATION;
}

export async function listSuppliers(db: Database, request: AuditRequestContext, filters: ListSuppliersFilters) {
  const where: Prisma.SupplierWhereInput = {
    name: filters.q ? { contains: filters.q, mode: "insensitive" } : undefined,
    OR:
      filters.categoryIds.length > 0
        ? [
            { categories: { some: { categoryId: { in: filters.categoryIds } } } },
            { products: { some: { categories: { some: { categoryId: { in: filters.categoryIds } } } } } },
          ]
        : undefined,
  };

  const [total, rows] = await db.$transaction([
    db.supplier.count({ where }),
    db.supplier.findMany({
      where,
      include: detailInclude,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
  ]);

  const inherited = await inheritedCategoriesBySupplier(db, rows.map((row) => row.id));
  await recordAudit(db, request, { action: AuditAction.SUPPLIER_LIST, outcome: "success" });
  return {
    items: rows.map((row) => toSupplierDto(row, inherited.get(row.id))),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

export async function getSupplier(db: Database, request: AuditRequestContext, id: string): Promise<SupplierDto> {
  const row = await db.supplier.findUnique({ where: { id }, include: detailInclude });
  if (!row) throw errors.notFound("Supplier");
  const inherited = await inheritedCategoriesBySupplier(db, [id]);

  await recordAudit(db, request, {
    action: AuditAction.SUPPLIER_VIEW,
    outcome: "success",
    entityType: "Supplier",
    entityId: id,
  });
  return toSupplierDto(row, inherited.get(id));
}

export async function createSupplier(
  db: Database,
  request: AuditRequestContext,
  input: SupplierInput,
): Promise<SupplierDto> {
  await assertNameAvailable(db, input.name);
  try {
    return await db.$transaction(async (tx) => {
      const categoryIds = await resolveCategoryIds(tx, request, input.categories ?? []);
      const row = await tx.supplier.create({
        data: {
          name: input.name.trim(),
          nameKey: nameKeyOf(input.name),
          street: input.street ?? null,
          city: input.city ?? null,
          stateRegion: input.stateRegion ?? null,
          postalCode: input.postalCode ?? null,
          country: input.country ?? null,
          createdById: request.actor.userId,
          categories: { create: categoryIds.map((categoryId) => ({ categoryId })) },
        },
        include: detailInclude,
      });

      await recordAudit(tx, request, {
        action: AuditAction.SUPPLIER_CREATE,
        outcome: "success",
        entityType: "Supplier",
        entityId: row.id,
        changes: diffFields({}, snapshotOf(row)),
      });
      return toSupplierDto(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateName();
    throw error;
  }
}

/**
 * Full update of the editable fields. Address fields that are omitted are cleared.
 * Categories are replaced only when provided.
 */
export async function updateSupplier(
  db: Database,
  request: AuditRequestContext,
  id: string,
  input: SupplierInput,
): Promise<SupplierDto> {
  await assertNameAvailable(db, input.name, id);
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.supplier.findUnique({ where: { id }, include: detailInclude });
      if (!existing) throw errors.notFound("Supplier");

      if (input.categories !== undefined) {
        const categoryIds = await resolveCategoryIds(tx, request, input.categories);
        await tx.supplierCategory.deleteMany({ where: { supplierId: id } });
        await tx.supplierCategory.createMany({
          data: categoryIds.map((categoryId) => ({ supplierId: id, categoryId })),
        });
      }

      const row = await tx.supplier.update({
        where: { id },
        data: {
          name: input.name.trim(),
          nameKey: nameKeyOf(input.name),
          street: input.street ?? null,
          city: input.city ?? null,
          stateRegion: input.stateRegion ?? null,
          postalCode: input.postalCode ?? null,
          country: input.country ?? null,
        },
        include: detailInclude,
      });

      const changes = diffFields(snapshotOf(existing), snapshotOf(row));
      if (changes) {
        await recordAudit(tx, request, {
          action: AuditAction.SUPPLIER_UPDATE,
          outcome: "success",
          entityType: "Supplier",
          entityId: id,
          changes,
        });
      }
      const inherited = await inheritedCategoriesBySupplier(tx, [id]);
      return toSupplierDto(row, inherited.get(id));
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateName();
    throw error;
  }
}

/**
 * Deletes the supplier and its assets; catalogs are retained and unassigned.
 * Blocked while the supplier has products (FR-SUP-05, SPEC §8.3).
 */
export async function deleteSupplier(
  db: Database,
  storage: AssetStorage,
  log: FastifyBaseLogger,
  request: AuditRequestContext,
  id: string,
): Promise<void> {
  const storageKeys = await db.$transaction(async (tx) => {
    const existing = await tx.supplier.findUnique({
      where: { id },
      include: {
        assets: { select: { storageKey: true } },
        catalogs: { select: { id: true } },
      },
    });
    if (!existing) throw errors.notFound("Supplier");

    const productCount = await tx.product.count({ where: { supplierId: id } });
    if (productCount > 0) {
      throw errors.conflict(
        `This supplier has ${productCount} product(s). Delete or reassign them before deleting the supplier.`,
      );
    }

    for (const catalog of existing.catalogs) {
      await recordAudit(tx, request, {
        action: AuditAction.CATALOG_UPDATE,
        outcome: "success",
        entityType: "Catalog",
        entityId: catalog.id,
        changes: diffFields({ supplierId: id }, { supplierId: null }),
      });
    }
    await tx.supplier.delete({ where: { id } });
    await recordAudit(tx, request, {
      action: AuditAction.SUPPLIER_DELETE,
      outcome: "success",
      entityType: "Supplier",
      entityId: id,
      changes: diffFields({ name: existing.name }, { name: null }),
    });
    return existing.assets.map((file) => file.storageKey);
  });

  await removeStoredFiles(storage, storageKeys, log);
}

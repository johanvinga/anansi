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

export type SupplierDto = ReturnType<typeof toSupplierDto>;

function toSupplierDto(row: SupplierRow) {
  return {
    id: row.id,
    name: row.name,
    street: row.street,
    city: row.city,
    stateRegion: row.stateRegion,
    postalCode: row.postalCode,
    country: row.country,
    categories: row.categories
      .map((link) => ({ id: link.category.id, name: link.category.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
    categories: row.categories.map((link) => link.category.name).sort(),
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
    categories:
      filters.categoryIds.length > 0
        ? { some: { categoryId: { in: filters.categoryIds } } }
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

  await recordAudit(db, request, { action: AuditAction.SUPPLIER_LIST, outcome: "success" });
  return { items: rows.map(toSupplierDto), total, page: filters.page, pageSize: filters.pageSize };
}

export async function getSupplier(db: Database, request: AuditRequestContext, id: string): Promise<SupplierDto> {
  const row = await db.supplier.findUnique({ where: { id }, include: detailInclude });
  if (!row) throw errors.notFound("Supplier");

  await recordAudit(db, request, {
    action: AuditAction.SUPPLIER_VIEW,
    outcome: "success",
    entityType: "Supplier",
    entityId: id,
  });
  return toSupplierDto(row);
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
      return toSupplierDto(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateName();
    throw error;
  }
}

/** Deletes the supplier, its asset rows (cascade), and then the stored files (SPEC §8.3). */
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
      include: { assets: { select: { storageKey: true } } },
    });
    if (!existing) throw errors.notFound("Supplier");

    await tx.supplier.delete({ where: { id } });
    await recordAudit(tx, request, {
      action: AuditAction.SUPPLIER_DELETE,
      outcome: "success",
      entityType: "Supplier",
      entityId: id,
      changes: diffFields({ name: existing.name }, { name: null }),
    });
    return existing.assets.map((asset) => asset.storageKey);
  });

  await removeStoredFiles(storage, storageKeys, log);
}

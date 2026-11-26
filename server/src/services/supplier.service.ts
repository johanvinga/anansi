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
import { resolveTagIds } from "./tag.service.js";
import { listPinnedFirst } from "./pinned-first.js";

export interface SupplierInput {
  name: string;
  street?: string | null | undefined;
  city?: string | null | undefined;
  stateRegion?: string | null | undefined;
  postalCode?: string | null | undefined;
  country?: string | null | undefined;
  website?: string | null | undefined;
  tags?: string[] | undefined;
}

export interface ListSuppliersFilters {
  q?: string | undefined;
  tagIds: string[];
  page: number;
  pageSize: number;
}

const detailInclude = {
  tags: { include: { tag: true } },
} satisfies Prisma.SupplierInclude;

type SupplierRow = Prisma.SupplierGetPayload<{ include: typeof detailInclude }>;
type TagRefDto = { id: string; name: { en: string; fr: string } };

export type SupplierDto = ReturnType<typeof toSupplierDto>;

function toTagRef(tag: { id: string; nameEn: string; nameFr: string }): TagRefDto {
  return { id: tag.id, name: { en: tag.nameEn, fr: tag.nameFr } };
}

function toSupplierDto(row: SupplierRow, derivedTags: TagRefDto[] = []) {
  const assignedTags = row.tags.map((link) => toTagRef(link.tag));
  const effective = new Map([...assignedTags, ...derivedTags].map((tag) => [tag.id, tag]));
  return {
    id: row.id,
    name: row.name,
    street: row.street,
    city: row.city,
    stateRegion: row.stateRegion,
    postalCode: row.postalCode,
    country: row.country,
    website: row.website,
    tags: [...effective.values()].sort((a, b) => a.name.en.localeCompare(b.name.en)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function derivedTagsBySupplier(
  db: Database | Prisma.TransactionClient,
  supplierIds: string[],
): Promise<Map<string, TagRefDto[]>> {
  const tagsBySupplier = new Map<string, Map<string, TagRefDto>>();
  if (supplierIds.length === 0) return new Map();
  const links = await db.productTag.findMany({
    where: { product: { supplierId: { in: supplierIds } } },
    select: {
      product: { select: { supplierId: true } },
      tag: { select: { id: true, nameEn: true, nameFr: true } },
    },
  });
  for (const link of links) {
    let tags = tagsBySupplier.get(link.product.supplierId);
    if (!tags) {
      tags = new Map();
      tagsBySupplier.set(link.product.supplierId, tags);
    }
    tags.set(link.tag.id, toTagRef(link.tag));
  }
  return new Map(
    [...tagsBySupplier].map(([supplierId, tags]) => [
      supplierId,
      [...tags.values()].sort((a, b) => a.name.en.localeCompare(b.name.en)),
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
    website: row.website,
    tags: row.tags.map((link) => link.tag.nameEn).sort(),
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
      filters.tagIds.length > 0
        ? [{ tags: { some: { tagId: { in: filters.tagIds } } } }]
        : undefined,
  };

  const total = await db.supplier.count({ where });
  const { rows, pinnedIds } = await listPinnedFirst(db, request.actor.userId, "supplier", filters, {
    matchingIds: async (ids) =>
      (await db.supplier.findMany({ where: { AND: [where, { id: { in: ids } }] }, select: { id: true } })).map((row) => row.id),
    fetch: (id, window) =>
      db.supplier.findMany({
        where: { AND: [where, { id }] },
        include: detailInclude,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        ...window,
      }),
  });

  const inherited = await derivedTagsBySupplier(db, rows.map((row) => row.id));
  await recordAudit(db, request, { action: AuditAction.SUPPLIER_LIST, outcome: "success" });
  return {
    items: rows.map((row) => ({ ...toSupplierDto(row, inherited.get(row.id)), pinned: pinnedIds.has(row.id) })),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

export async function getSupplier(db: Database, request: AuditRequestContext, id: string): Promise<SupplierDto> {
  const row = await db.supplier.findUnique({ where: { id }, include: detailInclude });
  if (!row) throw errors.notFound("Supplier");
  const inherited = await derivedTagsBySupplier(db, [id]);

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
      const tagIds = await resolveTagIds(tx, request, input.tags ?? []);
      const row = await tx.supplier.create({
        data: {
          name: input.name.trim(),
          nameKey: nameKeyOf(input.name),
          street: input.street ?? null,
          city: input.city ?? null,
          stateRegion: input.stateRegion ?? null,
          postalCode: input.postalCode ?? null,
          country: input.country ?? null,
          website: input.website ?? null,
          createdById: request.actor.userId,
          tags: { create: tagIds.map((tagId) => ({ tagId })) },
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

      if (input.tags !== undefined) {
        const tagIds = await resolveTagIds(tx, request, input.tags);
        await tx.supplierTag.deleteMany({ where: { supplierId: id } });
        await tx.supplierTag.createMany({
          data: tagIds.map((tagId) => ({ supplierId: id, tagId })),
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
          website: input.website ?? null,
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
      const inherited = await derivedTagsBySupplier(tx, [id]);
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
        _count: { select: { contacts: true } },
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
    await tx.pinnedItem.deleteMany({ where: { itemType: "supplier", itemId: id } });
    await tx.sharedItem.deleteMany({ where: { itemType: "supplier", itemId: id } });
    await tx.supplier.delete({ where: { id } });
    await recordAudit(tx, request, {
      action: AuditAction.SUPPLIER_DELETE,
      outcome: "success",
      entityType: "Supplier",
      entityId: id,
      changes: diffFields(
        { name: existing.name, contactCount: existing._count.contacts },
        { name: null, contactCount: 0 },
      ),
    });
    return existing.assets.map((file) => file.storageKey);
  });

  await removeStoredFiles(storage, storageKeys, log);
}

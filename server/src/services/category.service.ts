import type { Prisma } from "../generated/prisma/client.js";
import type { Database } from "../db.js";
import { errors } from "../errors.js";
import { nameKeyOf, PRISMA_UNIQUE_VIOLATION } from "../lib/text.js";
import {
  AuditAction,
  diffFields,
  recordAudit,
  type AuditRequestContext,
} from "./audit.service.js";

export type CategoryInput = { id: string } | { name: string };

export interface CategoryDto {
  id: string;
  name: string;
  createdAt: string;
}

function toCategoryDto(row: { id: string; name: string; createdAt: Date }): CategoryDto {
  return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === PRISMA_UNIQUE_VIOLATION;
}

const categoryConflict = () => errors.conflict("A category with this name already exists.");

export async function listCategories(db: Database, request: AuditRequestContext, q?: string) {
  const rows = await db.category.findMany({
    where: q ? { name: { contains: q, mode: "insensitive" } } : undefined,
    orderBy: { name: "asc" },
    take: 500,
  });
  await recordAudit(db, request, { action: AuditAction.CATEGORY_LIST, outcome: "success" });
  return { items: rows.map(toCategoryDto) };
}

export async function createCategory(
  db: Database,
  request: AuditRequestContext,
  name: string,
): Promise<CategoryDto> {
  const nameKey = nameKeyOf(name);
  if (await db.category.findUnique({ where: { nameKey } })) {
    throw categoryConflict();
  }
  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.category.create({ data: { name: name.trim(), nameKey } });
      await recordAudit(tx, request, {
        action: AuditAction.CATEGORY_CREATE,
        outcome: "success",
        entityType: "Category",
        entityId: row.id,
        changes: diffFields({}, { name: row.name }),
      });
      return toCategoryDto(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw categoryConflict();
    throw error;
  }
}

export async function renameCategory(
  db: Database,
  request: AuditRequestContext,
  id: string,
  name: string,
): Promise<CategoryDto> {
  const nameKey = nameKeyOf(name);
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.category.findUnique({ where: { id } });
      if (!existing) throw errors.notFound("Category");

      const updated = await tx.category.update({
        where: { id },
        data: { name: name.trim(), nameKey },
      });
      const changes = diffFields({ name: existing.name }, { name: updated.name });
      if (changes) {
        await recordAudit(tx, request, {
          action: AuditAction.CATEGORY_UPDATE,
          outcome: "success",
          entityType: "Category",
          entityId: id,
          changes,
        });
      }
      return toCategoryDto(updated);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw categoryConflict();
    throw error;
  }
}

export async function deleteCategory(db: Database, request: AuditRequestContext, id: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const existing = await tx.category.findUnique({ where: { id } });
    if (!existing) throw errors.notFound("Category");

    // Supplier links are removed by the database cascade; suppliers are kept (FR-CAT-04).
    await tx.category.delete({ where: { id } });
    await recordAudit(tx, request, {
      action: AuditAction.CATEGORY_DELETE,
      outcome: "success",
      entityType: "Category",
      entityId: id,
      changes: diffFields({ name: existing.name }, { name: null }),
    });
  });
}

/**
 * Resolves category inputs to IDs. Names that do not exist yet are created inline (FR-CAT-06).
 * Must be called inside the caller's transaction.
 */
export async function resolveCategoryIds(
  tx: Prisma.TransactionClient,
  request: AuditRequestContext,
  inputs: CategoryInput[],
): Promise<string[]> {
  const ids = new Set<string>();
  for (const input of inputs) {
    if ("id" in input) {
      const existing = await tx.category.findUnique({ where: { id: input.id } });
      if (!existing) {
        throw errors.validation([{ field: "categories", message: `Category ${input.id} does not exist.` }]);
      }
      ids.add(existing.id);
      continue;
    }

    const nameKey = nameKeyOf(input.name);
    const found = await tx.category.findUnique({ where: { nameKey } });
    if (found) {
      ids.add(found.id);
      continue;
    }
    const created = await tx.category.create({ data: { name: input.name.trim(), nameKey } });
    await recordAudit(tx, request, {
      action: AuditAction.CATEGORY_CREATE,
      outcome: "success",
      entityType: "Category",
      entityId: created.id,
      changes: diffFields({}, { name: created.name }),
    });
    ids.add(created.id);
  }
  return [...ids];
}

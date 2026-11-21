import type { Category, Prisma } from "../generated/prisma/client.js";
import { createHash } from "node:crypto";
import type { Database } from "../db.js";
import { errors } from "../errors.js";
import { nameKeyOf, PRISMA_UNIQUE_VIOLATION } from "../lib/text.js";
import type { Translated } from "../lib/translations.js";
import { AuditAction, diffFields, recordAudit, type AuditRequestContext } from "./audit.service.js";

type Tx = Prisma.TransactionClient;
export type CategoryInput = { id: string } | { name: string; parentId?: string | null };
export interface CategoryPathInput {
  path: { name: Translated }[];
}
export interface CategoryDto {
  id: string;
  name: Translated;
  parentId: string | null;
  path: { id: string; name: Translated }[];
  createdAt: string;
}

function snapshot(row: Category): Record<string, unknown> {
  return { "name.en": row.nameEn, "name.fr": row.nameFr, parentId: row.parentId };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === PRISMA_UNIQUE_VIOLATION;
}

const categoryConflict = () => errors.conflict("A category with this name already exists under the selected parent.");

export async function expandCategoryIds(db: Database, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db.category.findMany({ select: { id: true, parentId: true } });
  const children = new Map<string, string[]>();
  for (const row of rows) {
    if (row.parentId) children.set(row.parentId, [...(children.get(row.parentId) ?? []), row.id]);
  }
  const result = new Set(ids);
  const pending = [...ids];
  while (pending.length) {
    for (const child of children.get(pending.pop()!) ?? []) {
      if (!result.has(child)) { result.add(child); pending.push(child); }
    }
  }
  return [...result];
}

export async function lockCategoryTree(tx: Tx) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(53190, 1)::text`;
}

function toCategoryDto(row: Category, byId: Map<string, Category>): CategoryDto {
  const path: CategoryDto["path"] = [];
  const visited = new Set<string>();
  let node: Category | undefined = row;
  while (node) {
    if (visited.has(node.id)) throw errors.conflict("The category hierarchy contains a cycle.");
    visited.add(node.id);
    path.unshift({ id: node.id, name: { en: node.nameEn, fr: node.nameFr } });
    if (node.parentId && !byId.has(node.parentId)) throw errors.conflict("The category hierarchy contains a missing parent.");
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return { id: row.id, name: { en: row.nameEn, fr: row.nameFr }, parentId: row.parentId, path, createdAt: row.createdAt.toISOString() };
}

export async function categoryTreeSnapshot(db: Database | Tx) {
  const rows = await db.category.findMany({ orderBy: { id: "asc" } });
  const version = createHash("sha256").update(JSON.stringify(rows.map((row) =>
    [row.id, row.parentId, row.nameEn, row.nameFr]))).digest("hex");
  const byId = new Map(rows.map((row) => [row.id, row]));
  return { version, categories: rows.map((row) => toCategoryDto(row, byId)) };
}

export async function createCategoryInTransaction(tx: Tx, request: AuditRequestContext, name: Translated, parentId: string | null) {
  await lockCategoryTree(tx);
  const nameKey = nameKeyOf(name.en);
  await validateParent(tx, null, parentId);
  await assertSiblingAvailable(tx, parentId, nameKey);
  const row = await tx.category.create({ data: { nameEn: name.en.trim(), nameFr: name.fr.trim(), nameKey, parentId } });
  await recordAudit(tx, request, { action: AuditAction.CATEGORY_CREATE, outcome: "success", entityType: "Category", entityId: row.id, changes: diffFields({}, snapshot(row)) });
  return row;
}

async function dto(tx: Tx, row: Category): Promise<CategoryDto> {
  const all = await tx.category.findMany();
  return toCategoryDto(row, new Map(all.map((category) => [category.id, category])));
}

async function validateParent(tx: Tx, id: string | null, parentId: string | null) {
  if (!parentId) return;
  const seen = new Set<string>();
  let current: string | null = parentId;
  while (current) {
    if (current === id || seen.has(current)) throw errors.conflict("A category cannot be moved into its own subtree.");
    seen.add(current);
    const parent: { parentId: string | null } | null = await tx.category.findUnique({ where: { id: current }, select: { parentId: true } });
    if (!parent) throw errors.validation([{ field: "parentId", message: "Parent category does not exist." }]);
    current = parent.parentId;
  }
}

async function assertSiblingAvailable(tx: Tx, parentId: string | null, nameKey: string, exceptId?: string) {
  const sibling = await tx.category.findFirst({ where: { parentId, nameKey, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  if (sibling) throw categoryConflict();
}

export async function listCategories(db: Database, request: AuditRequestContext, q?: string) {
  const rows = await db.category.findMany({ orderBy: [{ nameEn: "asc" }, { id: "asc" }] });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const needle = q?.toLocaleLowerCase();
  const selected = needle ? rows.filter((row) => row.nameEn.toLocaleLowerCase().includes(needle) || row.nameFr.toLocaleLowerCase().includes(needle)) : rows;
  await recordAudit(db, request, { action: AuditAction.CATEGORY_LIST, outcome: "success" });
  return { items: selected.map((row) => toCategoryDto(row, byId)) };
}

export async function createCategory(db: Database, request: AuditRequestContext, name: Translated, parentId?: string | null): Promise<CategoryDto> {
  try {
    return await db.$transaction(async (tx) => {
      const parent = parentId ?? null;
      const row = await createCategoryInTransaction(tx, request, name, parent);
      return dto(tx, row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw categoryConflict();
    throw error;
  }
}

export async function renameCategory(db: Database, request: AuditRequestContext, id: string, name: Translated | undefined, parentId?: string | null): Promise<CategoryDto> {
  try {
    return await db.$transaction(async (tx) => {
      await lockCategoryTree(tx);
      const existing = await tx.category.findUnique({ where: { id } });
      if (!existing) throw errors.notFound("Category");
      const parent = parentId === undefined ? existing.parentId : parentId;
      const nameKey = name === undefined ? existing.nameKey : nameKeyOf(name.en);
      await validateParent(tx, id, parent);
      await assertSiblingAvailable(tx, parent, nameKey, id);
      const updated = await tx.category.update({ where: { id }, data: {
        nameEn: name?.en.trim() ?? existing.nameEn, nameFr: name?.fr.trim() ?? existing.nameFr, nameKey, parentId: parent,
      } });
      const changes = diffFields(snapshot(existing), snapshot(updated));
      if (changes) await recordAudit(tx, request, { action: AuditAction.CATEGORY_UPDATE, outcome: "success", entityType: "Category", entityId: id, changes });
      return dto(tx, updated);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw categoryConflict();
    throw error;
  }
}

export async function getCategoryDeletionImpact(db: Database, request: AuditRequestContext, id: string) {
  const category = await db.category.findUnique({ where: { id } });
  if (!category) throw errors.notFound("Category");
  const [products, uncategorizedProducts, suppliers, catalogs, children] = await Promise.all([
    db.productCategory.count({ where: { categoryId: id } }),
    db.product.count({ where: { categories: { some: { categoryId: id }, every: { categoryId: id } } } }),
    db.supplierCategory.count({ where: { categoryId: id } }),
    db.catalogCategory.count({ where: { categoryId: id } }),
    db.category.count({ where: { parentId: id } }),
  ]);
  await recordAudit(db, request, { action: AuditAction.CATEGORY_LIST, outcome: "success", entityType: "Category", entityId: id });
  return { products, uncategorizedProducts, suppliers, catalogs, children };
}

export async function deleteCategory(db: Database, request: AuditRequestContext, id: string): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      await lockCategoryTree(tx);
      const existing = await tx.category.findUnique({ where: { id } });
      if (!existing) throw errors.notFound("Category");
      const children = await tx.category.findMany({ where: { parentId: id } });
      for (const child of children) {
        const conflict = await tx.category.findFirst({ where: { parentId: existing.parentId, nameKey: child.nameKey, id: { not: id } } });
        if (conflict) throw errors.conflict(`Cannot move "${child.nameEn}": a category with that name already exists under the destination. Rename or move one of them before deleting.`);
      }
      for (const child of children) {
        await tx.category.update({ where: { id: child.id }, data: { parentId: existing.parentId } });
        await recordAudit(tx, request, { action: AuditAction.CATEGORY_UPDATE, outcome: "success", entityType: "Category", entityId: child.id,
          changes: diffFields(snapshot(child), { ...snapshot(child), parentId: existing.parentId }) });
      }
      await tx.category.delete({ where: { id } });
      await recordAudit(tx, request, { action: AuditAction.CATEGORY_DELETE, outcome: "success", entityType: "Category", entityId: id, changes: diffFields(snapshot(existing), {}) });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw categoryConflict();
    throw error;
  }
}

/** Resolves direct category assignments in the caller's transaction. */
export async function resolveCategoryIds(tx: Tx, request: AuditRequestContext, inputs: CategoryInput[]): Promise<string[]> {
  if (inputs.length) await lockCategoryTree(tx);
  const ids = new Set<string>();
  for (const input of inputs) {
    if ("id" in input) {
      const existing = await tx.category.findUnique({ where: { id: input.id } });
      if (!existing) throw errors.validation([{ field: "categories", message: `Category ${input.id} does not exist.` }]);
      ids.add(existing.id);
      continue;
    }
    if (input.parentId !== undefined) {
      if (input.parentId && !(await tx.category.findUnique({ where: { id: input.parentId }, select: { id: true } }))) {
        throw errors.validation([{ field: "categories", message: "Parent category does not exist." }]);
      }
      const created = await createCategoryInTransaction(tx, request, { en: input.name, fr: input.name }, input.parentId);
      ids.add(created.id);
      continue;
    }
    const nameKey = nameKeyOf(input.name);
    const matches = await tx.category.findMany({ where: { nameKey }, take: 2 });
    if (matches.length > 1) throw errors.validation([{ field: "categories", message: `Category "${input.name}" is ambiguous. Select a category by its full path.` }]);
    if (matches[0]) {
      ids.add(matches[0].id);
      continue;
    }
    const created = await tx.category.create({ data: { nameEn: input.name.trim(), nameFr: input.name.trim(), nameKey } });
    await recordAudit(tx, request, { action: AuditAction.CATEGORY_CREATE, outcome: "success", entityType: "Category", entityId: created.id, changes: diffFields({}, snapshot(created)) });
    ids.add(created.id);
  }
  return [...ids];
}

/** Resolves Gemini's root-to-leaf paths, reusing existing siblings before adding missing nodes. */
export async function resolveCategoryPaths(
  tx: Tx,
  request: AuditRequestContext,
  inputs: CategoryPathInput[],
): Promise<string[]> {
  if (inputs.length) await lockCategoryTree(tx);
  const ids = new Set<string>();
  for (const input of inputs) {
    if (!input.path.length) continue;
    let parentId: string | null = null;
    for (const node of input.path) {
      const nameKey = nameKeyOf(node.name.en);
      const existing: { id: string } | null = await tx.category.findFirst({
        where: { parentId, nameKey },
        select: { id: true },
      });
      if (existing) {
        parentId = existing.id;
        continue;
      }
      const created = await createCategoryInTransaction(tx, request, node.name, parentId);
      parentId = created.id;
    }
    if (parentId) ids.add(parentId);
  }
  return [...ids];
}

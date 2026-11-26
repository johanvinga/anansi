import type { Prisma } from "../generated/prisma/client.js";
import type { Database } from "../db.js";
import { errors } from "../errors.js";
import { listResponse, optionalSkipTake, type PageRequest } from "../lib/pagination.js";
import { nameKeyOf } from "../lib/text.js";
import { AuditAction, diffFields, recordAudit, type AuditRequestContext } from "./audit.service.js";

export interface TagInput {
  name: { en: string; fr: string };
}

export interface TagDto {
  id: string;
  name: { en: string; fr: string };
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

function toDto(tag: { id: string; nameEn: string; nameFr: string; isArchived: boolean; createdAt: Date; updatedAt: Date }): TagDto {
  return {
    id: tag.id,
    name: { en: tag.nameEn, fr: tag.nameFr },
    isArchived: tag.isArchived,
    createdAt: tag.createdAt.toISOString(),
    updatedAt: tag.updatedAt.toISOString(),
  };
}

export async function listTags(
  db: Database,
  request: AuditRequestContext,
  includeArchived = false,
  pageRequest: PageRequest | null = null,
) {
  const where = includeArchived ? undefined : { isArchived: false };
  const [total, tags] = await db.$transaction([
    db.tag.count({ where }),
    db.tag.findMany({ where, orderBy: [{ nameEn: "asc" }, { id: "asc" }], ...optionalSkipTake(pageRequest) }),
  ]);
  await recordAudit(db, request, { action: AuditAction.CATEGORY_LIST, outcome: "success", entityType: "Tag" });
  return listResponse(tags.map(toDto), total, pageRequest);
}

export async function createTag(db: Database, request: AuditRequestContext, input: TagInput): Promise<TagDto> {
  const nameEn = input.name.en.trim();
  const nameFr = input.name.fr.trim();
  if (!nameEn || !nameFr) throw errors.validation([{ field: "name", message: "English and French names are required." }]);
  const nameKey = nameKeyOf(nameEn);
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.tag.findUnique({ where: { nameKey } });
      if (existing) throw errors.conflict("A tag with this name already exists.");
      const tag = await tx.tag.create({ data: { nameEn, nameFr, nameKey } });
      await recordAudit(tx, request, {
        action: AuditAction.CATEGORY_CREATE,
        outcome: "success",
        entityType: "Tag",
        entityId: tag.id,
        changes: diffFields({}, { "name.en": nameEn, "name.fr": nameFr }),
      });
      return toDto(tag);
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "P2002") throw errors.conflict("A tag with this name already exists.");
    throw error;
  }
}

export async function resolveTagIds(tx: Prisma.TransactionClient, request: AuditRequestContext, tagIds: string[]): Promise<string[]> {
  const ids = [...new Set(tagIds)];
  if (ids.length === 0) return [];
  const tags = await tx.tag.findMany({ where: { id: { in: ids }, isArchived: false }, select: { id: true } });
  if (tags.length !== ids.length) throw errors.validation([{ field: "tags", message: "One or more tags do not exist or are archived." }]);
  return ids;
}

export async function syncSupplierTags(db: Database | Prisma.TransactionClient, supplierId: string): Promise<void> {
  const productTags = await db.productTag.findMany({
    where: { product: { supplierId } },
    select: { tagId: true },
  });
  const tagIds = [...new Set(productTags.map((link) => link.tagId))];
  await db.supplierTag.deleteMany({ where: { supplierId } });
  if (tagIds.length) {
    await db.supplierTag.createMany({
      data: tagIds.map((tagId) => ({ supplierId, tagId })),
      skipDuplicates: true,
    });
  }
}

export async function renameTag(
  db: Database,
  request: AuditRequestContext,
  id: string,
  name: { en: string; fr: string },
): Promise<TagDto> {
  return db.$transaction(async (tx) => {
    const existing = await tx.tag.findUnique({ where: { id } });
    if (!existing) throw errors.notFound("Tag");
    const nameKey = nameKeyOf(name.en);
    const conflict = await tx.tag.findFirst({ where: { nameKey, id: { not: id } } });
    if (conflict) throw errors.conflict("A tag with this name already exists.");
    const updated = await tx.tag.update({
      where: { id },
      data: { nameEn: name.en.trim(), nameFr: name.fr.trim(), nameKey },
    });
    await recordAudit(tx, request, {
      action: AuditAction.CATEGORY_UPDATE,
      outcome: "success",
      entityType: "Tag",
      entityId: id,
      changes: diffFields(
        { "name.en": existing.nameEn, "name.fr": existing.nameFr },
        { "name.en": updated.nameEn, "name.fr": updated.nameFr },
      ),
    });
    return toDto(updated);
  });
}

export async function archiveTag(
  db: Database,
  request: AuditRequestContext,
  id: string,
  isArchived: boolean,
): Promise<TagDto> {
  return db.$transaction(async (tx) => {
    const existing = await tx.tag.findUnique({ where: { id } });
    if (!existing) throw errors.notFound("Tag");
    const updated = await tx.tag.update({ where: { id }, data: { isArchived } });
    await recordAudit(tx, request, {
      action: isArchived ? AuditAction.CATEGORY_DELETE : AuditAction.CATEGORY_UPDATE,
      outcome: "success",
      entityType: "Tag",
      entityId: id,
      changes: diffFields({ isArchived: existing.isArchived }, { isArchived: updated.isArchived }),
    });
    return toDto(updated);
  });
}

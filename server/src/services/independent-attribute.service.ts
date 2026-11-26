import { randomUUID } from "node:crypto";
import type { Database } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { errors } from "../errors.js";
import { listResponse, optionalSkipTake, type PageRequest } from "../lib/pagination.js";
import { PRISMA_UNIQUE_VIOLATION } from "../lib/text.js";
import type { Translated } from "../lib/translations.js";
import { AuditAction, diffFields, recordAudit, type AuditRequestContext } from "./audit.service.js";
import type { CreateFieldInput } from "./attribute-set.service.js";
import { normalizeOptionLabels } from "./attribute-option-labels.js";
import { assertUniqueIndependentName } from "./independent-attribute-names.js";

export async function listIndependentAttributes(
  db: Database,
  request: AuditRequestContext,
  filters: { q?: string | undefined; page?: PageRequest | null } = {},
) {
  const pageRequest = filters.page ?? null;
  const where: Prisma.AttributeFieldWhereInput = {
    attributeSetId: null,
    isArchived: false,
    ...(filters.q
      ? {
          OR: [
            { nameEn: { contains: filters.q, mode: "insensitive" } },
            { nameFr: { contains: filters.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [total, rows] = await db.$transaction([
    db.attributeField.count({ where }),
    db.attributeField.findMany({
      where,
      orderBy: [{ nameEn: "asc" }, { id: "asc" }],
      include: { options: { orderBy: { sortOrder: "asc" } }, _count: { select: { values: true } } },
      ...optionalSkipTake(pageRequest),
    }),
  ]);
  await recordAudit(db, request, { action: AuditAction.ATTRIBUTE_FIELD_LIST, outcome: "success" });
  return listResponse(
    rows.map((row) => ({
      id: row.id, name: { en: row.nameEn, fr: row.nameFr }, code: row.code,
      dataType: row.dataType, unit: row.unit, isRequired: false, isArchived: row.isArchived, sortOrder: row.sortOrder,
      options: row.options.map((option) => ({ id: option.id, label: { en: option.labelEn, fr: option.labelFr }, sortOrder: option.sortOrder })),
      hasValues: row._count.values > 0,
    })),
    total,
    pageRequest,
  );
}

export async function createIndependentAttribute(db: Database, request: AuditRequestContext, input: CreateFieldInput) {
  try {
    return await db.$transaction(async (tx) => createIndependentAttributeInTransaction(tx, request, input.name, input));
  } catch (error) {
    if ((error as { code?: string } | null)?.code === PRISMA_UNIQUE_VIOLATION) {
      throw errors.conflict("An independent attribute with this name already exists.");
    }
    throw error;
  }
}

export async function createIndependentAttributeInTransaction(
  tx: Prisma.TransactionClient, request: AuditRequestContext, name: Translated,
  input: Omit<CreateFieldInput, "name"> = { dataType: "text" },
) {
      await assertUniqueIndependentName(tx, name.en);
      const options = normalizeOptionLabels(input.options ?? [], input.dataType);
      const id = randomUUID();
      const field = await tx.attributeField.create({
        data: {
          id, attributeSetId: null, nameEn: name.en.trim(), nameFr: name.fr.trim(),
          code: `independent_${id.replace(/-/g, "")}`, dataType: input.dataType, unit: input.unit?.trim() || null, sortOrder: 0,
          options: { create: options.map((option, index) => ({ labelEn: option.en, labelFr: option.fr, sortOrder: index + 1 })) },
        },
        include: { options: { orderBy: { sortOrder: "asc" } } },
      });
      await recordAudit(tx, request, {
        action: AuditAction.ATTRIBUTE_FIELD_CREATE, outcome: "success",
        entityType: "AttributeField", entityId: id,
        changes: diffFields({}, { "name.en": field.nameEn, "name.fr": field.nameFr, dataType: field.dataType, unit: field.unit, options }),
      });
      return { id: field.id, name: { en: field.nameEn, fr: field.nameFr }, code: field.code, dataType: field.dataType, unit: field.unit,
        options: field.options.map((option) => ({ id: option.id, label: { en: option.labelEn, fr: option.labelFr }, sortOrder: option.sortOrder })) };
}

export async function renameIndependentAttribute(db: Database, request: AuditRequestContext, id: string, name: Translated) {
  try {
    return await db.$transaction(async (tx) => {
      await assertUniqueIndependentName(tx, name.en, id);
      await tx.$queryRaw`SELECT id FROM attribute_fields WHERE id = ${id}::uuid FOR UPDATE`;
      const field = await tx.attributeField.findFirst({ where: { id, attributeSetId: null } });
      if (!field) throw errors.notFound("Attribute");
      if (field.isArchived) throw errors.conflict("Archived attributes cannot be edited.");
      const updated = await tx.attributeField.update({
        where: { id },
        data: { nameEn: name.en.trim(), nameFr: name.fr.trim() },
      });
      const changes = diffFields(
        { "name.en": field.nameEn, "name.fr": field.nameFr },
        { "name.en": updated.nameEn, "name.fr": updated.nameFr },
      );
      if (changes) await recordAudit(tx, request, {
        action: AuditAction.ATTRIBUTE_FIELD_UPDATE, outcome: "success",
        entityType: "AttributeField", entityId: id, changes,
      });
      return { id, name: { en: updated.nameEn, fr: updated.nameFr }, code: updated.code, dataType: updated.dataType, unit: updated.unit };
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === PRISMA_UNIQUE_VIOLATION) {
      throw errors.conflict("An independent attribute with this name already exists.");
    }
    throw error;
  }
}

export async function removeIndependentAttribute(db: Database, request: AuditRequestContext, id: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM attribute_fields WHERE id = ${id}::uuid FOR UPDATE`;
    const field = await tx.attributeField.findFirst({
      where: { id, attributeSetId: null },
      include: { _count: { select: { values: true } } },
    });
    if (!field) throw errors.notFound("Attribute");
    if (field.isArchived) throw errors.conflict("The attribute is already archived.");
    if (await tx.attributeSetField.count({ where: { attributeFieldId: id } })) {
      throw errors.conflict("Remove this attribute from its attribute sets before removing it.");
    }
    if (field._count.values > 0) {
      await tx.attributeField.update({ where: { id }, data: { isArchived: true } });
      await recordAudit(tx, request, {
        action: AuditAction.ATTRIBUTE_FIELD_ARCHIVE, outcome: "success", entityType: "AttributeField", entityId: id,
        changes: diffFields({ isArchived: false }, { isArchived: true }),
      });
      return { result: "archived" as const };
    }
    await tx.attributeField.delete({ where: { id } });
    await recordAudit(tx, request, {
      action: AuditAction.ATTRIBUTE_FIELD_DELETE, outcome: "success", entityType: "AttributeField", entityId: id,
      changes: diffFields({ "name.en": field.nameEn, "name.fr": field.nameFr }, { "name.en": null, "name.fr": null }),
    });
    return { result: "deleted" as const };
  });
}

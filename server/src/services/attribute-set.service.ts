import type { Prisma } from "../generated/prisma/client.js";
import type { Database } from "../db.js";
import { AppError, errors } from "../errors.js";
import { nameKeyOf, PRISMA_UNIQUE_VIOLATION } from "../lib/text.js";
import type { Translated } from "../lib/translations.js";
import { generateFieldCode, type AttributeDataType, type FieldDefinition } from "./attribute-values.js";
import { assertUniqueIndependentName } from "./independent-attribute-names.js";
import { normalizeAttributeName } from "./catalog-attribute-matching.js";
import { normalizeOptionLabels } from "./attribute-option-labels.js";
import { createIndependentAttributeInTransaction } from "./independent-attribute.service.js";
import {
  AuditAction,
  diffFields,
  recordAudit,
  type AuditRequestContext,
} from "./audit.service.js";

type Tx = Prisma.TransactionClient;

export interface CreateFieldInput {
  name: Translated;
  dataType: AttributeDataType;
  unit?: string | null | undefined;
  isRequired?: boolean | undefined;
  options?: Translated[] | undefined;
}

export interface UpdateFieldInput {
  name?: Translated | undefined;
  dataType?: AttributeDataType | undefined;
  unit?: string | null | undefined;
  isRequired?: boolean | undefined;
  sortOrder?: number | undefined;
  /** Full option list. Entries with an id are kept (and may be renamed); others are created. */
  options?: { id?: string | undefined; label: Translated }[] | undefined;
}

const detailInclude = {
  fields: {
    orderBy: [{ sortOrder: "asc" }, { nameEn: "asc" }],
    include: {
      options: { orderBy: { sortOrder: "asc" } },
      _count: { select: { values: true } },
    },
  },
  sharedFields: {
    include: { field: { include: { options: { orderBy: { sortOrder: "asc" } }, _count: { select: { values: true } } } } },
  },
} satisfies Prisma.AttributeSetInclude;

type SetRow = Prisma.AttributeSetGetPayload<{ include: typeof detailInclude }>;
type FieldRow = SetRow["fields"][number];

export type AttributeFieldDto = ReturnType<typeof toFieldDto>;
export type AttributeSetDetailDto = ReturnType<typeof toSetDetail>;

function toFieldDto(field: FieldRow) {
  return {
    id: field.id,
    name: { en: field.nameEn, fr: field.nameFr },
    code: field.code,
    dataType: field.dataType as AttributeDataType,
    unit: field.unit,
    isRequired: field.isRequired,
    isArchived: field.isArchived,
    sortOrder: field.sortOrder,
    options: field.options.map((o) => ({
      id: o.id,
      label: { en: o.labelEn, fr: o.labelFr },
      sortOrder: o.sortOrder,
    })),
    /** When true, the data type is locked (FR-ATS-07) and deleting archives the field (FR-ATS-09). */
    hasValues: field._count.values > 0,
  };
}

function toSetDetail(row: SetRow) {
  return {
    id: row.id,
    name: { en: row.nameEn, fr: row.nameFr },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    fields: [
      ...row.fields.map((field) => ({ ...toFieldDto(field), shared: false })),
      ...row.sharedFields.map(({ field, isRequired, isArchived, sortOrder }) => ({
        ...toFieldDto(field), isRequired, isArchived: isArchived || field.isArchived, sortOrder, shared: true,
      })),
    ].sort((a, b) => a.sortOrder - b.sortOrder || a.name.en.localeCompare(b.name.en)),
  };
}

function fieldSnapshot(
  field: { nameEn: string; nameFr: string; dataType: string; unit: string | null; isRequired: boolean; isArchived: boolean; sortOrder: number },
  optionLabels: string[],
) {
  return {
    "name.en": field.nameEn,
    "name.fr": field.nameFr,
    dataType: field.dataType,
    unit: field.unit,
    isRequired: field.isRequired,
    isArchived: field.isArchived,
    sortOrder: field.sortOrder,
    options: optionLabels,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === PRISMA_UNIQUE_VIOLATION;
}

const duplicateSetName = () => errors.conflict("An attribute set with this name already exists.");

async function loadSet(db: Database | Tx, id: string): Promise<SetRow> {
  const row = await db.attributeSet.findUnique({ where: { id }, include: detailInclude });
  if (!row) throw errors.notFound("Attribute set");
  return row;
}

async function loadField(tx: Tx, setId: string, fieldId: string) {
  const field = await tx.attributeField.findFirst({
    where: { id: fieldId, attributeSetId: setId },
    include: { options: { orderBy: { sortOrder: "asc" } }, _count: { select: { values: true } } },
  });
  if (!field) throw errors.notFound("Attribute field");
  return field;
}

/** Field definitions used to validate product attribute values. */
export async function loadFieldDefinitions(db: Database | Tx, setId: string): Promise<(FieldDefinition & { code: string; unit: string | null; sortOrder: number })[]> {
  const fields = await db.attributeField.findMany({
    where: { attributeSetId: setId },
    orderBy: { sortOrder: "asc" },
    include: { options: { orderBy: { sortOrder: "asc" } } },
  });
  const shared = await db.attributeSetField.findMany({
    where: { attributeSetId: setId },
    include: { field: { include: { options: { orderBy: { sortOrder: "asc" } } } } },
  });
  return [...fields.map((f) => ({
    id: f.id,
    name: f.nameEn,
    code: f.code,
    unit: f.unit,
    sortOrder: f.sortOrder,
    dataType: f.dataType as AttributeDataType,
    isRequired: f.isRequired,
    isArchived: f.isArchived,
    options: f.options.map((o) => ({ id: o.id, label: o.labelEn })),
  })), ...shared.map(({ field: f, isRequired, isArchived, sortOrder }) => ({
    id: f.id, name: f.nameEn, code: f.code, unit: f.unit, sortOrder, dataType: f.dataType,
    isRequired, isArchived: isArchived || f.isArchived,
    options: f.options.map((o) => ({ id: o.id, label: o.labelEn })),
  }))].sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function listAttributeSets(db: Database, request: AuditRequestContext) {
  const rows = await db.attributeSet.findMany({
    orderBy: { nameEn: "asc" },
    include: {
      _count: { select: { fields: { where: { isArchived: false } }, sharedFields: { where: { isArchived: false, field: { isArchived: false } } }, products: true } },
    },
  });
  await recordAudit(db, request, { action: AuditAction.ATTRIBUTE_SET_LIST, outcome: "success" });
  return {
    items: rows.map((row) => ({
      id: row.id,
      name: { en: row.nameEn, fr: row.nameFr },
      fieldCount: row._count.fields + row._count.sharedFields,
      productCount: row._count.products,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

export async function getAttributeSet(db: Database, request: AuditRequestContext, id: string) {
  const row = await loadSet(db, id);
  await recordAudit(db, request, {
    action: AuditAction.ATTRIBUTE_SET_VIEW,
    outcome: "success",
    entityType: "AttributeSet",
    entityId: id,
  });
  return toSetDetail(row);
}

async function addFieldInTransaction(
  tx: Tx,
  request: AuditRequestContext,
  setId: string,
  input: CreateFieldInput,
): Promise<void> {
  const labels = normalizeOptionLabels(input.options ?? [], input.dataType);
  const set = await loadSet(tx, setId);
  const code = generateFieldCode(input.name.en, [...set.fields.map((field) => field.code), ...set.sharedFields.map(({ field }) => field.code)]);
  const sortOrder = Math.max(0, ...set.fields.map((field) => field.sortOrder), ...set.sharedFields.map((field) => field.sortOrder)) + 1;
  const field = await tx.attributeField.create({
    data: {
      attributeSetId: setId,
      nameEn: input.name.en.trim(),
      nameFr: input.name.fr.trim(),
      code,
      dataType: input.dataType,
      unit: input.unit?.trim() || null,
      isRequired: input.isRequired ?? false,
      sortOrder,
      options: {
        create: labels.map((label, index) => ({
          labelEn: label.en,
          labelFr: label.fr,
          sortOrder: index + 1,
        })),
      },
    },
  });
  await recordAudit(tx, request, {
    action: AuditAction.ATTRIBUTE_FIELD_CREATE,
    outcome: "success",
    entityType: "AttributeField",
    entityId: field.id,
    changes: diffFields(
      {},
      { attributeSet: set.nameEn, code, ...fieldSnapshot(field, labels.map((label) => label.en)) },
    ),
  });
}

export async function createAttributeSet(
  db: Database,
  request: AuditRequestContext,
  name: Translated,
  fields: CreateFieldInput[] = [],
) {
  const nameKey = nameKeyOf(name.en);
  if (await db.attributeSet.findUnique({ where: { nameKey } })) throw duplicateSetName();
  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.attributeSet.create({
        data: { nameEn: name.en.trim(), nameFr: name.fr.trim(), nameKey },
        include: detailInclude,
      });
      await recordAudit(tx, request, {
        action: AuditAction.ATTRIBUTE_SET_CREATE,
        outcome: "success",
        entityType: "AttributeSet",
        entityId: row.id,
        changes: diffFields({}, { "name.en": row.nameEn, "name.fr": row.nameFr }),
      });
      for (const field of fields) {
        await addFieldInTransaction(tx, request, row.id, field);
      }
      return toSetDetail(await loadSet(tx, row.id));
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateSetName();
    throw error;
  }
}

export async function renameAttributeSet(db: Database, request: AuditRequestContext, id: string, name: Translated) {
  try {
    return await db.$transaction(async (tx) => {
      const existing = await loadSet(tx, id);
      const row = await tx.attributeSet.update({
        where: { id },
        data: { nameEn: name.en.trim(), nameFr: name.fr.trim(), nameKey: nameKeyOf(name.en) },
        include: detailInclude,
      });
      const changes = diffFields(
        { "name.en": existing.nameEn, "name.fr": existing.nameFr },
        { "name.en": row.nameEn, "name.fr": row.nameFr },
      );
      if (changes) {
        await recordAudit(tx, request, {
          action: AuditAction.ATTRIBUTE_SET_UPDATE,
          outcome: "success",
          entityType: "AttributeSet",
          entityId: id,
          changes,
        });
      }
      return toSetDetail(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateSetName();
    throw error;
  }
}

/** Deletion is blocked while any product references the set (FR-ATS-10). */
export async function deleteAttributeSet(db: Database, request: AuditRequestContext, id: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const existing = await loadSet(tx, id);
    const productCount = await tx.product.count({ where: { attributeSetId: id } });
    if (productCount > 0) {
      throw errors.conflict(
        `This attribute set is used by ${productCount} product(s) and cannot be deleted.`,
      );
    }
    await tx.attributeField.deleteMany({ where: { attributeSetId: id } });
    await tx.attributeSet.delete({ where: { id } });
    await recordAudit(tx, request, {
      action: AuditAction.ATTRIBUTE_SET_DELETE,
      outcome: "success",
      entityType: "AttributeSet",
      entityId: id,
      changes: diffFields(
        { "name.en": existing.nameEn, fields: existing.fields.map((f) => f.code) },
        { "name.en": null, fields: null },
      ),
    });
  });
}

export async function addField(db: Database, request: AuditRequestContext, setId: string, input: CreateFieldInput) {
  try {
    return await db.$transaction(async (tx) => {
      await addFieldInTransaction(tx, request, setId, input);
      return toSetDetail(await loadSet(tx, setId));
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw errors.conflict("A field with this code already exists in the set.");
    throw error;
  }
}

export async function addSharedField(db: Database, request: AuditRequestContext, setId: string, fieldId: string, isRequired: boolean) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM attribute_sets WHERE id = ${setId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM attribute_fields WHERE id = ${fieldId}::uuid FOR UPDATE`;
    const set = await loadSet(tx, setId);
    const field = await tx.attributeField.findFirst({ where: { id: fieldId, attributeSetId: null, isArchived: false } });
    if (!field) throw errors.notFound("Active independent attribute");
    if (set.sharedFields.some((item) => item.attributeFieldId === fieldId)) throw errors.conflict("This attribute is already in the set.");
    const sortOrder = Math.max(0, ...set.fields.map((item) => item.sortOrder), ...set.sharedFields.map((item) => item.sortOrder)) + 1;
    await tx.attributeSetField.create({ data: { attributeSetId: setId, attributeFieldId: fieldId, isRequired, sortOrder } });
    await recordAudit(tx, request, {
      action: AuditAction.ATTRIBUTE_FIELD_CREATE, outcome: "success", entityType: "AttributeSet", entityId: setId,
      changes: diffFields({}, { attributeId: fieldId, name: field.nameEn, isRequired, sortOrder }),
    });
    return toSetDetail(await loadSet(tx, setId));
  });
}

export async function createSharedField(db: Database, request: AuditRequestContext, setId: string, input: CreateFieldInput) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM attribute_sets WHERE id = ${setId}::uuid FOR UPDATE`;
    const set = await loadSet(tx, setId);
    const field = await createIndependentAttributeInTransaction(tx, request, input.name, input);
    const sortOrder = Math.max(0, ...set.fields.map((item) => item.sortOrder), ...set.sharedFields.map((item) => item.sortOrder)) + 1;
    await tx.attributeSetField.create({ data: { attributeSetId: setId, attributeFieldId: field.id, isRequired: input.isRequired ?? false, sortOrder } });
    await recordAudit(tx, request, {
      action: AuditAction.ATTRIBUTE_FIELD_CREATE, outcome: "success", entityType: "AttributeSet", entityId: setId,
      changes: diffFields({}, { attributeId: field.id, name: field.name.en, isRequired: input.isRequired ?? false, sortOrder }),
    });
    return toSetDetail(await loadSet(tx, setId));
  });
}

export async function makeFieldShared(db: Database, request: AuditRequestContext, setId: string, fieldId: string, targetId: string | null) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM attribute_sets WHERE id = ${setId}::uuid FOR UPDATE`;
    for (const id of [...new Set([fieldId, ...(targetId ? [targetId] : [])])].sort()) {
      await tx.$queryRaw`SELECT id FROM attribute_fields WHERE id = ${id}::uuid FOR UPDATE`;
    }
    const source = await loadField(tx, setId, fieldId);
    if (source.isArchived) throw errors.conflict("Archived fields cannot be converted to shared attributes.");
    if (!targetId) {
      await assertUniqueIndependentName(tx, source.nameEn);
      await tx.attributeField.update({ where: { id: fieldId }, data: { attributeSetId: null } });
      await tx.attributeSetField.create({ data: {
        attributeSetId: setId, attributeFieldId: fieldId,
        isRequired: source.isRequired, isArchived: false, sortOrder: source.sortOrder,
      } });
    } else {
      const target = await tx.attributeField.findFirst({
        where: { id: targetId, attributeSetId: null, isArchived: false },
        include: { options: { orderBy: { sortOrder: "asc" } } },
      });
      if (!target) throw errors.notFound("Active independent attribute");
      const optionsMatch = source.options.length === target.options.length &&
        source.options.every((option, index) => {
          const other = target.options[index];
          return other && option.labelEn === other.labelEn && option.labelFr === other.labelFr;
        });
      if (normalizeAttributeName(source.nameEn) !== normalizeAttributeName(target.nameEn) ||
        source.nameFr !== target.nameFr || source.dataType !== target.dataType || source.unit !== target.unit || !optionsMatch) {
        throw errors.conflict("The definitions differ in name, translation, type, unit or options. Review them separately.");
      }
      if (await tx.attributeSetField.findUnique({ where: { attributeSetId_attributeFieldId: { attributeSetId: setId, attributeFieldId: targetId } } })) {
        throw errors.conflict("The target attribute is already in this set.");
      }
      const sourceValues = await tx.productAttributeValue.findMany({ where: { attributeFieldId: fieldId }, select: { productId: true, optionId: true } });
      if (await tx.productAttributeValue.count({ where: { attributeFieldId: targetId, productId: { in: sourceValues.map((value) => value.productId) } } })) {
        throw errors.conflict("A product already has both attributes. Resolve the conflicting values before merging.");
      }
      const optionMap = new Map(source.options.map((option, index) => [option.id, target.options[index]!.id]));
      if (sourceValues.some((value) => value.optionId !== null && !optionMap.has(value.optionId))) {
        throw errors.conflict("A stored value refers to an unexpected option. Review the data before merging.");
      }
      for (const [sourceId, optionId] of optionMap) {
        await tx.productAttributeValue.updateMany({
          where: { attributeFieldId: fieldId, optionId: sourceId },
          data: { attributeFieldId: targetId, optionId },
        });
      }
      await tx.productAttributeValue.updateMany({ where: { attributeFieldId: fieldId }, data: { attributeFieldId: targetId } });
      await tx.attributeSetField.create({ data: {
        attributeSetId: setId, attributeFieldId: targetId,
        isRequired: source.isRequired, isArchived: false, sortOrder: source.sortOrder,
      } });
      await tx.attributeField.delete({ where: { id: fieldId } });
    }
    await recordAudit(tx, request, {
      action: AuditAction.ATTRIBUTE_FIELD_UPDATE, outcome: "success", entityType: "AttributeSet", entityId: setId,
      changes: diffFields({ fieldId, scope: "set" }, { fieldId: targetId ?? fieldId, scope: "shared" }),
    });
    return toSetDetail(await loadSet(tx, setId));
  });
}

export async function migrateLegacyFields(db: Database, request: AuditRequestContext) {
  const fields = await db.attributeField.findMany({
    where: { attributeSetId: { not: null } },
    include: { attributeSet: { select: { nameEn: true } } },
    orderBy: [{ attributeSet: { nameEn: "asc" } }, { nameEn: "asc" }, { id: "asc" }],
  });
  const migrated: { fieldId: string; setId: string; attributeId: string }[] = [];
  const conflicts: { fieldId: string; setId: string; setName: string; name: string; reason: string }[] = [];
  for (const field of fields) {
    const setId = field.attributeSetId!;
    if (field.isArchived) {
      conflicts.push({ fieldId: field.id, setId, setName: field.attributeSet!.nameEn, name: field.nameEn, reason: "Archived field requires review." });
      continue;
    }
    const candidates = await db.attributeField.findMany({
      where: { attributeSetId: null },
      select: { id: true, nameEn: true, isArchived: true },
    });
    const matching = candidates.filter((candidate) => normalizeAttributeName(candidate.nameEn) === normalizeAttributeName(field.nameEn));
    if (matching.length > 1 || matching.some((candidate) => candidate.isArchived)) {
      conflicts.push({ fieldId: field.id, setId, setName: field.attributeSet!.nameEn, name: field.nameEn, reason: "The matching reusable attribute is ambiguous or archived." });
      continue;
    }
    const targetId = matching[0]?.id ?? null;
    try {
      await makeFieldShared(db, request, setId, field.id, targetId);
      migrated.push({ fieldId: field.id, setId, attributeId: targetId ?? field.id });
    } catch (error) {
      if (!(error instanceof AppError) || ![400, 404, 409].includes(error.statusCode)) throw error;
      conflicts.push({ fieldId: field.id, setId, setName: field.attributeSet!.nameEn, name: field.nameEn, reason: error.message });
    }
  }
  return { migrated, conflicts };
}

export async function updateField(
  db: Database,
  request: AuditRequestContext,
  setId: string,
  fieldId: string,
  input: UpdateFieldInput,
) {
  return db.$transaction(async (tx) => {
    const membership = await tx.attributeSetField.findUnique({
      where: { attributeSetId_attributeFieldId: { attributeSetId: setId, attributeFieldId: fieldId } },
    });
    if (membership) {
      if (membership.isArchived) throw errors.conflict("Archived fields cannot be edited.");
      if (input.name !== undefined || input.dataType !== undefined || input.unit !== undefined || input.options !== undefined) {
        throw errors.validation([{ field: "field", message: "Edit shared attribute definitions from Attributes; only required and order are set-specific." }]);
      }
      const updated = await tx.attributeSetField.update({
        where: { attributeSetId_attributeFieldId: { attributeSetId: setId, attributeFieldId: fieldId } },
        data: { isRequired: input.isRequired, sortOrder: input.sortOrder },
      });
      const changes = diffFields({ isRequired: membership.isRequired, sortOrder: membership.sortOrder },
        { isRequired: updated.isRequired, sortOrder: updated.sortOrder });
      if (changes) await recordAudit(tx, request, { action: AuditAction.ATTRIBUTE_FIELD_UPDATE, outcome: "success", entityType: "AttributeSet", entityId: setId, changes });
      return toSetDetail(await loadSet(tx, setId));
    }
    const field = await loadField(tx, setId, fieldId);
    if (field.isArchived) throw errors.conflict("Archived fields cannot be edited.");

    const hasValues = field._count.values > 0;
    const nextType = input.dataType ?? (field.dataType as AttributeDataType);
    if (nextType !== field.dataType && hasValues) {
      throw errors.conflict("The data type cannot change because products already have values for this field.");
    }

    // Options are synced when provided, and cleared when the field stops being a select.
    const typeChanged = nextType !== field.dataType;
    let nextLabels = field.options.map((o) => o.labelEn);
    if (input.options !== undefined || typeChanged) {
      const requested =
        input.options ??
        (nextType === "select" ? field.options.map((o) => ({ id: o.id, label: { en: o.labelEn, fr: o.labelFr } })) : []);
      nextLabels = normalizeOptionLabels(requested.map((o) => o.label), nextType).map((label) => label.en);
      await syncOptions(tx, field, nextType === "select" ? requested : []);
    }

    const updated = await tx.attributeField.update({
      where: { id: fieldId },
      data: {
        nameEn: input.name?.en.trim(),
        nameFr: input.name?.fr.trim(),
        dataType: nextType,
        unit: input.unit === undefined ? undefined : input.unit?.trim() || null,
        isRequired: input.isRequired,
        sortOrder: input.sortOrder,
      },
    });

    const changes = diffFields(
      fieldSnapshot(field, field.options.map((o) => o.labelEn)),
      fieldSnapshot(updated, nextLabels),
    );
    if (changes) {
      await recordAudit(tx, request, {
        action: AuditAction.ATTRIBUTE_FIELD_UPDATE,
        outcome: "success",
        entityType: "AttributeField",
        entityId: fieldId,
        changes,
      });
    }
    return toSetDetail(await loadSet(tx, setId));
  });
}

async function syncOptions(
  tx: Tx,
  field: { id: string; options: { id: string; labelEn: string }[] },
  requested: { id?: string | undefined; label: Translated }[],
) {
  const existingById = new Map(field.options.map((o) => [o.id, o]));
  const keepIds = new Set<string>();
  for (const option of requested) {
    if (option.id === undefined) continue;
    if (!existingById.has(option.id)) {
      throw errors.validation([{ field: "options", message: "An option does not belong to this field." }]);
    }
    keepIds.add(option.id);
  }

  const removed = field.options.filter((o) => !keepIds.has(o.id));
  if (removed.length > 0) {
    const inUse = await tx.productAttributeValue.findFirst({
      where: { optionId: { in: removed.map((o) => o.id) } },
      include: { option: true },
    });
    if (inUse) {
      throw errors.conflict(`The option "${inUse.option?.labelEn ?? ""}" is used by products and cannot be removed.`);
    }
    await tx.attributeOption.deleteMany({ where: { id: { in: removed.map((o) => o.id) } } });
  }

  // Move kept options to temporary labels first so swapping two labels does not hit the unique index.
  for (const id of keepIds) {
    await tx.attributeOption.update({ where: { id }, data: { labelEn: `__tmp__${id}` } });
  }
  for (const [index, option] of requested.entries()) {
    const labelEn = option.label.en.trim();
    const labelFr = option.label.fr.trim();
    if (option.id) {
      await tx.attributeOption.update({
        where: { id: option.id },
        data: { labelEn, labelFr, sortOrder: index + 1 },
      });
    } else {
      await tx.attributeOption.create({
        data: { attributeFieldId: field.id, labelEn, labelFr, sortOrder: index + 1 },
      });
    }
  }
}

/** Sets the display order. The list must contain every field in the set exactly once (FR-ATS-08). */
export async function reorderFields(db: Database, request: AuditRequestContext, setId: string, fieldIds: string[]) {
  return db.$transaction(async (tx) => {
    const set = await loadSet(tx, setId);
    const current = [...set.fields.map((f) => f.id), ...set.sharedFields.map((f) => f.attributeFieldId)];
    const sameMembers =
      fieldIds.length === current.length && new Set(fieldIds).size === fieldIds.length && fieldIds.every((id) => current.includes(id));
    if (!sameMembers) {
      throw errors.validation([{ field: "fieldIds", message: "Provide every field in the set exactly once." }]);
    }

    for (const [index, id] of fieldIds.entries()) {
      if (set.sharedFields.some((field) => field.attributeFieldId === id)) {
        await tx.attributeSetField.update({ where: { attributeSetId_attributeFieldId: { attributeSetId: setId, attributeFieldId: id } }, data: { sortOrder: index + 1 } });
      } else {
        await tx.attributeField.update({ where: { id }, data: { sortOrder: index + 1 } });
      }
    }
    const codeById = new Map([...set.fields.map((f) => [f.id, f.code] as const), ...set.sharedFields.map((f) => [f.attributeFieldId, f.field.code] as const)]);
    const changes = diffFields(
      { order: toSetDetail(set).fields.map((f) => f.code) },
      { order: fieldIds.map((id) => codeById.get(id)) },
    );
    if (changes) {
      await recordAudit(tx, request, {
        action: AuditAction.ATTRIBUTE_FIELD_REORDER,
        outcome: "success",
        entityType: "AttributeSet",
        entityId: setId,
        changes,
      });
    }
    return toSetDetail(await loadSet(tx, setId));
  });
}

/** Archives fields that have values; deletes the rest (FR-ATS-09, SPEC §8.3). */
export async function removeField(db: Database, request: AuditRequestContext, setId: string, fieldId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM attribute_sets WHERE id = ${setId}::uuid FOR UPDATE`;
    const membership = await tx.attributeSetField.findUnique({
      where: { attributeSetId_attributeFieldId: { attributeSetId: setId, attributeFieldId: fieldId } },
      include: { field: true },
    });
    if (membership) {
      const used = await tx.productAttributeValue.count({ where: { attributeFieldId: fieldId, product: { attributeSetId: setId } } });
      if (used > 0) {
        if (!membership.isArchived) {
          await tx.attributeSetField.update({ where: { attributeSetId_attributeFieldId: { attributeSetId: setId, attributeFieldId: fieldId } }, data: { isArchived: true } });
          await recordAudit(tx, request, { action: AuditAction.ATTRIBUTE_FIELD_ARCHIVE, outcome: "success", entityType: "AttributeSet", entityId: setId, changes: diffFields({ attributeId: fieldId, isArchived: false }, { attributeId: fieldId, isArchived: true }) });
        }
        return { result: "archived" as const, attributeSet: toSetDetail(await loadSet(tx, setId)) };
      }
      await tx.attributeSetField.delete({ where: { attributeSetId_attributeFieldId: { attributeSetId: setId, attributeFieldId: fieldId } } });
      await recordAudit(tx, request, { action: AuditAction.ATTRIBUTE_FIELD_DELETE, outcome: "success", entityType: "AttributeSet", entityId: setId, changes: diffFields({ attributeId: fieldId, name: membership.field.nameEn }, { attributeId: null, name: null }) });
      return { result: "deleted" as const, attributeSet: toSetDetail(await loadSet(tx, setId)) };
    }
    const field = await loadField(tx, setId, fieldId);
    const labels = field.options.map((o) => o.labelEn);

    if (field._count.values > 0) {
      const updated = await tx.attributeField.update({ where: { id: fieldId }, data: { isArchived: true } });
      if (!field.isArchived) {
        await recordAudit(tx, request, {
          action: AuditAction.ATTRIBUTE_FIELD_ARCHIVE,
          outcome: "success",
          entityType: "AttributeField",
          entityId: fieldId,
          changes: diffFields(fieldSnapshot(field, labels), fieldSnapshot(updated, labels)),
        });
      }
      return { result: "archived" as const, attributeSet: toSetDetail(await loadSet(tx, setId)) };
    }

    await tx.attributeField.delete({ where: { id: fieldId } });
    await recordAudit(tx, request, {
      action: AuditAction.ATTRIBUTE_FIELD_DELETE,
      outcome: "success",
      entityType: "AttributeField",
      entityId: fieldId,
      changes: diffFields({ code: field.code, "name.en": field.nameEn }, { code: null, "name.en": null }),
    });
    return { result: "deleted" as const, attributeSet: toSetDetail(await loadSet(tx, setId)) };
  });
}

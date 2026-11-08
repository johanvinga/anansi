import type { Prisma } from "../generated/prisma/client.js";
import type { Database } from "../db.js";
import { errors } from "../errors.js";
import { nameKeyOf, PRISMA_UNIQUE_VIOLATION } from "../lib/text.js";
import { generateFieldCode, type AttributeDataType, type FieldDefinition } from "./attribute-values.js";
import {
  AuditAction,
  diffFields,
  recordAudit,
  type AuditRequestContext,
} from "./audit.service.js";

type Tx = Prisma.TransactionClient;

export interface CreateFieldInput {
  name: string;
  dataType: AttributeDataType;
  unit?: string | null | undefined;
  isRequired?: boolean | undefined;
  options?: string[] | undefined;
}

export interface UpdateFieldInput {
  name?: string | undefined;
  dataType?: AttributeDataType | undefined;
  unit?: string | null | undefined;
  isRequired?: boolean | undefined;
  sortOrder?: number | undefined;
  /** Full option list. Entries with an id are kept (and may be renamed); others are created. */
  options?: { id?: string | undefined; label: string }[] | undefined;
}

const detailInclude = {
  fields: {
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: {
      options: { orderBy: { sortOrder: "asc" } },
      _count: { select: { values: true } },
    },
  },
} satisfies Prisma.AttributeSetInclude;

type SetRow = Prisma.AttributeSetGetPayload<{ include: typeof detailInclude }>;
type FieldRow = SetRow["fields"][number];

export type AttributeFieldDto = ReturnType<typeof toFieldDto>;
export type AttributeSetDetailDto = ReturnType<typeof toSetDetail>;

function toFieldDto(field: FieldRow) {
  return {
    id: field.id,
    name: field.name,
    code: field.code,
    dataType: field.dataType as AttributeDataType,
    unit: field.unit,
    isRequired: field.isRequired,
    isArchived: field.isArchived,
    sortOrder: field.sortOrder,
    options: field.options.map((o) => ({ id: o.id, label: o.label, sortOrder: o.sortOrder })),
    /** When true, the data type is locked (FR-ATS-07) and deleting archives the field (FR-ATS-09). */
    hasValues: field._count.values > 0,
  };
}

function toSetDetail(row: SetRow) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    fields: row.fields.map(toFieldDto),
  };
}

function fieldSnapshot(field: { name: string; dataType: string; unit: string | null; isRequired: boolean; isArchived: boolean; sortOrder: number }, optionLabels: string[]) {
  return {
    name: field.name,
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

function normalizeOptionLabels(labels: string[], dataType: AttributeDataType): string[] {
  const trimmed = labels.map((label) => label.trim()).filter((label) => label.length > 0);
  if (dataType !== "select") {
    if (trimmed.length > 0) {
      throw errors.validation([{ field: "options", message: "Options are only allowed for select fields." }]);
    }
    return [];
  }
  if (trimmed.length === 0) {
    throw errors.validation([{ field: "options", message: "Select fields need at least one option." }]);
  }
  const keys = new Set(trimmed.map((label) => label.toLowerCase()));
  if (keys.size !== trimmed.length) {
    throw errors.validation([{ field: "options", message: "Option labels must be unique." }]);
  }
  return trimmed;
}

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
  return fields.map((f) => ({
    id: f.id,
    name: f.name,
    code: f.code,
    unit: f.unit,
    sortOrder: f.sortOrder,
    dataType: f.dataType as AttributeDataType,
    isRequired: f.isRequired,
    isArchived: f.isArchived,
    options: f.options.map((o) => ({ id: o.id, label: o.label })),
  }));
}

export async function listAttributeSets(db: Database, request: AuditRequestContext) {
  const rows = await db.attributeSet.findMany({
    orderBy: { name: "asc" },
    include: {
      _count: { select: { fields: { where: { isArchived: false } }, products: true } },
    },
  });
  await recordAudit(db, request, { action: AuditAction.ATTRIBUTE_SET_LIST, outcome: "success" });
  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      fieldCount: row._count.fields,
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

export async function createAttributeSet(db: Database, request: AuditRequestContext, name: string) {
  const nameKey = nameKeyOf(name);
  if (await db.attributeSet.findUnique({ where: { nameKey } })) throw duplicateSetName();
  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.attributeSet.create({ data: { name: name.trim(), nameKey }, include: detailInclude });
      await recordAudit(tx, request, {
        action: AuditAction.ATTRIBUTE_SET_CREATE,
        outcome: "success",
        entityType: "AttributeSet",
        entityId: row.id,
        changes: diffFields({}, { name: row.name }),
      });
      return toSetDetail(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateSetName();
    throw error;
  }
}

export async function renameAttributeSet(db: Database, request: AuditRequestContext, id: string, name: string) {
  try {
    return await db.$transaction(async (tx) => {
      const existing = await loadSet(tx, id);
      const row = await tx.attributeSet.update({
        where: { id },
        data: { name: name.trim(), nameKey: nameKeyOf(name) },
        include: detailInclude,
      });
      const changes = diffFields({ name: existing.name }, { name: row.name });
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
      changes: diffFields({ name: existing.name, fields: existing.fields.map((f) => f.code) }, { name: null, fields: null }),
    });
  });
}

export async function addField(db: Database, request: AuditRequestContext, setId: string, input: CreateFieldInput) {
  const labels = normalizeOptionLabels(input.options ?? [], input.dataType);
  try {
    return await db.$transaction(async (tx) => {
      const set = await loadSet(tx, setId);
      const code = generateFieldCode(input.name, set.fields.map((f) => f.code));
      const sortOrder = set.fields.reduce((max, f) => Math.max(max, f.sortOrder), 0) + 1;

      const field = await tx.attributeField.create({
        data: {
          attributeSetId: setId,
          name: input.name.trim(),
          code,
          dataType: input.dataType,
          unit: input.unit?.trim() || null,
          isRequired: input.isRequired ?? false,
          sortOrder,
          options: { create: labels.map((label, index) => ({ label, sortOrder: index + 1 })) },
        },
      });
      await recordAudit(tx, request, {
        action: AuditAction.ATTRIBUTE_FIELD_CREATE,
        outcome: "success",
        entityType: "AttributeField",
        entityId: field.id,
        changes: diffFields({}, { attributeSet: set.name, code, ...fieldSnapshot(field, labels) }),
      });
      return toSetDetail(await loadSet(tx, setId));
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw errors.conflict("A field with this code already exists in the set.");
    throw error;
  }
}

export async function updateField(
  db: Database,
  request: AuditRequestContext,
  setId: string,
  fieldId: string,
  input: UpdateFieldInput,
) {
  return db.$transaction(async (tx) => {
    const field = await loadField(tx, setId, fieldId);
    if (field.isArchived) throw errors.conflict("Archived fields cannot be edited.");

    const hasValues = field._count.values > 0;
    const nextType = input.dataType ?? (field.dataType as AttributeDataType);
    if (nextType !== field.dataType && hasValues) {
      throw errors.conflict("The data type cannot change because products already have values for this field.");
    }

    // Options are synced when provided, and cleared when the field stops being a select.
    const typeChanged = nextType !== field.dataType;
    let nextLabels = field.options.map((o) => o.label);
    if (input.options !== undefined || typeChanged) {
      const requested = input.options ?? (nextType === "select" ? field.options.map((o) => ({ id: o.id, label: o.label })) : []);
      nextLabels = normalizeOptionLabels(requested.map((o) => o.label), nextType);
      await syncOptions(tx, field, nextType === "select" ? requested : []);
    }

    const updated = await tx.attributeField.update({
      where: { id: fieldId },
      data: {
        name: input.name?.trim(),
        dataType: nextType,
        unit: input.unit === undefined ? undefined : input.unit?.trim() || null,
        isRequired: input.isRequired,
        sortOrder: input.sortOrder,
      },
    });

    const changes = diffFields(
      fieldSnapshot(field, field.options.map((o) => o.label)),
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
  field: { id: string; options: { id: string; label: string }[] },
  requested: { id?: string | undefined; label: string }[],
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
      throw errors.conflict(`The option "${inUse.option?.label ?? ""}" is used by products and cannot be removed.`);
    }
    await tx.attributeOption.deleteMany({ where: { id: { in: removed.map((o) => o.id) } } });
  }

  // Move kept options to temporary labels first so swapping two labels does not hit the unique index.
  for (const id of keepIds) {
    await tx.attributeOption.update({ where: { id }, data: { label: `__tmp__${id}` } });
  }
  for (const [index, option] of requested.entries()) {
    const label = option.label.trim();
    if (option.id) {
      await tx.attributeOption.update({ where: { id: option.id }, data: { label, sortOrder: index + 1 } });
    } else {
      await tx.attributeOption.create({ data: { attributeFieldId: field.id, label, sortOrder: index + 1 } });
    }
  }
}

/** Sets the display order. The list must contain every field in the set exactly once (FR-ATS-08). */
export async function reorderFields(db: Database, request: AuditRequestContext, setId: string, fieldIds: string[]) {
  return db.$transaction(async (tx) => {
    const set = await loadSet(tx, setId);
    const current = set.fields.map((f) => f.id);
    const sameMembers =
      fieldIds.length === current.length && new Set(fieldIds).size === fieldIds.length && fieldIds.every((id) => current.includes(id));
    if (!sameMembers) {
      throw errors.validation([{ field: "fieldIds", message: "Provide every field in the set exactly once." }]);
    }

    for (const [index, id] of fieldIds.entries()) {
      await tx.attributeField.update({ where: { id }, data: { sortOrder: index + 1 } });
    }
    const codeById = new Map(set.fields.map((f) => [f.id, f.code]));
    const changes = diffFields(
      { order: set.fields.map((f) => f.code) },
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
    const field = await loadField(tx, setId, fieldId);
    const labels = field.options.map((o) => o.label);

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
      changes: diffFields({ code: field.code, name: field.name }, { code: null, name: null }),
    });
    return { result: "deleted" as const, attributeSet: toSetDetail(await loadSet(tx, setId)) };
  });
}

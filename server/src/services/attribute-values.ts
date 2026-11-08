import type { ErrorDetail } from "../errors.js";

export type AttributeDataType = "text" | "number" | "decimal" | "boolean" | "date" | "select";

export interface FieldDefinition {
  id: string;
  name: string;
  dataType: AttributeDataType;
  isRequired: boolean;
  isArchived: boolean;
  options: { id: string; label: string }[];
}

export type RawAttributeValue = string | number | boolean | null;

export interface AttributeValueInput {
  fieldId: string;
  value: RawAttributeValue;
}

/** Exactly one storage column is populated, matching the field's data type (SPEC §5.1). */
export type StoredAttributeValue =
  | { kind: "text"; valueText: string }
  | { kind: "number"; valueNumber: string }
  | { kind: "boolean"; valueBoolean: boolean }
  | { kind: "date"; valueDate: Date }
  | { kind: "select"; optionId: string };

export const MAX_TEXT_LENGTH = 2000;
const INT32_MAX = 2_147_483_647;
const INTEGER_PATTERN = /^-?\d+$/;
/** numeric(18,4): up to 14 integer digits and 4 decimal places. */
const DECIMAL_PATTERN = /^-?\d{1,14}(\.\d{1,4})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function attributeFieldPath(fieldId: string): string {
  return `attributeValues.${fieldId}`;
}

function isEmpty(value: RawAttributeValue): boolean {
  return value === null || (typeof value === "string" && value.trim() === "");
}

function parseValue(field: FieldDefinition, value: Exclude<RawAttributeValue, null>): StoredAttributeValue | string {
  switch (field.dataType) {
    case "text": {
      if (typeof value !== "string") return "Enter text.";
      const text = value.trim();
      return text.length > MAX_TEXT_LENGTH
        ? `Must be at most ${MAX_TEXT_LENGTH} characters.`
        : { kind: "text", valueText: text };
    }
    case "number": {
      const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
      if (!INTEGER_PATTERN.test(text)) return "Enter a whole number.";
      const parsed = Number(text);
      if (Math.abs(parsed) > INT32_MAX) return `Must be between -${INT32_MAX} and ${INT32_MAX}.`;
      return { kind: "number", valueNumber: String(parsed) };
    }
    case "decimal": {
      const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
      if (!DECIMAL_PATTERN.test(text)) return "Enter a number with at most 4 decimal places.";
      return { kind: "number", valueNumber: text };
    }
    case "boolean":
      return typeof value === "boolean" ? { kind: "boolean", valueBoolean: value } : "Must be true or false.";
    case "date": {
      if (typeof value !== "string" || !DATE_PATTERN.test(value)) return "Enter a date as YYYY-MM-DD.";
      const date = new Date(`${value}T00:00:00.000Z`);
      // Rejects impossible dates such as 2026-02-30, which Date would silently roll over.
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return "Enter a valid date.";
      return { kind: "date", valueDate: date };
    }
    case "select": {
      const option = typeof value === "string" ? field.options.find((o) => o.id === value) : undefined;
      return option ? { kind: "select", optionId: option.id } : "Choose one of the listed options.";
    }
  }
}

/**
 * Validates submitted values against the attribute set's fields (FR-PRD-05, SPEC §8.1).
 * Archived fields are not editable and are not checked for required values.
 */
export function validateAttributeValues(
  fields: FieldDefinition[],
  inputs: AttributeValueInput[],
): { values: Map<string, StoredAttributeValue>; errors: ErrorDetail[] } {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const values = new Map<string, StoredAttributeValue>();
  const errors: ErrorDetail[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const field = byId.get(input.fieldId);
    const path = attributeFieldPath(input.fieldId);
    if (seen.has(input.fieldId)) {
      errors.push({ field: path, message: "This field was submitted more than once." });
      continue;
    }
    seen.add(input.fieldId);

    if (!field) {
      errors.push({ field: path, message: "This field does not belong to the selected attribute set." });
      continue;
    }
    if (field.isArchived) {
      errors.push({ field: path, message: `${field.name} is archived and can no longer be edited.` });
      continue;
    }
    if (isEmpty(input.value)) {
      continue;
    }
    const parsed = parseValue(field, input.value as Exclude<RawAttributeValue, null>);
    if (typeof parsed === "string") {
      errors.push({ field: path, message: `${field.name}: ${parsed}` });
    } else {
      values.set(field.id, parsed);
    }
  }

  for (const field of fields) {
    if (field.isRequired && !field.isArchived && !values.has(field.id) && !errors.some((e) => e.field === attributeFieldPath(field.id))) {
      errors.push({ field: attributeFieldPath(field.id), message: `${field.name} is required.` });
    }
  }

  return { values, errors };
}

/** Maps a stored value to the database columns, leaving the others null. */
export function toValueColumns(value: StoredAttributeValue) {
  return {
    valueText: value.kind === "text" ? value.valueText : null,
    valueNumber: value.kind === "number" ? value.valueNumber : null,
    valueBoolean: value.kind === "boolean" ? value.valueBoolean : null,
    valueDate: value.kind === "date" ? value.valueDate : null,
    optionId: value.kind === "select" ? value.optionId : null,
  };
}

export interface ValueColumns {
  valueText: string | null;
  valueNumber: { toString(): string } | null;
  valueBoolean: boolean | null;
  valueDate: Date | null;
  optionId: string | null;
}

/** Converts stored columns back to the API representation. Decimals are strings to avoid float rounding. */
export function fromValueColumns(dataType: AttributeDataType, row: ValueColumns): string | number | boolean | null {
  switch (dataType) {
    case "text":
      return row.valueText;
    case "number":
      return row.valueNumber === null ? null : Number(row.valueNumber.toString());
    case "decimal":
      return row.valueNumber === null ? null : row.valueNumber.toString();
    case "boolean":
      return row.valueBoolean;
    case "date":
      return row.valueDate ? row.valueDate.toISOString().slice(0, 10) : null;
    case "select":
      return row.optionId;
  }
}

/** Builds a field code from its name, unique within the set (FR-ATS-04). */
export function generateFieldCode(name: string, existingCodes: Iterable<string>): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ß/g, "ss")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 90) || "field";
  const taken = new Set(existingCodes);
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

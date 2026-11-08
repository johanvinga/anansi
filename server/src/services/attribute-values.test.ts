import { describe, expect, it } from "vitest";
import {
  fromValueColumns,
  generateFieldCode,
  toValueColumns,
  validateAttributeValues,
  type FieldDefinition,
} from "./attribute-values.js";

const OPTION_ID = "0b7c1d8e-1111-4222-8333-444455556666";

function field(overrides: Partial<FieldDefinition> & Pick<FieldDefinition, "id" | "dataType">): FieldDefinition {
  return { name: overrides.id, isRequired: false, isArchived: false, options: [], ...overrides };
}

const fields: FieldDefinition[] = [
  field({ id: "text", dataType: "text" }),
  field({ id: "number", dataType: "number" }),
  field({ id: "decimal", dataType: "decimal" }),
  field({ id: "boolean", dataType: "boolean" }),
  field({ id: "date", dataType: "date" }),
  field({ id: "select", dataType: "select", options: [{ id: OPTION_ID, label: "matte" }] }),
];

function check(fieldId: string, value: string | number | boolean | null) {
  return validateAttributeValues(fields, [{ fieldId, value }]);
}

describe("validateAttributeValues (FR-PRD-05, SPEC §7)", () => {
  it("accepts a valid value for every data type", () => {
    const { values, errors } = validateAttributeValues(fields, [
      { fieldId: "text", value: "  Red  " },
      { fieldId: "number", value: 1200 },
      { fieldId: "decimal", value: "3.1415" },
      { fieldId: "boolean", value: false },
      { fieldId: "date", value: "2026-02-28" },
      { fieldId: "select", value: OPTION_ID },
    ]);
    expect(errors).toEqual([]);
    expect(values.get("text")).toEqual({ kind: "text", valueText: "Red" });
    expect(values.get("number")).toEqual({ kind: "number", valueNumber: "1200" });
    expect(values.get("boolean")).toEqual({ kind: "boolean", valueBoolean: false });
    expect(values.get("select")).toEqual({ kind: "select", optionId: OPTION_ID });
  });

  it("rejects non-integers and out-of-range values for number fields", () => {
    expect(check("number", 1.5).errors).toHaveLength(1);
    expect(check("number", "abc").errors).toHaveLength(1);
    expect(check("number", 2_147_483_648).errors[0]?.message).toContain("between");
    expect(check("number", -2_147_483_647).errors).toEqual([]);
  });

  it("rejects decimals with more than 4 decimal places", () => {
    expect(check("decimal", "1.23456").errors).toHaveLength(1);
    expect(check("decimal", 1.2345).errors).toEqual([]);
    expect(check("decimal", "1e5").errors).toHaveLength(1);
  });

  it("requires a real boolean for boolean fields", () => {
    expect(check("boolean", "true").errors).toHaveLength(1);
  });

  it("rejects malformed and impossible dates", () => {
    expect(check("date", "2026/01/01").errors).toHaveLength(1);
    expect(check("date", "2026-02-30").errors[0]?.message).toContain("valid date");
  });

  it("rejects options that do not belong to the field", () => {
    expect(check("select", "matte").errors).toHaveLength(1);
    expect(check("select", "9f1c2a4e-1111-4222-8333-444455556666").errors).toHaveLength(1);
  });

  it("rejects text longer than the limit", () => {
    expect(check("text", "x".repeat(2001)).errors).toHaveLength(1);
  });

  it("reports missing required fields and treats empty strings as missing", () => {
    const required = [field({ id: "width", name: "Width", dataType: "number", isRequired: true })];
    expect(validateAttributeValues(required, []).errors).toEqual([
      { field: "attributeValues.width", message: "Width is required." },
    ]);
    expect(validateAttributeValues(required, [{ fieldId: "width", value: "  " }]).errors).toHaveLength(1);
  });

  it("does not require archived fields and rejects edits to them", () => {
    const archived = [field({ id: "old", name: "Old", dataType: "text", isRequired: true, isArchived: true })];
    expect(validateAttributeValues(archived, []).errors).toEqual([]);
    expect(validateAttributeValues(archived, [{ fieldId: "old", value: "x" }]).errors[0]?.message).toContain("archived");
  });

  it("rejects unknown and duplicate fields", () => {
    expect(check("missing", "x").errors[0]?.message).toContain("does not belong");
    const dupes = validateAttributeValues(fields, [
      { fieldId: "text", value: "a" },
      { fieldId: "text", value: "b" },
    ]);
    expect(dupes.errors[0]?.message).toContain("more than once");
  });

  it("reports one error per field when a required field has an invalid value", () => {
    const required = [field({ id: "n", name: "N", dataType: "number", isRequired: true })];
    expect(validateAttributeValues(required, [{ fieldId: "n", value: "x" }]).errors).toHaveLength(1);
  });
});

describe("value column mapping", () => {
  it("populates exactly one column and round-trips each type", () => {
    const columns = toValueColumns({ kind: "date", valueDate: new Date("2026-03-04T00:00:00.000Z") });
    expect(columns).toEqual({
      valueText: null,
      valueNumber: null,
      valueBoolean: null,
      valueDate: new Date("2026-03-04T00:00:00.000Z"),
      optionId: null,
    });
    expect(fromValueColumns("date", columns)).toBe("2026-03-04");
    expect(fromValueColumns("number", { ...columns, valueNumber: "42" })).toBe(42);
    expect(fromValueColumns("decimal", { ...columns, valueNumber: "1.5" })).toBe("1.5");
  });
});

describe("generateFieldCode (FR-ATS-04)", () => {
  it("slugifies the name", () => {
    expect(generateFieldCode("Thickness (mm)", [])).toBe("thickness_mm");
    expect(generateFieldCode("Côté Größe", [])).toBe("cote_grosse");
  });

  it("appends a numeric suffix to stay unique within the set", () => {
    expect(generateFieldCode("Width", ["width", "width_2"])).toBe("width_3");
  });

  it("falls back to a default for names without letters or digits", () => {
    expect(generateFieldCode("***", [])).toBe("field");
  });
});

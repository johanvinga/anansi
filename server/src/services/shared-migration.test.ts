import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/helpers.js";

describe("shared attribute migration", () => {
  it("adds memberships without changing populated legacy definitions, options or values", async () => {
    const db = createTestDatabase();
    const schema = `migration_test_${randomUUID().replace(/-/g, "")}`;
    const migration = await readFile(new URL("../../prisma/migrations/20261115130000_shared_attribute_sets/migration.sql", import.meta.url), "utf8");
    const rollback = new Error("rollback migration fixture");
    try {
      await expect(db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
        await tx.$executeRawUnsafe("CREATE TABLE attribute_sets (id UUID PRIMARY KEY)");
        await tx.$executeRawUnsafe("CREATE TABLE attribute_fields (id UUID PRIMARY KEY, attribute_set_id UUID, name_en TEXT, is_required BOOLEAN, sort_order INTEGER)");
        await tx.$executeRawUnsafe("CREATE TABLE attribute_options (id UUID PRIMARY KEY, field_id UUID, label TEXT)");
        await tx.$executeRawUnsafe("CREATE TABLE product_values (field_id UUID, option_id UUID)");
        const setId = randomUUID();
        const fieldId = randomUUID();
        const optionId = randomUUID();
        await tx.$executeRaw`INSERT INTO attribute_sets (id) VALUES (${setId}::uuid)`;
        await tx.$executeRaw`INSERT INTO attribute_fields VALUES (${fieldId}::uuid, ${setId}::uuid, 'Finish', true, 7)`;
        await tx.$executeRaw`INSERT INTO attribute_options VALUES (${optionId}::uuid, ${fieldId}::uuid, 'Matte')`;
        await tx.$executeRaw`INSERT INTO product_values VALUES (${fieldId}::uuid, ${optionId}::uuid)`;
        for (const statement of migration.split(";").map((part) => part.trim()).filter(Boolean)) {
          await tx.$executeRawUnsafe(statement);
        }
        const rows = await tx.$queryRaw<{ name_en: string; is_required: boolean; sort_order: number; option_id: string; label: string }[]>`
          SELECT f.name_en, f.is_required, f.sort_order, v.option_id, o.label
          FROM attribute_fields f JOIN product_values v ON v.field_id = f.id
          JOIN attribute_options o ON o.id = v.option_id
        `;
        expect(rows).toEqual([{ name_en: "Finish", is_required: true, sort_order: 7, option_id: optionId, label: "Matte" }]);
        await tx.$executeRaw`INSERT INTO attribute_set_fields (attribute_set_id, attribute_field_id, sort_order) VALUES (${setId}::uuid, ${fieldId}::uuid, 1)`;
        throw rollback;
      })).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  });
});

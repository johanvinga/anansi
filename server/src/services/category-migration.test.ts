import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/helpers.js";

describe("category hierarchy migration", () => {
  it("preserves populated categories and all direct assignments as roots", async () => {
    const db = createTestDatabase();
    const schema = `category_migration_${randomUUID().replace(/-/g, "")}`;
    const migration = await readFile(new URL("../../prisma/migrations/20261115150000_category_hierarchy/migration.sql", import.meta.url), "utf8");
    const rollback = new Error("rollback migration fixture");
    try {
      await expect(db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
        await tx.$executeRawUnsafe("CREATE TABLE categories (id UUID PRIMARY KEY, name_en TEXT NOT NULL, name_fr TEXT NOT NULL, name_key VARCHAR(100) NOT NULL)");
        await tx.$executeRawUnsafe('CREATE UNIQUE INDEX "categories_name_key_key" ON categories(name_key)');
        for (const table of ["supplier_categories", "product_categories", "catalog_categories"]) {
          await tx.$executeRawUnsafe(`CREATE TABLE "${table}" (category_id UUID NOT NULL REFERENCES categories(id))`);
        }
        const id = randomUUID();
        await tx.$executeRaw`INSERT INTO categories VALUES (${id}::uuid, 'Blinds', 'Stores', 'blinds')`;
        for (const table of ["supplier_categories", "product_categories", "catalog_categories"]) {
          await tx.$executeRawUnsafe(`INSERT INTO "${table}" (category_id) VALUES ($1::uuid)`, id);
        }
        for (const statement of migration.split(";").map((part) => part.trim()).filter(Boolean)) {
          await tx.$executeRawUnsafe(statement);
        }
        const rows = await tx.$queryRaw<{ id: string; name_en: string; name_fr: string; parent_id: string | null }[]>`SELECT id, name_en, name_fr, parent_id FROM categories`;
        expect(rows).toEqual([{ id, name_en: "Blinds", name_fr: "Stores", parent_id: null }]);
        for (const table of ["supplier_categories", "product_categories", "catalog_categories"]) {
          const links = await tx.$queryRawUnsafe<{ category_id: string }[]>(`SELECT category_id FROM "${table}"`);
          expect(links).toEqual([{ category_id: id }]);
        }
        throw rollback;
      })).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  });
});

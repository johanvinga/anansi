import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db.js";
import { createLocalAssetStorage, type AssetStorage } from "../lib/asset-storage.js";
import { ADMIN, READER, createTestDatabase, resetDatabase, seedUser } from "../test/helpers.js";
import { dedupeCatalogs } from "./catalog-dedupe.service.js";

const context = { requestId: "dedupe-test", ipAddress: null, actor: { userId: null, email: "system:dedupe-catalogs" } };

describe("dedupeCatalogs", () => {
  let db: Database;
  let storage: AssetStorage;
  let dir: string;

  beforeAll(async () => {
    db = createTestDatabase();
    dir = await mkdtemp(path.join(tmpdir(), "catalog-dedupe-"));
    storage = createLocalAssetStorage(dir);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  async function makeCatalog(name: string, content: string, createdAt: Date) {
    const storageKey = `catalogs/${randomUUID()}.pdf`;
    const data = Buffer.from(`%PDF-1.4 ${content}\n%%EOF\n`);
    await storage.save(storageKey, data);
    return db.catalog.create({
      data: { name, originalFileName: `${name}.pdf`, storageKey, mimeType: "application/pdf", sizeBytes: data.length, createdAt },
    });
  }

  it("keeps the copy with the most data, merges the others into it, and only deletes with apply", async () => {
    const admin = await seedUser(db, ADMIN, "admin");
    const reader = await seedUser(db, READER, "standard");
    const supplier = await db.supplier.create({ data: { name: "Acme", nameKey: "acme" } });
    const tagA = await db.tag.create({ data: { nameEn: "Lamp", nameFr: "Lampe", nameKey: "lamp" } });
    const tagB = await db.tag.create({ data: { nameEn: "Desk", nameFr: "Bureau", nameKey: "desk" } });

    const oldest = await makeCatalog("oldest", "same", new Date("2026-01-01"));
    const rich = await makeCatalog("rich", "same", new Date("2026-01-02"));
    const newest = await makeCatalog("newest", "same", new Date("2026-01-03"));
    const sameSizeOtherBytes = await makeCatalog("other", "diff", new Date("2026-01-04"));
    const unique = await makeCatalog("unique", "something longer and unique", new Date("2026-01-05"));

    await db.catalog.update({ where: { id: rich.id }, data: { supplierId: supplier.id, tags: { create: [{ tagId: tagA.id }] } } });
    await db.catalogTag.create({ data: { catalogId: oldest.id, tagId: tagB.id } });
    const product = await db.product.create({
      data: {
        supplierId: supplier.id, nameEn: "Lamp", nameFr: "Lampe", supplierSku: "L1", skuKey: "l1",
        sourceCatalogId: newest.id,
      },
    });
    await db.pinnedItem.createMany({
      data: [
        { userId: admin.id, itemType: "catalog", itemId: rich.id },
        { userId: admin.id, itemType: "catalog", itemId: oldest.id },
        { userId: reader.id, itemType: "catalog", itemId: oldest.id },
      ],
    });

    const deps = { db, storage, log: { warn() {} } };
    const dryRun = await dedupeCatalogs(deps, context);
    expect(dryRun.groups).toHaveLength(1);
    expect(dryRun.groups[0]!.keep.id).toBe(rich.id);
    expect(dryRun.groups[0]!.duplicates.map((copy) => [copy.id, copy.outcome])).toEqual([
      [oldest.id, "would-delete"],
      [newest.id, "would-delete"],
    ]);
    expect(await db.catalog.count()).toBe(5);

    const applied = await dedupeCatalogs(deps, context, { apply: true });
    expect(applied.groups[0]!.duplicates.map((copy) => copy.outcome)).toEqual(["deleted", "deleted"]);

    const remaining = await db.catalog.findMany({ select: { id: true } });
    expect(remaining.map((row) => row.id).sort()).toEqual([rich.id, sameSizeOtherBytes.id, unique.id].sort());
    expect(await storage.exists(oldest.storageKey)).toBe(false);
    expect(await storage.exists(newest.storageKey)).toBe(false);
    expect(await storage.exists(rich.storageKey)).toBe(true);

    const kept = await db.catalog.findUniqueOrThrow({ where: { id: rich.id }, include: { tags: true } });
    expect(kept.tags.map((link) => link.tagId).sort()).toEqual([tagA.id, tagB.id].sort());
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).sourceCatalogId).toBe(rich.id);
    const pins = await db.pinnedItem.findMany({ where: { itemType: "catalog", itemId: rich.id } });
    expect(pins.map((pin) => pin.userId).sort()).toEqual([admin.id, reader.id].sort());

    expect(await db.auditLog.count({ where: { actorEmail: "system:dedupe-catalogs", action: "CATALOG_DELETE" } })).toBe(2);
    expect(await db.auditLog.count({ where: { actorEmail: "system:dedupe-catalogs", action: "PRODUCT_UPDATE", entityId: product.id } })).toBe(1);
  });
});

import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db.js";
import { ADMIN, READER, createTestApp, createTestDatabase, loginCookie, resetDatabase, seedUser, unsafeHeaders } from "../test/helpers.js";

describe("category hierarchy", () => {
  let db: Database;
  let app: FastifyInstance;
  let admin: string;
  let reader: string;
  beforeAll(async () => { db = createTestDatabase(); app = await createTestApp(db); });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await resetDatabase(db);
    await seedUser(db, ADMIN, "admin");
    await seedUser(db, READER, "standard");
    admin = await loginCookie(app, ADMIN);
    reader = await loginCookie(app, READER);
  });
  async function create(name: string, parentId?: string | null) {
    const response = await request(app.server).post("/api/v1/categories").set(unsafeHeaders(admin))
      .send({ name: { en: name }, parentId });
    expect(response.status).toBe(201);
    return response.body.category as { id: string; parentId: string | null; path: { id: string }[] };
  }
  async function move(id: string, name: string, parentId: string | null) {
    return request(app.server).put(`/api/v1/categories/${id}`).set(unsafeHeaders(admin))
      .send({ name: { en: name, fr: name }, parentId });
  }

  it("supports sibling uniqueness, paths, safe moves and concurrent cycle rejection", async () => {
    const a = await create("A");
    const b = await create("B");
    const child = await create("Shared", a.id);
    await create("Shared", b.id);
    const duplicate = await request(app.server).post("/api/v1/categories").set(unsafeHeaders(admin))
      .send({ name: { en: "SHARED" }, parentId: a.id });
    expect(duplicate.status).toBe(409);
    const list = await request(app.server).get("/api/v1/categories?q=shared").set("Cookie", reader);
    expect(list.status).toBe(200);
    expect(list.body.items.find((item: { id: string }) => item.id === child.id).path.map((item: { id: string }) => item.id)).toEqual([a.id, child.id]);
    expect((await move(a.id, "A", child.id)).status).toBe(409);
    expect((await move(child.id, "Shared", b.id)).status).toBe(409);
    expect((await request(app.server).put(`/api/v1/categories/${child.id}`).set(unsafeHeaders(admin)).send({ parentId: null })).status).toBe(200);
    expect((await request(app.server).put(`/api/v1/categories/${child.id}`).set(unsafeHeaders(admin)).send({})).status).toBe(400);
    const simultaneous = await Promise.all([move(a.id, "A", b.id), move(b.id, "B", a.id)]);
    expect(simultaneous.map((result) => result.status).sort()).toEqual([200, 409]);
    const audit = await db.auditLog.findFirst({ where: { entityId: child.id, action: "CATEGORY_UPDATE" } });
    expect(audit?.changes).toMatchObject({ parentId: { before: a.id, after: null } });
  });

  it("rejects ambiguous name-only assignment and protects hierarchy endpoints", async () => {
    const a = await create("A");
    const b = await create("B");
    await create("Parts", a.id);
    await create("Parts", b.id);
    const supplier = await request(app.server).post("/api/v1/suppliers").set(unsafeHeaders(admin))
      .send({ name: "Supplier", categories: [{ name: "Parts" }] });
    expect(supplier.status).toBe(400);
    expect(supplier.body.error.details[0].message).toContain("ambiguous");
    expect((await request(app.server).get(`/api/v1/categories/${a.id}/deletion-impact`).set("Cookie", reader)).status).toBe(403);
    expect((await request(app.server).get(`/api/v1/categories/${a.id}/deletion-impact`)).status).toBe(401);
    expect((await request(app.server).delete(`/api/v1/categories/${a.id}`).set(unsafeHeaders(reader))).status).toBe(403);
  });

  it("creates explicit child categories transactionally from assignment editors", async () => {
    const root = await create("Root");
    const supplier = await request(app.server).post("/api/v1/suppliers").set(unsafeHeaders(admin))
      .send({ name: "Supplier", categories: [{ name: "Supplier child", parentId: root.id }] });
    expect(supplier.status).toBe(201);
    const supplierId = supplier.body.supplier.id as string;
    const supplierChild = await db.category.findFirstOrThrow({ where: { nameEn: "Supplier child" } });
    expect(supplierChild.parentId).toBe(root.id);
    expect(await db.auditLog.count({ where: { entityId: supplierChild.id, action: "CATEGORY_CREATE" } })).toBe(1);

    const product = await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`).set(unsafeHeaders(admin))
      .send({ name: { en: "Product" }, supplierSku: "P1", cost: "1", currency: "USD", minQuantity: 1,
        categories: [{ name: "Product child", parentId: root.id }] });
    expect(product.status).toBe(201);
    expect((await db.category.findFirstOrThrow({ where: { nameEn: "Product child" } })).parentId).toBe(root.id);

    const catalog = await db.catalog.create({ data: { name: "Catalog", originalFileName: "file.pdf", storageKey: "assignment-test", mimeType: "application/pdf", sizeBytes: 1 } });
    const updated = await request(app.server).patch(`/api/v1/catalogs/${catalog.id}`).set(unsafeHeaders(admin))
      .send({ categories: [{ name: "Catalog child", parentId: root.id }] });
    expect(updated.status).toBe(200);
    expect((await db.category.findFirstOrThrow({ where: { nameEn: "Catalog child" } })).parentId).toBe(root.id);

    const invalid = await request(app.server).post("/api/v1/suppliers").set(unsafeHeaders(admin))
      .send({ name: "Rollback", categories: [{ name: "Transient", parentId: null }, { name: "Invalid", parentId: "00000000-0000-4000-8000-000000000001" }] });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details[0].field).toBe("categories");
    expect(await db.category.count({ where: { nameEn: "Transient" } })).toBe(0);
    expect(await db.supplier.count({ where: { name: "Rollback" } })).toBe(0);
    const duplicate = await request(app.server).post("/api/v1/suppliers").set(unsafeHeaders(admin))
      .send({ name: "Duplicate", categories: [{ name: "SUPPLIER CHILD", parentId: root.id }] });
    expect(duplicate.status).toBe(409);
  });

  it("reports deletion impact and promotes children while preserving other assignments", async () => {
    const root = await create("Root");
    const removed = await create("Target", root.id);
    const child = await create("Target", removed.id);
    const other = await create("Other");
    const supplier = await request(app.server).post("/api/v1/suppliers").set(unsafeHeaders(admin))
      .send({ name: "Supplier", categories: [{ id: removed.id }] });
    expect(supplier.status).toBe(201);
    const supplierId = supplier.body.supplier.id as string;
    for (const [sku, categories] of [["one", [{ id: removed.id }]], ["two", [{ id: removed.id }, { id: other.id }]], ["three", [{ id: child.id }]]] as const) {
      const product = await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`).set(unsafeHeaders(admin))
        .send({ name: { en: sku }, supplierSku: sku, cost: "1", currency: "USD", minQuantity: 1, categories });
      expect(product.status).toBe(201);
    }
    const catalog = await db.catalog.create({ data: { name: "Catalog", originalFileName: "file.pdf", storageKey: "test-key", mimeType: "application/pdf", sizeBytes: 1,
      categories: { create: [{ categoryId: removed.id }] } } });
    const impact = await request(app.server).get(`/api/v1/categories/${removed.id}/deletion-impact`).set("Cookie", admin);
    expect(impact.body).toEqual({ products: 2, uncategorizedProducts: 1, suppliers: 1, catalogs: 1, children: 1 });
    expect((await request(app.server).delete(`/api/v1/categories/${removed.id}`).set(unsafeHeaders(admin))).status).toBe(204);
    expect((await db.category.findUniqueOrThrow({ where: { id: child.id } })).parentId).toBe(root.id);
    expect(await db.product.count()).toBe(3);
    expect(await db.productCategory.count({ where: { categoryId: child.id } })).toBe(1);
    expect(await db.catalogCategory.count({ where: { catalogId: catalog.id } })).toBe(0);
    const audit = await db.auditLog.findFirst({ where: { entityId: child.id, action: "CATEGORY_UPDATE" } });
    expect(audit?.changes).toMatchObject({ parentId: { before: removed.id, after: root.id } });
  });

  it("blocks deletion when promoted children would conflict", async () => {
    const root = await create("Root");
    const removed = await create("Target", root.id);
    const child = await create("Part", removed.id);
    await create("Part", root.id);
    const response = await request(app.server).delete(`/api/v1/categories/${removed.id}`).set(unsafeHeaders(admin));
    expect(response.status).toBe(409);
    expect((await db.category.findUniqueOrThrow({ where: { id: child.id } })).parentId).toBe(removed.id);
    expect(await db.auditLog.count({ where: { entityId: removed.id, action: "CATEGORY_DELETE" } })).toBe(0);
  });

  it("filters products, suppliers and catalogs by descendants and multiple branches", async () => {
    const root = await create("Home");
    const child = await create("Blinds", root.id);
    const leaf = await create("Zebra", child.id);
    const other = await create("Smart");
    const direct = await request(app.server).post("/api/v1/suppliers").set(unsafeHeaders(admin))
      .send({ name: "Direct", categories: [{ id: leaf.id }] });
    const inherited = await request(app.server).post("/api/v1/suppliers").set(unsafeHeaders(admin))
      .send({ name: "Inherited" });
    const unrelated = await request(app.server).post("/api/v1/suppliers").set(unsafeHeaders(admin))
      .send({ name: "Unrelated" });
    const supplierId = inherited.body.supplier.id as string;
    for (const [sku, categories] of [
      ["both", [{ id: leaf.id }, { id: other.id }]],
      ["none", []],
      ["other", [{ id: other.id }]],
    ] as const) {
      expect((await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`).set(unsafeHeaders(admin))
        .send({ name: { en: sku }, supplierSku: sku, cost: "1", currency: "USD", minQuantity: 1, categories })).status).toBe(201);
    }
    await db.catalog.create({ data: { name: "Direct catalog", originalFileName: "1.pdf", storageKey: "filter-1", mimeType: "application/pdf", sizeBytes: 1,
      categories: { create: [{ categoryId: leaf.id }] } } });
    await db.catalog.create({ data: { name: "Supplier catalog", supplierId, originalFileName: "2.pdf", storageKey: "filter-2", mimeType: "application/pdf", sizeBytes: 1 } });
    await db.catalog.create({ data: { name: "Other catalog", supplierId: unrelated.body.supplier.id, originalFileName: "3.pdf", storageKey: "filter-3", mimeType: "application/pdf", sizeBytes: 1 } });

    const products = await request(app.server).get(`/api/v1/products?category=${root.id}&category=${other.id}`).set("Cookie", reader);
    expect(products.status).toBe(200);
    expect(products.body.items.map((item: { supplierSku: string }) => item.supplierSku).sort()).toEqual(["both", "other"]);
    expect(products.body.total).toBe(2);
    const noCategory = await request(app.server).get(`/api/v1/products?uncategorized=true&category=${root.id}`).set("Cookie", reader);
    expect(noCategory.body.items.map((item: { supplierSku: string }) => item.supplierSku).sort()).toEqual(["both", "none"]);
    const scoped = await request(app.server).get(`/api/v1/suppliers/${supplierId}/products?category=${root.id}`).set("Cookie", reader);
    expect(scoped.body.items.map((item: { supplierSku: string }) => item.supplierSku)).toEqual(["both"]);
    const suppliers = await request(app.server).get(`/api/v1/suppliers?category=${root.id}`).set("Cookie", reader);
    expect(suppliers.body.items.map((item: { name: string }) => item.name).sort()).toEqual(["Direct", "Inherited"]);
    expect(direct.status).toBe(201);
    const catalogs = await request(app.server).get(`/api/v1/catalogs?category=${root.id}`).set("Cookie", reader);
    expect(catalogs.body.items.map((item: { name: string }) => item.name).sort()).toEqual(["Direct catalog", "Supplier catalog"]);
    const unknown = await request(app.server).get("/api/v1/products?category=9f1c2a4e-1111-4222-8333-444455556666").set("Cookie", reader);
    expect(unknown.body.total).toBe(0);
    expect((await request(app.server).get("/api/v1/products?uncategorized=invalid").set("Cookie", reader)).status).toBe(400);
    expect((await request(app.server).get(`/api/v1/products?category=${root.id}`)).status).toBe(401);
  });
});

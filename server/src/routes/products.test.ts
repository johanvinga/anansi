import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db.js";
import {
  ADMIN,
  READER,
  createTestApp,
  createTestDatabase,
  loginCookie,
  resetDatabase,
  seedUser,
  unsafeHeaders,
} from "../test/helpers.js";

const NIL_UUID = "9f1c2a4e-1111-4222-8333-444455556666";

interface Field {
  id: string;
  code: string;
  options: { id: string; label: string }[];
}

describe("products", () => {
  let db: Database;
  let app: FastifyInstance;
  let adminCookie: string;
  let readerCookie: string;
  let supplierId: string;
  let otherSupplierId: string;
  let mdfSetId: string;
  let paintSetId: string;
  let mdf: Record<"width" | "length" | "thickness", Field>;
  let paint: Record<"color" | "texture", Field>;

  beforeAll(async () => {
    db = createTestDatabase();
    app = await createTestApp(db);
  });

  afterAll(async () => {
    await app.close();
  });

  const admin = (method: "post" | "put" | "delete", path: string, body?: object) =>
    request(app.server)[method](`/api/v1${path}`).set(unsafeHeaders(adminCookie)).send(body);

  async function createSet(name: string, fields: object[]) {
    const set = await admin("post", "/attribute-sets", { name });
    let detail = set.body.attributeSet;
    for (const field of fields) {
      detail = (await admin("post", `/attribute-sets/${set.body.attributeSet.id}/fields`, field)).body.attributeSet;
    }
    const byCode = Object.fromEntries((detail.fields as Field[]).map((f) => [f.code, f]));
    return { id: detail.id as string, byCode };
  }

  beforeEach(async () => {
    await resetDatabase(db);
    await seedUser(db, ADMIN, "admin");
    await seedUser(db, READER, "standard");
    adminCookie = await loginCookie(app, ADMIN);
    readerCookie = await loginCookie(app, READER);
    supplierId = (await admin("post", "/suppliers", { name: "Panel Co" })).body.supplier.id;
    otherSupplierId = (await admin("post", "/suppliers", { name: "Other Co" })).body.supplier.id;

    const mdfSet = await createSet("MDF Panel", [
      { name: "Width", dataType: "number", unit: "mm", isRequired: true },
      { name: "Length", dataType: "number", unit: "mm", isRequired: true },
      { name: "Thickness", dataType: "decimal", unit: "mm", isRequired: true },
    ]);
    mdfSetId = mdfSet.id;
    mdf = mdfSet.byCode as typeof mdf;

    const paintSet = await createSet("Paint", [
      { name: "Color", dataType: "text", isRequired: true },
      { name: "Texture", dataType: "select", options: ["matte", "satin", "gloss"] },
    ]);
    paintSetId = paintSet.id;
    paint = paintSet.byCode as typeof paint;
  });

  function mdfProduct(overrides: Record<string, unknown> = {}) {
    return {
      name: "MDF Board 18mm",
      supplierSku: "MDF-18",
      minQuantity: 10,
      cost: "42.50",
      currency: "EUR",
      attributeSetId: mdfSetId,
      attributeValues: [
        { fieldId: mdf.width.id, value: 1220 },
        { fieldId: mdf.length.id, value: 2440 },
        { fieldId: mdf.thickness.id, value: "18.5" },
      ],
      ...overrides,
    };
  }

  const createProduct = (body: object, supplier = supplierId) => admin("post", `/suppliers/${supplier}/products`, body);

  describe("FR-PRD-01/02/04/06/10 create", () => {
    it("creates a product with attribute values and its own currency, and audits it", async () => {
      const res = await createProduct(mdfProduct());
      expect(res.status).toBe(201);
      expect(res.body.product).toMatchObject({
        supplierId,
        supplierName: "Panel Co",
        name: "MDF Board 18mm",
        supplierSku: "MDF-18",
        minQuantity: 10,
        cost: "42.50",
        currency: "EUR",
        attributeSet: { id: mdfSetId, name: "MDF Panel" },
      });
      const values = res.body.product.attributeValues as { code: string; value: unknown; unit: string }[];
      expect(values.map((v) => [v.code, v.value, v.unit])).toEqual([
        ["width", 1220, "mm"],
        ["length", 2440, "mm"],
        ["thickness", "18.5", "mm"],
      ]);

      const audit = await db.auditLog.findFirstOrThrow({ where: { action: "PRODUCT_CREATE" } });
      expect(audit.changes).toMatchObject({
        cost: { before: null, after: "42.50" },
        "attribute.width": { before: null, after: 1220 },
      });
    });

    it("creates a product without an attribute set", async () => {
      const res = await createProduct({ name: "Screws", supplierSku: "S-1", minQuantity: 0, cost: 0, currency: "usd" });
      expect(res.status).toBe(201);
      expect(res.body.product).toMatchObject({ cost: "0.00", currency: "USD", attributeSet: null, attributeValues: [] });
    });

    it("stores select values as options and returns their labels", async () => {
      const res = await createProduct({
        name: "Wall Paint",
        supplierSku: "P-1",
        minQuantity: 1,
        cost: "19.99",
        currency: "GBP",
        attributeSetId: paintSetId,
        attributeValues: [
          { fieldId: paint.color.id, value: "White" },
          { fieldId: paint.texture.id, value: paint.texture.options[1]!.id },
        ],
      });
      expect(res.status).toBe(201);
      const texture = res.body.product.attributeValues.find((v: { code: string }) => v.code === "texture");
      expect(texture).toMatchObject({ value: paint.texture.options[1]!.id, optionLabel: "satin" });
    });

    it.each([
      ["missing name", { name: "" }, "name"],
      ["negative minimum quantity", { minQuantity: -1 }, "minQuantity"],
      ["fractional minimum quantity", { minQuantity: 1.5 }, "minQuantity"],
      ["negative cost", { cost: "-1.00" }, "cost"],
      ["cost with 3 decimals", { cost: "1.005" }, "cost"],
      ["invalid currency", { currency: "XYZ" }, "currency"],
      ["missing SKU", { supplierSku: " " }, "supplierSku"],
    ])("rejects %s", async (_label, overrides, field) => {
      const res = await createProduct(mdfProduct(overrides));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
    });

    it("reports every invalid and missing attribute with the field id as the path (FR-PRD-05)", async () => {
      const res = await createProduct(
        mdfProduct({
          attributeValues: [
            { fieldId: mdf.width.id, value: 12.5 },
            { fieldId: mdf.thickness.id, value: "1.23456" },
          ],
        }),
      );
      expect(res.status).toBe(400);
      const fields = res.body.error.details.map((d: { field: string }) => d.field).sort();
      expect(fields).toEqual(
        [`attributeValues.${mdf.width.id}`, `attributeValues.${mdf.length.id}`, `attributeValues.${mdf.thickness.id}`].sort(),
      );
    });

    it("rejects values for fields from another set and select values that are not options", async () => {
      const wrongSet = await createProduct(
        mdfProduct({ attributeValues: [...mdfProduct().attributeValues, { fieldId: paint.color.id, value: "Red" }] }),
      );
      expect(wrongSet.status).toBe(400);

      const badOption = await createProduct({
        name: "Paint",
        supplierSku: "P-2",
        minQuantity: 1,
        cost: "1",
        currency: "USD",
        attributeSetId: paintSetId,
        attributeValues: [
          { fieldId: paint.color.id, value: "Red" },
          { fieldId: paint.texture.id, value: mdf.width.id },
        ],
      });
      expect(badOption.status).toBe(400);
    });

    it("rejects attribute values without a set, and unknown sets", async () => {
      const noSet = await createProduct(mdfProduct({ attributeSetId: null }));
      expect(noSet.status).toBe(400);
      const unknown = await createProduct(mdfProduct({ attributeSetId: NIL_UUID, attributeValues: [] }));
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.details[0].field).toBe("attributeSetId");
    });

    it("returns 404 for an unknown supplier, 403 for standard users, and 401 without a session", async () => {
      expect((await createProduct(mdfProduct(), NIL_UUID)).status).toBe(404);
      const denied = await request(app.server)
        .post(`/api/v1/suppliers/${supplierId}/products`)
        .set(unsafeHeaders(readerCookie))
        .send(mdfProduct());
      expect(denied.status).toBe(403);
      const anonymous = await request(app.server)
        .post(`/api/v1/suppliers/${supplierId}/products`)
        .set("Origin", "http://localhost:5173")
        .send(mdfProduct());
      expect(anonymous.status).toBe(401);
      expect(await db.product.count()).toBe(0);
    });
  });

  describe("FR-PRD-03 SKU uniqueness", () => {
    it("rejects a duplicate SKU for the same supplier, ignoring case", async () => {
      await createProduct(mdfProduct());
      const res = await createProduct(mdfProduct({ supplierSku: "mdf-18" }));
      expect(res.status).toBe(409);
    });

    it("allows the same SKU under a different supplier", async () => {
      await createProduct(mdfProduct());
      const res = await createProduct(mdfProduct(), otherSupplierId);
      expect(res.status).toBe(201);
    });
  });

  describe("FR-PRD-09 listing", () => {
    beforeEach(async () => {
      await createProduct(mdfProduct());
      await createProduct(mdfProduct({ name: "Birch Plywood", supplierSku: "PLY-9" }));
      await createProduct(mdfProduct({ name: "Oak Veneer", supplierSku: "VEN-1" }), otherSupplierId);
    });

    it("lists all products with pagination for any signed-in user", async () => {
      const res = await request(app.server).get("/api/v1/products?pageSize=2").set("Cookie", readerCookie);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      expect(res.body.items.map((p: { name: string }) => p.name)).toEqual(["Birch Plywood", "MDF Board 18mm"]);
      expect(res.body.items[0]).not.toHaveProperty("attributeValues");
      expect(await db.auditLog.count({ where: { action: "PRODUCT_LIST" } })).toBe(1);
    });

    it("filters by supplier and by name or SKU", async () => {
      const bySupplier = await request(app.server)
        .get(`/api/v1/products?supplierId=${otherSupplierId}`)
        .set("Cookie", readerCookie);
      expect(bySupplier.body.items.map((p: { name: string }) => p.name)).toEqual(["Oak Veneer"]);

      const bySku = await request(app.server).get("/api/v1/products?q=ply-9").set("Cookie", readerCookie);
      expect(bySku.body.items.map((p: { name: string }) => p.name)).toEqual(["Birch Plywood"]);

      const byName = await request(app.server).get("/api/v1/products?q=oak").set("Cookie", readerCookie);
      expect(byName.body.total).toBe(1);
    });

    it("lists one supplier's products", async () => {
      const res = await request(app.server).get(`/api/v1/suppliers/${supplierId}/products`).set("Cookie", readerCookie);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      const missing = await request(app.server).get(`/api/v1/suppliers/${NIL_UUID}/products`).set("Cookie", readerCookie);
      expect(missing.status).toBe(404);
    });
  });

  describe("product detail", () => {
    it("returns attribute values and audits the view", async () => {
      const created = await createProduct(mdfProduct());
      const res = await request(app.server).get(`/api/v1/products/${created.body.product.id}`).set("Cookie", readerCookie);
      expect(res.status).toBe(200);
      expect(res.body.product.attributeValues).toHaveLength(3);
      expect(await db.auditLog.count({ where: { action: "PRODUCT_VIEW" } })).toBe(1);
    });

    it("returns 404 for an unknown product", async () => {
      const res = await request(app.server).get(`/api/v1/products/${NIL_UUID}`).set("Cookie", readerCookie);
      expect(res.status).toBe(404);
    });
  });

  describe("FR-PRD-07 update", () => {
    it("updates fields and values, auditing each changed attribute", async () => {
      const created = await createProduct(mdfProduct());
      const id = created.body.product.id;
      const res = await admin(
        "put",
        `/products/${id}`,
        mdfProduct({
          cost: "40.00",
          attributeValues: [
            { fieldId: mdf.width.id, value: 1220 },
            { fieldId: mdf.length.id, value: 2800 },
            { fieldId: mdf.thickness.id, value: "18.5" },
          ],
        }),
      );
      expect(res.status).toBe(200);
      expect(res.body.product.cost).toBe("40.00");

      const audit = await db.auditLog.findFirstOrThrow({ where: { action: "PRODUCT_UPDATE", entityId: id } });
      expect(audit.changes).toEqual({
        cost: { before: "42.50", after: "40.00" },
        "attribute.length": { before: 2440, after: 2800 },
      });
    });

    it("keeps existing values when attributeValues is omitted", async () => {
      const created = await createProduct(mdfProduct());
      const { attributeValues: _omit, ...withoutValues } = mdfProduct({ name: "Renamed" });
      const res = await admin("put", `/products/${created.body.product.id}`, withoutValues);
      expect(res.status).toBe(200);
      expect(res.body.product.attributeValues).toHaveLength(3);
    });

    it("removes values for fields outside the new set when the set changes", async () => {
      const created = await createProduct(mdfProduct());
      const id = created.body.product.id;
      const res = await admin("put", `/products/${id}`, {
        ...mdfProduct(),
        attributeSetId: paintSetId,
        attributeValues: [{ fieldId: paint.color.id, value: "Grey" }],
      });
      expect(res.status).toBe(200);
      expect(res.body.product.attributeSet.name).toBe("Paint");
      expect(res.body.product.attributeValues.map((v: { code: string }) => v.code)).toEqual(["color"]);
      expect(await db.productAttributeValue.count({ where: { productId: id } })).toBe(1);

      const audit = await db.auditLog.findFirstOrThrow({ where: { action: "PRODUCT_UPDATE", entityId: id } });
      expect(audit.changes).toMatchObject({
        attributeSet: { before: "MDF Panel", after: "Paint" },
        "attribute.width": { before: 1220, after: null },
      });
    });

    it("validates required fields of the new set when the set changes", async () => {
      const created = await createProduct(mdfProduct());
      const res = await admin("put", `/products/${created.body.product.id}`, { ...mdfProduct(), attributeSetId: paintSetId, attributeValues: [] });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe(`attributeValues.${paint.color.id}`);
    });

    it("removes the set and all values when attributeSetId is null", async () => {
      const created = await createProduct(mdfProduct());
      const res = await admin("put", `/products/${created.body.product.id}`, { ...mdfProduct(), attributeSetId: null, attributeValues: undefined });
      expect(res.status).toBe(200);
      expect(res.body.product.attributeValues).toEqual([]);
    });

    it("keeps values of archived fields and returns them in the detail view (SPEC §8.1)", async () => {
      const created = await createProduct(mdfProduct());
      const id = created.body.product.id;
      await admin("delete", `/attribute-sets/${mdfSetId}/fields/${mdf.thickness.id}`);

      const res = await admin("put", `/products/${id}`, {
        ...mdfProduct(),
        attributeValues: [
          { fieldId: mdf.width.id, value: 1000 },
          { fieldId: mdf.length.id, value: 2000 },
        ],
      });
      expect(res.status).toBe(200);
      const thickness = res.body.product.attributeValues.find((v: { code: string }) => v.code === "thickness");
      expect(thickness).toMatchObject({ isArchived: true, value: "18.5" });

      const editArchived = await admin("put", `/products/${id}`, {
        ...mdfProduct(),
        attributeValues: [...mdfProduct().attributeValues],
      });
      expect(editArchived.status).toBe(400);
    });

    it("rejects a SKU that collides with another product of the same supplier", async () => {
      await createProduct(mdfProduct());
      const second = await createProduct(mdfProduct({ supplierSku: "MDF-19" }));
      const res = await admin("put", `/products/${second.body.product.id}`, mdfProduct({ supplierSku: "MDF-18" }));
      expect(res.status).toBe(409);
    });

    it("reassigns a product to another supplier and checks SKU uniqueness there", async () => {
      const created = await createProduct(mdfProduct());
      const moved = await admin("put", `/products/${created.body.product.id}`, { ...mdfProduct(), supplierId: otherSupplierId });
      expect(moved.status).toBe(200);
      expect(moved.body.product.supplierName).toBe("Other Co");

      const unknown = await admin("put", `/products/${created.body.product.id}`, { ...mdfProduct(), supplierId: NIL_UUID });
      expect(unknown.status).toBe(400);
    });

    it("returns 403 to standard users and 404 for unknown products", async () => {
      const created = await createProduct(mdfProduct());
      const denied = await request(app.server)
        .put(`/api/v1/products/${created.body.product.id}`)
        .set(unsafeHeaders(readerCookie))
        .send(mdfProduct({ name: "Hacked" }));
      expect(denied.status).toBe(403);
      expect((await admin("put", `/products/${NIL_UUID}`, mdfProduct())).status).toBe(404);
    });
  });

  describe("FR-PRD-08 delete", () => {
    it("deletes the product with its attribute values and audits it", async () => {
      const created = await createProduct(mdfProduct());
      const id = created.body.product.id;
      const res = await admin("delete", `/products/${id}`);
      expect(res.status).toBe(204);
      expect(await db.productAttributeValue.count()).toBe(0);
      const audit = await db.auditLog.findFirstOrThrow({ where: { action: "PRODUCT_DELETE", entityId: id } });
      expect(audit.changes).toMatchObject({ name: { before: "MDF Board 18mm", after: null } });
    });

    it("returns 403 to standard users and 404 for unknown products", async () => {
      const created = await createProduct(mdfProduct());
      const denied = await request(app.server)
        .delete(`/api/v1/products/${created.body.product.id}`)
        .set(unsafeHeaders(readerCookie));
      expect(denied.status).toBe(403);
      expect((await admin("delete", `/products/${NIL_UUID}`)).status).toBe(404);
    });
  });

  describe("FR-SUP-05 supplier deletion with products", () => {
    it("blocks deleting a supplier that has products, and allows it after reassigning them", async () => {
      const created = await createProduct(mdfProduct());
      const blocked = await admin("delete", `/suppliers/${supplierId}`);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.message).toContain("product");

      await admin("put", `/products/${created.body.product.id}`, { ...mdfProduct(), supplierId: otherSupplierId });
      expect((await admin("delete", `/suppliers/${supplierId}`)).status).toBe(204);
    });
  });

  describe("settings", () => {
    it("exposes the default currency and the ISO 4217 list to signed-in users", async () => {
      const res = await request(app.server).get("/api/v1/settings").set("Cookie", readerCookie);
      expect(res.status).toBe(200);
      expect(res.body.defaultCurrency).toBe("USD");
      expect(res.body.currencies).toContain("EUR");
      expect((await request(app.server).get("/api/v1/settings")).status).toBe(401);
    });
  });
});

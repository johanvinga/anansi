import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db.js";
import { ADMIN, READER, createTestApp, createTestDatabase, loginCookie, resetDatabase, seedUser, unsafeHeaders } from "../test/helpers.js";

describe("independent attributes", () => {
  let app: FastifyInstance;
  let db: Database;
  let admin: string;
  let reader: string;
  let supplierId: string;

  beforeAll(async () => {
    db = createTestDatabase();
    app = await createTestApp(db);
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await resetDatabase(db);
    await seedUser(db, ADMIN, "admin");
    await seedUser(db, READER, "standard");
    admin = await loginCookie(app, ADMIN);
    reader = await loginCookie(app, READER);
    const supplier = await request(app.server).post("/api/v1/suppliers").set(unsafeHeaders(admin)).send({ name: "Supplier" });
    supplierId = supplier.body.supplier.id;
  });

  it("authenticates, validates, audits, and prevents case-insensitive duplicate names", async () => {
    const url = "/api/v1/attributes";
    expect((await request(app.server).get(url)).status).toBe(401);
    expect((await request(app.server).post(url).set(unsafeHeaders(reader)).send({ name: { en: "Color" } })).status).toBe(403);
    expect((await request(app.server).post(url).set(unsafeHeaders(admin)).send({ name: { en: "" } })).status).toBe(400);
    const created = await request(app.server).post(url).set(unsafeHeaders(admin)).send({ name: { en: "Color" } });
    expect(created.status).toBe(201);
    expect((await request(app.server).post(url).set(unsafeHeaders(admin)).send({ name: { en: " color " } })).status).toBe(409);
    const list = await request(app.server).get(url).set("Cookie", reader);
    expect(list.status).toBe(200);
    expect(list.body.items).toMatchObject([{ id: created.body.attribute.id, dataType: "text" }]);
    expect(await db.auditLog.count({ where: { entityId: created.body.attribute.id, action: "ATTRIBUTE_FIELD_CREATE" } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "ATTRIBUTE_FIELD_LIST" } })).toBe(1);
  });

  it("stores direct values and preserves them when legacy product edits replace set values", async () => {
    const attribute = await request(app.server).post("/api/v1/attributes").set(unsafeHeaders(admin)).send({ name: { en: "Color" } });
    const id = attribute.body.attribute.id as string;
    const productBody = { name: { en: "Example", fr: "Example" }, supplierSku: "X1", cost: "1", currency: "USD", minQuantity: 1 };
    const invalid = await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`).set(unsafeHeaders(admin))
      .send({ ...productBody, directAttributeValues: [{ fieldId: id, value: true }] });
    expect(invalid.status).toBe(400);
    const created = await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`).set(unsafeHeaders(admin))
      .send({ ...productBody, directAttributeValues: [{ fieldId: id, value: "White" }] });
    expect(created.status).toBe(201);
    expect(created.body.product.attributeValues).toMatchObject([{ fieldId: id, value: "White" }]);
    const productId = created.body.product.id as string;
    const edited = await request(app.server).put(`/api/v1/products/${productId}`).set(unsafeHeaders(admin))
      .send({ ...productBody, attributeValues: [] });
    expect(edited.status).toBe(200);
    expect(edited.body.product.attributeValues).toMatchObject([{ fieldId: id, value: "White" }]);
    const updated = await request(app.server).put(`/api/v1/products/${productId}`).set(unsafeHeaders(admin))
      .send({ ...productBody, directAttributeValues: [{ fieldId: id, value: "Blue" }] });
    expect(updated.status).toBe(200);
    expect(updated.body.product.attributeValues).toMatchObject([{ fieldId: id, value: "Blue" }]);
    expect(await db.auditLog.count({ where: { entityId: productId, action: "PRODUCT_UPDATE" } })).toBe(1);
  });

  it("renames and removes unused attributes with validation, authorization and audit", async () => {
    const created = await request(app.server).post("/api/v1/attributes").set(unsafeHeaders(admin)).send({ name: { en: "Color" } });
    const id = created.body.attribute.id as string;
    const url = `/api/v1/attributes/${id}`;
    expect((await request(app.server).put(url).set(unsafeHeaders()).send({ name: { en: "Shade", fr: "Teinte" } })).status).toBe(401);
    expect((await request(app.server).put(url).set(unsafeHeaders(reader)).send({ name: { en: "Shade", fr: "Teinte" } })).status).toBe(403);
    expect((await request(app.server).delete(url).set(unsafeHeaders(reader))).status).toBe(403);
    expect((await request(app.server).put(url).set(unsafeHeaders(admin)).send({ name: { en: "", fr: "Teinte" } })).status).toBe(400);
    const renamed = await request(app.server).put(url).set(unsafeHeaders(admin)).send({ name: { en: "Shade", fr: "Teinte" } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.attribute.name).toEqual({ en: "Shade", fr: "Teinte" });
    expect(await db.auditLog.count({ where: { entityId: id, action: "ATTRIBUTE_FIELD_UPDATE" } })).toBe(1);
    const removed = await request(app.server).delete(url).set(unsafeHeaders(admin));
    expect(removed.status).toBe(200);
    expect(removed.body.result).toBe("deleted");
    expect(await db.attributeField.findUnique({ where: { id } })).toBeNull();
    expect(await db.auditLog.count({ where: { entityId: id, action: "ATTRIBUTE_FIELD_DELETE" } })).toBe(1);
  });

  it("archives used attributes and preserves their product values", async () => {
    const attribute = await request(app.server).post("/api/v1/attributes").set(unsafeHeaders(admin)).send({ name: { en: "Color" } });
    const id = attribute.body.attribute.id as string;
    const created = await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`).set(unsafeHeaders(admin)).send({
      name: { en: "Example", fr: "Example" }, supplierSku: "X1", cost: "1", currency: "USD", minQuantity: 1,
      directAttributeValues: [{ fieldId: id, value: "White" }],
    });
    expect(created.status).toBe(201);
    const removed = await request(app.server).delete(`/api/v1/attributes/${id}`).set(unsafeHeaders(admin));
    expect(removed.status).toBe(200);
    expect(removed.body.result).toBe("archived");
    expect(await db.productAttributeValue.findFirst({ where: { attributeFieldId: id } })).toMatchObject({ valueText: "White" });
    expect((await request(app.server).get("/api/v1/attributes").set("Cookie", reader)).body.items).toEqual([]);
    expect(await db.auditLog.count({ where: { entityId: id, action: "ATTRIBUTE_FIELD_ARCHIVE" } })).toBe(1);
  });

  it("prevents concurrent normalized duplicate names", async () => {
    const url = "/api/v1/attributes";
    const results = await Promise.all([
      request(app.server).post(url).set(unsafeHeaders(admin)).send({ name: { en: "Overall  Length" } }),
      request(app.server).post(url).set(unsafeHeaders(admin)).send({ name: { en: "Ｏｖｅｒａｌｌ Length" } }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(await db.attributeField.count({ where: { attributeSetId: null } })).toBe(1);
  });

  it("promotes a legacy definition and merges only compatible fields without losing product values", async () => {
      const makeSet = async (name: string, unit: string | null = null) =>
        request(app.server).post("/api/v1/attribute-sets").set(unsafeHeaders(admin)).send({
          name: { en: name }, fields: [{ name: { en: "Finish", fr: "Finition" }, dataType: "select", unit,
            isRequired: true, options: [{ en: "Matte", fr: "Mat" }, { en: "Gloss", fr: "Brillant" }] }],
        });

      const first = await makeSet("First");
      const second = await makeSet("Second");
      const conflict = await makeSet("Conflicting", "mm");
      const firstId = first.body.attributeSet.id as string;
      const secondId = second.body.attributeSet.id as string;
      const field = first.body.attributeSet.fields[0];
      const other = second.body.attributeSet.fields[0];
      const wrong = conflict.body.attributeSet.fields[0];
      const productBody = { name: { en: "Example", fr: "Example" }, cost: "1", currency: "USD", minQuantity: 1 };
      const product1 = await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`).set(unsafeHeaders(admin)).send({
        ...productBody, supplierSku: "P1", attributeSetId: firstId, attributeValues: [{ fieldId: field.id, value: field.options[0].id }],
      });
      const product2 = await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`).set(unsafeHeaders(admin)).send({
        ...productBody, supplierSku: "P2", attributeSetId: secondId, attributeValues: [{ fieldId: other.id, value: other.options[0].id }],
      });
      expect([product1.status, product2.status]).toEqual([201, 201]);
      const promoteUrl = `/api/v1/attribute-sets/${firstId}/fields/${field.id}/share`;
      expect((await request(app.server).post(promoteUrl).set(unsafeHeaders(reader)).send({ attributeId: null })).status).toBe(403);
      const promoted = await request(app.server).post(promoteUrl).set(unsafeHeaders(admin)).send({ attributeId: null });
      expect(promoted.status).toBe(200);
      expect(promoted.body.attributeSet.fields[0]).toMatchObject({ id: field.id, shared: true, isRequired: true, options: [{ id: field.options[0].id }, { id: field.options[1].id }] });
      const bad = await request(app.server).post(`/api/v1/attribute-sets/${conflict.body.attributeSet.id}/fields/${wrong.id}/share`)
        .set(unsafeHeaders(admin)).send({ attributeId: field.id });
      expect(bad.status).toBe(409);
      const merged = await request(app.server).post(`/api/v1/attribute-sets/${secondId}/fields/${other.id}/share`)
        .set(unsafeHeaders(admin)).send({ attributeId: field.id });
      expect(merged.status).toBe(200);
      expect(merged.body.attributeSet.fields[0]).toMatchObject({ id: field.id, shared: true, isRequired: true });
      const product = await request(app.server).get(`/api/v1/products/${product2.body.product.id}`).set("Cookie", reader);
      expect(product.body.product.attributeValues).toEqual(expect.arrayContaining([
        expect.objectContaining({ fieldId: field.id, value: field.options[0].id, optionLabel: { en: "Matte", fr: "Mat" } }),
      ]));
      expect(await db.attributeField.findUnique({ where: { id: other.id } })).toBeNull();
      expect(await db.attributeField.findUnique({ where: { id: wrong.id } })).not.toBeNull();
      expect(await db.auditLog.count({ where: { entityId: secondId, action: "ATTRIBUTE_FIELD_UPDATE" } })).toBe(1);
      const bulkUrl = "/api/v1/attributes/migrate-legacy";
      expect((await request(app.server).post(bulkUrl).set(unsafeHeaders(reader))).status).toBe(403);
      const bulk = await request(app.server).post(bulkUrl).set(unsafeHeaders(admin));
      expect(bulk.status).toBe(200);
      expect(bulk.body.migrated).toEqual([]);
      expect(bulk.body.conflicts).toEqual([expect.objectContaining({ fieldId: wrong.id })]);
      expect(await db.attributeField.findUnique({ where: { id: wrong.id } })).not.toBeNull();
  });

  it("migrates compatible legacy definitions in bulk and reports conflicts without modifying them", async () => {
    const createSet = async (name: string, unit: string | null) => request(app.server).post("/api/v1/attribute-sets").set(unsafeHeaders(admin)).send({
      name: { en: name }, fields: [{ name: { en: "Length" }, dataType: "decimal", unit }],
    });
    const first = await createSet("First", "mm");
    const second = await createSet("Second", "mm");
    const third = await createSet("Third", "in");
    const secondField = second.body.attributeSet.fields[0];
    const product = await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`).set(unsafeHeaders(admin)).send({
      name: { en: "Example", fr: "Example" }, cost: "1", currency: "USD", minQuantity: 1,
      supplierSku: "P2", attributeSetId: second.body.attributeSet.id,
      attributeValues: [{ fieldId: secondField.id, value: "12.5" }],
    });
    expect(product.status).toBe(201);
    const result = await request(app.server).post("/api/v1/attributes/migrate-legacy").set(unsafeHeaders(admin));
    expect(result.status).toBe(200);
    expect(result.body.migrated).toHaveLength(2);
    expect(result.body.conflicts).toEqual([expect.objectContaining({ fieldId: third.body.attributeSet.fields[0].id })]);
    const firstDetail = await request(app.server).get(`/api/v1/attribute-sets/${first.body.attributeSet.id}`).set("Cookie", reader);
    const secondDetail = await request(app.server).get(`/api/v1/attribute-sets/${second.body.attributeSet.id}`).set("Cookie", reader);
    expect(firstDetail.body.attributeSet.fields[0].id).toBe(secondDetail.body.attributeSet.fields[0].id);
    const value = await request(app.server).get(`/api/v1/products/${product.body.product.id}`).set("Cookie", reader);
    expect(value.body.product.attributeValues).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldId: firstDetail.body.attributeSet.fields[0].id, value: "12.5" }),
    ]));
    expect(await db.attributeField.findUnique({ where: { id: third.body.attributeSet.fields[0].id } })).not.toBeNull();
  });

  it("rejects a merge when a product has both definitions", async () => {
    const shared = await request(app.server).post("/api/v1/attributes").set(unsafeHeaders(admin)).send({ name: { en: "Material" } });
    const set = await request(app.server).post("/api/v1/attribute-sets").set(unsafeHeaders(admin)).send({
      name: { en: "Set" }, fields: [{ name: { en: "Material" }, dataType: "text" }],
    });
    const fieldId = set.body.attributeSet.fields[0].id as string;
    const product = await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`).set(unsafeHeaders(admin)).send({
      name: { en: "Example" }, supplierSku: "P1", cost: "1", currency: "USD", minQuantity: 1,
      attributeSetId: set.body.attributeSet.id, attributeValues: [{ fieldId, value: "Steel" }],
      directAttributeValues: [{ fieldId: shared.body.attribute.id, value: "Wood" }],
    });
    expect(product.status).toBe(201);
    const result = await request(app.server).post(`/api/v1/attribute-sets/${set.body.attributeSet.id}/fields/${fieldId}/share`)
      .set(unsafeHeaders(admin)).send({ attributeId: shared.body.attribute.id });
    expect(result.status).toBe(409);
    expect(await db.productAttributeValue.count({ where: { productId: product.body.product.id } })).toBe(2);
    expect(await db.attributeField.findUnique({ where: { id: fieldId } })).not.toBeNull();
  });

  it("creates a reusable attribute and set membership atomically", async () => {
    const set = await request(app.server).post("/api/v1/attribute-sets").set(unsafeHeaders(admin)).send({ name: { en: "Hardware" } });
    const setId = set.body.attributeSet.id as string;
    const url = `/api/v1/attribute-sets/${setId}/shared-fields/create`;
    const input = { name: { en: "Colour" }, dataType: "select", isRequired: true, options: [{ en: "Red" }] };
    expect((await request(app.server).post(url).set(unsafeHeaders(reader)).send(input)).status).toBe(403);
    expect((await request(app.server).post(url).set(unsafeHeaders(admin)).send({ ...input, options: [] })).status).toBe(400);
    expect(await db.attributeField.count()).toBe(0);
    const created = await request(app.server).post(url).set(unsafeHeaders(admin)).send(input);
    expect(created.status).toBe(201);
    const field = created.body.attributeSet.fields[0];
    expect(field).toMatchObject({ name: { en: "Colour" }, shared: true, isRequired: true, dataType: "select" });
    const list = await request(app.server).get("/api/v1/attributes").set("Cookie", reader);
    expect(list.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: field.id })]));
    expect((await request(app.server).post(url).set(unsafeHeaders(admin)).send(input)).status).toBe(409);
    expect(await db.attributeField.count()).toBe(1);
    expect(await db.attributeSetField.count()).toBe(1);
  });

  it("shares one typed attribute across sets and preserves values when a membership is archived", async () => {
    const attribute = await request(app.server).post("/api/v1/attributes").set(unsafeHeaders(admin)).send({
      name: { en: "Finish" }, dataType: "select", options: [{ en: "Matte" }, { en: "Gloss" }],
    });
    const fieldId = attribute.body.attribute.id as string;
    const optionId = attribute.body.attribute.options[0].id as string;
    const first = await request(app.server).post("/api/v1/attribute-sets").set(unsafeHeaders(admin)).send({
      name: { en: "First" }, fields: [{ name: { en: "Legacy" }, dataType: "text" }],
    });
    const second = await request(app.server).post("/api/v1/attribute-sets").set(unsafeHeaders(admin)).send({ name: { en: "Second" } });
    const firstId = first.body.attributeSet.id as string;
    const secondId = second.body.attributeSet.id as string;
    const url = `/api/v1/attribute-sets/${firstId}/shared-fields`;
    expect((await request(app.server).post(url).set(unsafeHeaders()).send({ attributeId: fieldId })).status).toBe(401);
    expect((await request(app.server).post(url).set(unsafeHeaders(reader)).send({ attributeId: fieldId })).status).toBe(403);
    expect((await request(app.server).post(url).set(unsafeHeaders(admin)).send({ attributeId: "invalid" })).status).toBe(400);
    const added = await request(app.server).post(url).set(unsafeHeaders(admin)).send({ attributeId: fieldId, isRequired: true });
    expect(added.status).toBe(201);
    expect(added.body.attributeSet.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fieldId, shared: true, isRequired: true, options: [expect.objectContaining({ id: optionId }) , expect.anything()] }),
    ]));
    expect((await request(app.server).post(url).set(unsafeHeaders(admin)).send({ attributeId: fieldId })).status).toBe(409);
    expect((await request(app.server).post(`/api/v1/attribute-sets/${secondId}/shared-fields`).set(unsafeHeaders(admin))
      .send({ attributeId: fieldId, isRequired: false })).status).toBe(201);
    const body = { name: { en: "Example", fr: "Example" }, supplierSku: "S1", cost: "1", currency: "USD", minQuantity: 1, attributeSetId: firstId };
    expect((await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`).set(unsafeHeaders(admin)).send(body)).status).toBe(400);
    const created = await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`).set(unsafeHeaders(admin))
      .send({ ...body, attributeValues: [{ fieldId, value: optionId }] });
    expect(created.status).toBe(201);
    const productId = created.body.product.id as string;
    expect((await request(app.server).put(`/api/v1/products/${productId}`).set(unsafeHeaders(admin))
      .send({ ...body, attributeValues: [{ fieldId, value: optionId }], directAttributeValues: [{ fieldId, value: optionId }] })).status).toBe(400);
    const updated = await request(app.server).put(`/api/v1/products/${productId}`).set(unsafeHeaders(admin))
      .send({ ...body, attributeValues: [{ fieldId, value: optionId }], directAttributeValues: [] });
    expect(updated.status).toBe(200);
    expect(updated.body.product.attributeValues).toEqual(expect.arrayContaining([expect.objectContaining({ fieldId, value: optionId })]));
    expect((await request(app.server).delete(`/api/v1/attributes/${fieldId}`).set(unsafeHeaders(admin))).status).toBe(409);
    const removed = await request(app.server).delete(`/api/v1/attribute-sets/${firstId}/fields/${fieldId}`).set(unsafeHeaders(admin));
    expect(removed.status).toBe(200);
    expect(removed.body.result).toBe("archived");
    const detail = await request(app.server).get(`/api/v1/products/${productId}`).set("Cookie", reader);
    expect(detail.body.product.attributeValues).toEqual(expect.arrayContaining([expect.objectContaining({ fieldId, value: optionId, isArchived: true })]));
    const edit = await request(app.server).put(`/api/v1/products/${productId}`).set(unsafeHeaders(admin))
      .send({ ...body, attributeValues: [], directAttributeValues: [] });
    expect(edit.status).toBe(200);
    expect(edit.body.product.attributeValues).toEqual(expect.arrayContaining([expect.objectContaining({ fieldId, value: optionId, isArchived: true })]));
    const other = await request(app.server).get(`/api/v1/attribute-sets/${secondId}`).set("Cookie", reader);
    expect(other.body.attributeSet.fields).toEqual(expect.arrayContaining([expect.objectContaining({ id: fieldId, isArchived: false })]));
    expect(await db.auditLog.count({ where: { entityId: firstId, action: "ATTRIBUTE_FIELD_CREATE" } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: firstId, action: "ATTRIBUTE_FIELD_ARCHIVE" } })).toBe(1);
  });

  it("creates typed attributes and validates, stores and reads direct values", async () => {
    const url = "/api/v1/attributes";
    expect((await request(app.server).post(url).set(unsafeHeaders(admin)).send({ name: { en: "Empty select" }, dataType: "select" })).status).toBe(400);
    expect((await request(app.server).post(url).set(unsafeHeaders(admin)).send({ name: { en: "Bad options" }, dataType: "text", options: [{ en: "One" }] })).status).toBe(400);
    expect((await request(app.server).post(url).set(unsafeHeaders(admin)).send({ name: { en: "Duplicate options" }, dataType: "select", options: [{ en: "One" }, { en: "one" }] })).status).toBe(400);
    const definitions = [
      { name: "Length", dataType: "number", value: "12", expected: 12, invalid: "1.5" },
      { name: "Weight", dataType: "decimal", value: "12.3456", expected: "12.3456", invalid: "1.23456" },
      { name: "Available", dataType: "boolean", value: false, expected: false, invalid: "false" },
      { name: "Date", dataType: "date", value: "2026-02-28", expected: "2026-02-28", invalid: "2026-02-30" },
    ];
    const values: { fieldId: string; value: string | boolean }[] = [];
    for (const definition of definitions) {
      const created = await request(app.server).post(url).set(unsafeHeaders(admin)).send({
        name: { en: definition.name }, dataType: definition.dataType, unit: definition.dataType === "number" ? "mm" : null,
      });
      expect(created.status).toBe(201);
      values.push({ fieldId: created.body.attribute.id, value: definition.value });
    }
    const select = await request(app.server).post(url).set(unsafeHeaders(admin)).send({
      name: { en: "Finish" }, dataType: "select", options: [{ en: "Matte", fr: "Mat" }, { en: "Gloss" }],
    });
    expect(select.status).toBe(201);
    const optionId = select.body.attribute.options[0].id as string;
    values.push({ fieldId: select.body.attribute.id, value: optionId });
    const body = { name: { en: "Example", fr: "Example" }, supplierSku: "TYPED", cost: "1", currency: "USD", minQuantity: 1 };
    for (const [index, definition] of definitions.entries()) {
      const invalid = await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`).set(unsafeHeaders(admin))
        .send({ ...body, directAttributeValues: [{ fieldId: values[index]!.fieldId, value: definition.invalid }] });
      expect(invalid.status).toBe(400);
    }
    const invalidSelect = await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`).set(unsafeHeaders(admin))
      .send({ ...body, directAttributeValues: [{ fieldId: select.body.attribute.id, value: "Matte" }] });
    expect(invalidSelect.status).toBe(400);
    const createdProduct = await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`).set(unsafeHeaders(admin))
      .send({ ...body, directAttributeValues: values });
    expect(createdProduct.status).toBe(201);
    for (const [index, definition] of definitions.entries()) {
      expect(createdProduct.body.product.attributeValues).toEqual(expect.arrayContaining([
        expect.objectContaining({ fieldId: values[index]!.fieldId, value: definition.expected }),
      ]));
    }
    expect(createdProduct.body.product.attributeValues).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldId: select.body.attribute.id, value: optionId, optionLabel: { en: "Matte", fr: "Mat" } }),
    ]));
    const updatedProduct = await request(app.server).put(`/api/v1/products/${createdProduct.body.product.id}`).set(unsafeHeaders(admin))
      .send({ ...body, directAttributeValues: values });
    expect(updatedProduct.status).toBe(200);
    expect(updatedProduct.body.product.attributeValues).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldId: values[2]!.fieldId, value: false }),
      expect.objectContaining({ fieldId: select.body.attribute.id, value: optionId }),
    ]));
    expect((await request(app.server).put(`${url}/${select.body.attribute.id}`).set(unsafeHeaders(admin)).send({
      name: { en: "Finish", fr: "Finish" }, dataType: "text",
    })).status).toBe(400);
    const beforeArchive = await request(app.server).get(url).set("Cookie", reader);
    expect(beforeArchive.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: select.body.attribute.id, dataType: "select", hasValues: true, options: expect.arrayContaining([expect.objectContaining({ id: optionId, label: { en: "Matte", fr: "Mat" } })]) }),
    ]));
    expect((await request(app.server).delete(`${url}/${select.body.attribute.id}`).set(unsafeHeaders(admin))).body.result).toBe("archived");
    expect(await db.productAttributeValue.findFirst({ where: { attributeFieldId: select.body.attribute.id } })).toMatchObject({ optionId });
    const listed = await request(app.server).get(url).set("Cookie", reader);
    expect(listed.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: values[0]!.fieldId, dataType: "number", hasValues: true, unit: "mm" }),
    ]));
    expect(listed.body.items.find((item: { id: string }) => item.id === select.body.attribute.id)).toBeUndefined();
    expect(await db.auditLog.count({ where: { action: "ATTRIBUTE_FIELD_CREATE" } })).toBe(5);
  });
});

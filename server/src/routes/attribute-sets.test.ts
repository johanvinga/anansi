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

interface FieldDto {
  id: string;
  name: string;
  code: string;
  dataType: string;
  isArchived: boolean;
  hasValues: boolean;
  sortOrder: number;
  options: { id: string; label: string }[];
}

describe("attribute sets", () => {
  let db: Database;
  let app: FastifyInstance;
  let adminCookie: string;
  let readerCookie: string;

  beforeAll(async () => {
    db = createTestDatabase();
    app = await createTestApp(db);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await seedUser(db, ADMIN, "admin");
    await seedUser(db, READER, "standard");
    adminCookie = await loginCookie(app, ADMIN);
    readerCookie = await loginCookie(app, READER);
  });

  const admin = (method: "post" | "put" | "delete", path: string, body?: object) =>
    request(app.server)[method](`/api/v1${path}`).set(unsafeHeaders(adminCookie)).send(body);

  async function createSet(name = "MDF Panel"): Promise<string> {
    const res = await admin("post", "/attribute-sets", { name });
    expect(res.status).toBe(201);
    return res.body.attributeSet.id as string;
  }

  async function addField(setId: string, body: object): Promise<FieldDto[]> {
    const res = await admin("post", `/attribute-sets/${setId}/fields`, body);
    expect(res.status).toBe(201);
    return res.body.attributeSet.fields as FieldDto[];
  }

  /** Creates a product with a value for the given field, so the field "has values". */
  async function useField(setId: string, fieldId: string, value: string | number | boolean) {
    const supplier = await admin("post", "/suppliers", { name: `Supplier ${Math.random()}` });
    const res = await admin("post", `/suppliers/${supplier.body.supplier.id}/products`, {
      name: "Panel",
      supplierSku: `SKU-${Math.random()}`,
      minQuantity: 1,
      cost: "10.00",
      currency: "USD",
      attributeSetId: setId,
      attributeValues: [{ fieldId, value }],
    });
    expect(res.status).toBe(201);
  }

  describe("FR-ATS-01/02 sets", () => {
    it("creates, lists, views, and renames a set, auditing each write", async () => {
      const id = await createSet();
      const renamed = await admin("put", `/attribute-sets/${id}`, { name: "MDF Board" });
      expect(renamed.status).toBe(200);
      expect(renamed.body.attributeSet.name).toBe("MDF Board");

      const list = await request(app.server).get("/api/v1/attribute-sets").set("Cookie", readerCookie);
      expect(list.status).toBe(200);
      expect(list.body.items).toEqual([expect.objectContaining({ id, name: "MDF Board", fieldCount: 0, productCount: 0 })]);

      const detail = await request(app.server).get(`/api/v1/attribute-sets/${id}`).set("Cookie", readerCookie);
      expect(detail.status).toBe(200);
      expect(detail.body.attributeSet.fields).toEqual([]);

      expect(await db.auditLog.count({ where: { action: "ATTRIBUTE_SET_CREATE" } })).toBe(1);
      const update = await db.auditLog.findFirstOrThrow({ where: { action: "ATTRIBUTE_SET_UPDATE" } });
      expect(update.changes).toMatchObject({ name: { before: "MDF Panel", after: "MDF Board" } });
      expect(await db.auditLog.count({ where: { action: "ATTRIBUTE_SET_VIEW" } })).toBe(1);
    });

    it("rejects duplicate names case-insensitively", async () => {
      await createSet("Paint");
      const res = await admin("post", "/attribute-sets", { name: "PAINT" });
      expect(res.status).toBe(409);
    });

    it("validates the name", async () => {
      const res = await admin("post", "/attribute-sets", { name: "  " });
      expect(res.status).toBe(400);
    });

    it("returns 403 to standard users for every write", async () => {
      const id = await createSet();
      const responses = await Promise.all([
        request(app.server).post("/api/v1/attribute-sets").set(unsafeHeaders(readerCookie)).send({ name: "X" }),
        request(app.server).put(`/api/v1/attribute-sets/${id}`).set(unsafeHeaders(readerCookie)).send({ name: "X" }),
        request(app.server).delete(`/api/v1/attribute-sets/${id}`).set(unsafeHeaders(readerCookie)),
        request(app.server)
          .post(`/api/v1/attribute-sets/${id}/fields`)
          .set(unsafeHeaders(readerCookie))
          .send({ name: "W", dataType: "text" }),
        request(app.server)
          .post(`/api/v1/attribute-sets/${id}/fields/reorder`)
          .set(unsafeHeaders(readerCookie))
          .send({ fieldIds: [NIL_UUID] }),
      ]);
      for (const res of responses) expect(res.status).toBe(403);
    });

    it("returns 401 without a session and 404 for unknown sets", async () => {
      expect((await request(app.server).get("/api/v1/attribute-sets")).status).toBe(401);
      const missing = await request(app.server).get(`/api/v1/attribute-sets/${NIL_UUID}`).set("Cookie", readerCookie);
      expect(missing.status).toBe(404);
    });
  });

  describe("FR-ATS-10 deleting sets", () => {
    it("deletes an unused set together with its fields", async () => {
      const id = await createSet();
      await addField(id, { name: "Width", dataType: "number", unit: "mm" });
      const res = await admin("delete", `/attribute-sets/${id}`);
      expect(res.status).toBe(204);
      expect(await db.attributeField.count()).toBe(0);
      expect(await db.auditLog.count({ where: { action: "ATTRIBUTE_SET_DELETE" } })).toBe(1);
    });

    it("blocks deletion while products reference the set", async () => {
      const id = await createSet();
      const [width] = await addField(id, { name: "Width", dataType: "number" });
      await useField(id, width!.id, 100);
      const res = await admin("delete", `/attribute-sets/${id}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CONFLICT");
    });
  });

  describe("FR-ATS-03/04/05 adding fields", () => {
    it("adds fields of every type with generated, unique codes and increasing sort order", async () => {
      const id = await createSet();
      await addField(id, { name: "Width", dataType: "number", unit: "mm", isRequired: true });
      await addField(id, { name: "Width", dataType: "decimal" });
      await addField(id, { name: "In stock", dataType: "boolean" });
      await addField(id, { name: "Released", dataType: "date" });
      await addField(id, { name: "Notes", dataType: "text" });
      const fields = await addField(id, { name: "Texture", dataType: "select", options: ["matte", "satin", "gloss"] });

      expect(fields.map((f) => f.code)).toEqual(["width", "width_2", "in_stock", "released", "notes", "texture"]);
      expect(fields.map((f) => f.sortOrder)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(fields[0]).toMatchObject({ dataType: "number", isRequired: true, hasValues: false });
      expect(fields[5]?.options.map((o) => o.label)).toEqual(["matte", "satin", "gloss"]);
      expect(await db.auditLog.count({ where: { action: "ATTRIBUTE_FIELD_CREATE" } })).toBe(6);
    });

    it("requires options for select fields and rejects them for other types", async () => {
      const id = await createSet();
      const noOptions = await admin("post", `/attribute-sets/${id}/fields`, { name: "Texture", dataType: "select" });
      expect(noOptions.status).toBe(400);
      expect(noOptions.body.error.details[0].field).toBe("options");

      const extra = await admin("post", `/attribute-sets/${id}/fields`, { name: "W", dataType: "text", options: ["a"] });
      expect(extra.status).toBe(400);

      const dupes = await admin("post", `/attribute-sets/${id}/fields`, { name: "T", dataType: "select", options: ["a", "A"] });
      expect(dupes.status).toBe(400);
    });

    it("rejects unknown data types and over-long units", async () => {
      const id = await createSet();
      expect((await admin("post", `/attribute-sets/${id}/fields`, { name: "X", dataType: "currency" })).status).toBe(400);
      expect(
        (await admin("post", `/attribute-sets/${id}/fields`, { name: "X", dataType: "text", unit: "x".repeat(21) })).status,
      ).toBe(400);
    });
  });

  describe("FR-ATS-06/07 editing fields", () => {
    it("edits name, unit, required flag, and options, auditing the changes", async () => {
      const id = await createSet();
      const [texture] = await addField(id, { name: "Texture", dataType: "select", options: ["matte", "satin"] });
      const matte = texture!.options[0]!;

      const res = await admin("put", `/attribute-sets/${id}/fields/${texture!.id}`, {
        name: "Surface",
        unit: "n/a",
        isRequired: true,
        options: [{ id: matte.id, label: "Matte" }, { label: "gloss" }],
      });
      expect(res.status).toBe(200);
      const field = res.body.attributeSet.fields[0] as FieldDto & { unit: string; isRequired: boolean };
      expect(field).toMatchObject({ name: "Surface", unit: "n/a", isRequired: true, code: "texture" });
      expect(field.options.map((o) => o.label)).toEqual(["Matte", "gloss"]);
      expect(field.options[0]?.id).toBe(matte.id);

      const audit = await db.auditLog.findFirstOrThrow({ where: { action: "ATTRIBUTE_FIELD_UPDATE" } });
      expect(audit.changes).toMatchObject({
        name: { before: "Texture", after: "Surface" },
        options: { before: ["matte", "satin"], after: ["Matte", "gloss"] },
      });
    });

    it("allows swapping two option labels", async () => {
      const id = await createSet();
      const [field] = await addField(id, { name: "T", dataType: "select", options: ["a", "b"] });
      const [a, b] = field!.options;
      const res = await admin("put", `/attribute-sets/${id}/fields/${field!.id}`, {
        options: [{ id: a!.id, label: "b" }, { id: b!.id, label: "a" }],
      });
      expect(res.status).toBe(200);
    });

    it("allows changing the data type while no product has values", async () => {
      const id = await createSet();
      const [field] = await addField(id, { name: "Width", dataType: "text" });
      const res = await admin("put", `/attribute-sets/${id}/fields/${field!.id}`, { dataType: "number" });
      expect(res.status).toBe(200);
      expect(res.body.attributeSet.fields[0].dataType).toBe("number");
    });

    it("blocks data type changes once products have values (FR-ATS-07)", async () => {
      const id = await createSet();
      const [field] = await addField(id, { name: "Width", dataType: "number" });
      await useField(id, field!.id, 1200);

      const res = await admin("put", `/attribute-sets/${id}/fields/${field!.id}`, { dataType: "text" });
      expect(res.status).toBe(409);

      const detail = await request(app.server).get(`/api/v1/attribute-sets/${id}`).set("Cookie", adminCookie);
      expect(detail.body.attributeSet.fields[0].hasValues).toBe(true);
    });

    it("refuses to remove an option that products use", async () => {
      const id = await createSet();
      const [field] = await addField(id, { name: "T", dataType: "select", options: ["matte", "gloss"] });
      const [matte, gloss] = field!.options;
      await useField(id, field!.id, matte!.id);

      const res = await admin("put", `/attribute-sets/${id}/fields/${field!.id}`, { options: [{ id: gloss!.id, label: "gloss" }] });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain("matte");
    });

    it("rejects an empty update and returns 404 for fields of another set", async () => {
      const id = await createSet();
      const other = await createSet("Other");
      const [field] = await addField(other, { name: "W", dataType: "text" });
      expect((await admin("put", `/attribute-sets/${id}/fields/${field!.id}`, {})).status).toBe(400);
      expect((await admin("put", `/attribute-sets/${id}/fields/${field!.id}`, { name: "X" })).status).toBe(404);
    });
  });

  describe("FR-ATS-08 reordering", () => {
    it("reorders fields and audits the new order", async () => {
      const id = await createSet();
      await addField(id, { name: "Width", dataType: "number" });
      await addField(id, { name: "Length", dataType: "number" });
      const fields = await addField(id, { name: "Thickness", dataType: "number" });
      const reversed = [...fields].reverse().map((f) => f.id);

      const res = await admin("post", `/attribute-sets/${id}/fields/reorder`, { fieldIds: reversed });
      expect(res.status).toBe(200);
      expect(res.body.attributeSet.fields.map((f: FieldDto) => f.code)).toEqual(["thickness", "length", "width"]);

      const audit = await db.auditLog.findFirstOrThrow({ where: { action: "ATTRIBUTE_FIELD_REORDER" } });
      expect(audit.changes).toMatchObject({ order: { after: ["thickness", "length", "width"] } });
    });

    it("rejects lists that omit, duplicate, or add fields", async () => {
      const id = await createSet();
      await addField(id, { name: "A", dataType: "text" });
      const fields = await addField(id, { name: "B", dataType: "text" });
      const [a, b] = fields.map((f) => f.id);
      for (const fieldIds of [[a], [a, a], [a, b, NIL_UUID]]) {
        const res = await admin("post", `/attribute-sets/${id}/fields/reorder`, { fieldIds });
        expect(res.status).toBe(400);
      }
    });
  });

  describe("FR-ATS-09 removing fields", () => {
    it("deletes a field without values", async () => {
      const id = await createSet();
      const [field] = await addField(id, { name: "Width", dataType: "number" });
      const res = await admin("delete", `/attribute-sets/${id}/fields/${field!.id}`);
      expect(res.status).toBe(200);
      expect(res.body.result).toBe("deleted");
      expect(res.body.attributeSet.fields).toEqual([]);
      expect(await db.auditLog.count({ where: { action: "ATTRIBUTE_FIELD_DELETE" } })).toBe(1);
    });

    it("archives a field with values, keeps the values, and blocks further edits", async () => {
      const id = await createSet();
      const [field] = await addField(id, { name: "Width", dataType: "number" });
      await useField(id, field!.id, 1200);

      const res = await admin("delete", `/attribute-sets/${id}/fields/${field!.id}`);
      expect(res.status).toBe(200);
      expect(res.body.result).toBe("archived");
      expect(res.body.attributeSet.fields[0].isArchived).toBe(true);
      expect(await db.productAttributeValue.count()).toBe(1);
      expect(await db.auditLog.count({ where: { action: "ATTRIBUTE_FIELD_ARCHIVE" } })).toBe(1);

      const list = await request(app.server).get("/api/v1/attribute-sets").set("Cookie", adminCookie);
      expect(list.body.items[0].fieldCount).toBe(0);

      const edit = await admin("put", `/attribute-sets/${id}/fields/${field!.id}`, { name: "W" });
      expect(edit.status).toBe(409);
    });
  });
});

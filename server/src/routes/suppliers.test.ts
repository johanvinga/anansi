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
const translated = (value: string) => ({ en: value, fr: value });

describe("suppliers and tags", () => {
  let db: Database;
  let app: FastifyInstance;
  let adminCookie: string;
  let readerCookie: string;

  beforeAll(async () => {
    db = createTestDatabase();
    app = await createTestApp(db);
    describe("tag management", () => {
      it("creates, lists, renames, and archives tags", async () => {
        const created = await request(app.server)
          .post("/api/v1/tags")
          .set(unsafeHeaders(adminCookie))
          .send({ name: { en: "Paint", fr: "Peinture" } });
        expect(created.status).toBe(201);
        const tagId = created.body.tag.id as string;

        const duplicate = await request(app.server)
          .post("/api/v1/tags")
          .set(unsafeHeaders(adminCookie))
          .send({ name: { en: "paint", fr: "Peinture" } });
        expect(duplicate.status).toBe(409);

        const renamed = await request(app.server)
          .put(`/api/v1/tags/${tagId}`)
          .set(unsafeHeaders(adminCookie))
          .send({ name: { en: "Wall Paint", fr: "Peinture murale" } });
        expect(renamed.status).toBe(200);

        const archived = await request(app.server)
          .put(`/api/v1/tags/${tagId}`)
          .set(unsafeHeaders(adminCookie))
          .send({ isArchived: true });
        expect(archived.status).toBe(200);
        expect(archived.body.tag.isArchived).toBe(true);

        const list = await request(app.server).get("/api/v1/tags").set("Cookie", readerCookie);
        expect(list.status).toBe(200);
        expect(list.body.items).toEqual([]);
      });

      it("rejects tag writes for standard users", async () => {
        const res = await request(app.server)
          .post("/api/v1/tags")
          .set(unsafeHeaders(readerCookie))
          .send({ name: { en: "Nope", fr: "Non" } });
        expect(res.status).toBe(403);
      });
    });

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

  async function createSupplier(body: Record<string, unknown>) {
    return request(app.server)
      .post("/api/v1/suppliers")
      .set(unsafeHeaders(adminCookie))
      .send(body);
  }

  describe("FR-SUP-01 create supplier", () => {
    it("creates a supplier with address and categories, and audits the creation", async () => {
      const res = await createSupplier({
        name: "  Acme Panels  ",
        street: "1 Main St",
        city: "Springfield",
        stateRegion: "IL",
        postalCode: "62701",
        country: "USA",
        tags: [],
      });

      expect(res.status).toBe(201);
      expect(res.body.supplier.name).toBe("Acme Panels");
      expect(res.body.supplier.city).toBe("Springfield");

      const audit = await db.auditLog.findFirst({
        where: { action: "SUPPLIER_CREATE", entityId: res.body.supplier.id },
      });
      expect(audit?.actorEmail).toBe(ADMIN.email);
      expect(audit?.changes).toMatchObject({ name: { before: null, after: "Acme Panels" } });
    });

    it("creates a supplier with only a name", async () => {
      const res = await createSupplier({ name: "Solo Supplies" });
      expect(res.status).toBe(201);
      expect(res.body.supplier.tags).toEqual([]);
      expect(res.body.supplier.street).toBeNull();
    });

    it("returns 400 when the name is missing or too long", async () => {
      const missing = await createSupplier({ city: "Nowhere" });
      expect(missing.status).toBe(400);
      expect(missing.body.error.details[0].field).toBe("name");

      const tooLong = await createSupplier({ name: "x".repeat(201) });
      expect(tooLong.status).toBe(400);
    });

    it("returns 403 to standard users", async () => {
      const res = await request(app.server)
        .post("/api/v1/suppliers")
        .set(unsafeHeaders(readerCookie))
        .send({ name: "Nope" });
      expect(res.status).toBe(403);
      expect(await db.supplier.count()).toBe(0);
    });

    it("returns 401 without a session", async () => {
      const res = await request(app.server)
        .post("/api/v1/suppliers")
        .set("Origin", "http://localhost:5173")
        .send({ name: "Nope" });
      expect(res.status).toBe(401);
    });
  });

  describe("FR-SUP-08 unique name (case-insensitive)", () => {
    it("returns 409 for a duplicate name that differs only by case", async () => {
      await createSupplier({ name: "Acme" });
      const res = await createSupplier({ name: "ACME" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CONFLICT");
    });

    it("returns 409 when renaming onto another supplier's name", async () => {
      await createSupplier({ name: "Alpha" });
      const beta = await createSupplier({ name: "Beta" });
      const res = await request(app.server)
        .put(`/api/v1/suppliers/${beta.body.supplier.id}`)
        .set(unsafeHeaders(adminCookie))
        .send({ name: "alpha" });
      expect(res.status).toBe(409);
    });
  });


  describe("FR-SUP-02/06/07 list with pagination, name filter, and category filter", () => {
    it("paginates and sorts by name", async () => {
      for (const name of ["Charlie", "Alpha", "Bravo"]) {
        await createSupplier({ name });
      }
      const res = await request(app.server)
        .get("/api/v1/suppliers?page=1&pageSize=2")
        .set("Cookie", readerCookie);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      expect(res.body.items.map((s: { name: string }) => s.name)).toEqual(["Alpha", "Bravo"]);
    });

    it("defaults to 25 items per page", async () => {
      const res = await request(app.server).get("/api/v1/suppliers").set("Cookie", readerCookie);
      expect(res.body.pageSize).toBe(25);
    });

    it("filters by free-text name", async () => {
      await createSupplier({ name: "Oak Timber" });
      await createSupplier({ name: "Steel Works" });
      const res = await request(app.server)
        .get("/api/v1/suppliers?q=timber")
        .set("Cookie", readerCookie);
      expect(res.body.items.map((s: { name: string }) => s.name)).toEqual(["Oak Timber"]);
    });

    it("filters by one tag id", async () => {
      const woodTag = await db.tag.create({ data: { nameEn: "Wood", nameFr: "Bois", nameKey: "wood" } });
      const metalTag = await db.tag.create({ data: { nameEn: "Metal", nameFr: "Métal", nameKey: "metal" } });
      const wood = await createSupplier({ name: "Woodco", tags: [woodTag.id] });
      await createSupplier({ name: "Metalco", tags: [metalTag.id] });
      const res = await request(app.server)
        .get(`/api/v1/suppliers?tag=${woodTag.id}`)
        .set("Cookie", readerCookie);
      expect(res.body.items.map((s: { name: string }) => s.name)).toEqual(["Woodco"]);
    });

    it("matches suppliers having any of several tag ids", async () => {
      const woodTag = await db.tag.create({ data: { nameEn: "Wood", nameFr: "Bois", nameKey: "wood" } });
      const metalTag = await db.tag.create({ data: { nameEn: "Metal", nameFr: "Métal", nameKey: "metal" } });
      await db.tag.create({ data: { nameEn: "Glass", nameFr: "Verre", nameKey: "glass" } });
      const a = await createSupplier({ name: "A", tags: [woodTag.id] });
      const b = await createSupplier({ name: "B", tags: [metalTag.id] });
      await createSupplier({ name: "C" });
      const res = await request(app.server)
        .get(`/api/v1/suppliers?tag=${woodTag.id}&tag=${metalTag.id}`)
        .set("Cookie", readerCookie);
      expect(res.body.items.map((s: { name: string }) => s.name)).toEqual(["A", "B"]);
    });

    it("returns 400 for a malformed tag filter", async () => {
      const res = await request(app.server)
        .get("/api/v1/suppliers?tag=not-a-uuid")
        .set("Cookie", readerCookie);
      expect(res.status).toBe(400);
    });

    it("records a list view in the audit log", async () => {
      await request(app.server).get("/api/v1/suppliers").set("Cookie", readerCookie);
      expect(await db.auditLog.count({ where: { action: "SUPPLIER_LIST" } })).toBe(1);
    });
  });

  describe("FR-SUP-03 view supplier", () => {
    it("returns details including tags and audits the view", async () => {
      const tag = await db.tag.create({ data: { nameEn: "Tools", nameFr: "Outils", nameKey: "tools" } });
      const created = await createSupplier({ name: "Detail", city: "Austin", tags: [tag.id] });
      const res = await request(app.server)
        .get(`/api/v1/suppliers/${created.body.supplier.id}`)
        .set("Cookie", readerCookie);

      expect(res.status).toBe(200);
      expect(res.body.supplier.city).toBe("Austin");
      expect(res.body.supplier.tags[0].name).toEqual({ en: "Tools", fr: "Outils" });
      expect(await db.auditLog.count({ where: { action: "SUPPLIER_VIEW" } })).toBe(1);
    });

    it("returns 404 for an unknown supplier", async () => {
      const res = await request(app.server).get(`/api/v1/suppliers/${NIL_UUID}`).set("Cookie", readerCookie);
      expect(res.status).toBe(404);
    });

    it("returns 400 for a malformed id", async () => {
      const res = await request(app.server).get("/api/v1/suppliers/abc").set("Cookie", readerCookie);
      expect(res.status).toBe(400);
    });
  });

  describe("FR-SUP-04 edit supplier", () => {
    it("updates fields and replaces tags when provided, auditing before and after", async () => {
      const tagA = await db.tag.create({ data: { nameEn: "A", nameFr: "A", nameKey: "a" } });
      const tagB = await db.tag.create({ data: { nameEn: "B", nameFr: "B", nameKey: "b" } });
      const created = await createSupplier({ name: "Old Name", city: "Boston", tags: [tagA.id] });
      const id = created.body.supplier.id;

      const res = await request(app.server)
        .put(`/api/v1/suppliers/${id}`)
        .set(unsafeHeaders(adminCookie))
        .send({ name: "New Name", city: "Denver", tags: [tagB.id] });

      expect(res.status).toBe(200);
      expect(res.body.supplier.name).toBe("New Name");
      expect(res.body.supplier.tags.map((tag: { name: { en: string } }) => tag.name.en)).toEqual(["B"]);

      const audit = await db.auditLog.findFirstOrThrow({ where: { action: "SUPPLIER_UPDATE", entityId: id } });
      expect(audit.changes).toMatchObject({
        name: { before: "Old Name", after: "New Name" },
        city: { before: "Boston", after: "Denver" },
      });
    });

    it("keeps existing tags when the tags field is omitted", async () => {
      const tag = await db.tag.create({ data: { nameEn: "Keep", nameFr: "Garder", nameKey: "keep" } });
      const created = await createSupplier({ name: "Keeper", tags: [tag.id] });
      const res = await request(app.server)
        .put(`/api/v1/suppliers/${created.body.supplier.id}`)
        .set(unsafeHeaders(adminCookie))
        .send({ name: "Keeper Renamed" });
      expect(res.body.supplier.tags.map((item: { name: { en: string } }) => item.name.en)).toEqual(["Keep"]);
    });

    it("writes no audit entry when nothing changed", async () => {
      const created = await createSupplier({ name: "Same" });
      await request(app.server)
        .put(`/api/v1/suppliers/${created.body.supplier.id}`)
        .set(unsafeHeaders(adminCookie))
        .send({ name: "Same" });
      expect(await db.auditLog.count({ where: { action: "SUPPLIER_UPDATE" } })).toBe(0);
    });

    it("returns 403 to standard users and 404 for unknown ids", async () => {
      const created = await createSupplier({ name: "Locked" });
      const denied = await request(app.server)
        .put(`/api/v1/suppliers/${created.body.supplier.id}`)
        .set(unsafeHeaders(readerCookie))
        .send({ name: "Hacked" });
      expect(denied.status).toBe(403);

      const missing = await request(app.server)
        .put(`/api/v1/suppliers/${NIL_UUID}`)
        .set(unsafeHeaders(adminCookie))
        .send({ name: "Missing" });
      expect(missing.status).toBe(404);
    });
  });

  describe("FR-SUP-05 delete supplier", () => {
    it("deletes the supplier and audits the deletion", async () => {
      const created = await createSupplier({ name: "Doomed" });
      const id = created.body.supplier.id;
      const res = await request(app.server)
        .delete(`/api/v1/suppliers/${id}`)
        .set(unsafeHeaders(adminCookie));

      expect(res.status).toBe(204);
      expect(await db.supplier.findUnique({ where: { id } })).toBeNull();
      expect(await db.auditLog.count({ where: { action: "SUPPLIER_DELETE", entityId: id } })).toBe(1);
    });

    it("returns 403 to standard users", async () => {
      const created = await createSupplier({ name: "Safe" });
      const res = await request(app.server)
        .delete(`/api/v1/suppliers/${created.body.supplier.id}`)
        .set(unsafeHeaders(readerCookie));
      expect(res.status).toBe(403);
    });

    it("returns 404 for an unknown supplier", async () => {
      const res = await request(app.server)
        .delete(`/api/v1/suppliers/${NIL_UUID}`)
        .set(unsafeHeaders(adminCookie));
      expect(res.status).toBe(404);
    });
  });

});

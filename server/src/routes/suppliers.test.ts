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

describe("suppliers and categories", () => {
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
        categories: [{ name: "Wood" }],
      });

      expect(res.status).toBe(201);
      expect(res.body.supplier.name).toBe("Acme Panels");
      expect(res.body.supplier.city).toBe("Springfield");
      expect(res.body.supplier.categories).toEqual([expect.objectContaining({ name: "Wood" })]);

      const audit = await db.auditLog.findFirst({
        where: { action: "SUPPLIER_CREATE", entityId: res.body.supplier.id },
      });
      expect(audit?.actorEmail).toBe(ADMIN.email);
      expect(audit?.changes).toMatchObject({ name: { before: null, after: "Acme Panels" } });
    });

    it("creates a supplier with only a name", async () => {
      const res = await createSupplier({ name: "Solo Supplies" });
      expect(res.status).toBe(201);
      expect(res.body.supplier.categories).toEqual([]);
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

  describe("FR-CAT-05/06 categories on suppliers", () => {
    it("reuses an existing category by name (case-insensitive) instead of duplicating it", async () => {
      const first = await createSupplier({ name: "One", categories: [{ name: "Paint" }] });
      const second = await createSupplier({ name: "Two", categories: [{ name: "paint" }] });

      expect(first.body.supplier.categories[0].id).toBe(second.body.supplier.categories[0].id);
      expect(await db.category.count()).toBe(1);
    });

    it("links an existing category by id", async () => {
      const created = await request(app.server)
        .post("/api/v1/categories")
        .set(unsafeHeaders(adminCookie))
        .send({ name: "Glass" });
      const res = await createSupplier({
        name: "Glassworks",
        categories: [{ id: created.body.category.id }],
      });
      expect(res.body.supplier.categories[0].name).toBe("Glass");
    });

    it("returns 400 for an unknown category id", async () => {
      const res = await createSupplier({ name: "Ghost", categories: [{ id: NIL_UUID }] });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe("categories");
    });

    it("creates a category inline and audits it", async () => {
      await createSupplier({ name: "Inline", categories: [{ name: "Hardware" }] });
      expect(await db.auditLog.count({ where: { action: "CATEGORY_CREATE" } })).toBe(1);
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

    it("filters by one category id", async () => {
      const wood = await createSupplier({ name: "Woodco", categories: [{ name: "Wood" }] });
      await createSupplier({ name: "Metalco", categories: [{ name: "Metal" }] });
      const res = await request(app.server)
        .get(`/api/v1/suppliers?category=${wood.body.supplier.categories[0].id}`)
        .set("Cookie", readerCookie);
      expect(res.body.items.map((s: { name: string }) => s.name)).toEqual(["Woodco"]);
    });

    it("matches suppliers having any of several category ids", async () => {
      const a = await createSupplier({ name: "A", categories: [{ name: "Wood" }] });
      const b = await createSupplier({ name: "B", categories: [{ name: "Metal" }] });
      await createSupplier({ name: "C", categories: [{ name: "Glass" }] });
      const res = await request(app.server)
        .get(
          `/api/v1/suppliers?category=${a.body.supplier.categories[0].id}&category=${b.body.supplier.categories[0].id}`,
        )
        .set("Cookie", readerCookie);
      expect(res.body.items.map((s: { name: string }) => s.name)).toEqual(["A", "B"]);
    });

    it("returns 400 for a malformed category filter", async () => {
      const res = await request(app.server)
        .get("/api/v1/suppliers?category=not-a-uuid")
        .set("Cookie", readerCookie);
      expect(res.status).toBe(400);
    });

    it("records a list view in the audit log", async () => {
      await request(app.server).get("/api/v1/suppliers").set("Cookie", readerCookie);
      expect(await db.auditLog.count({ where: { action: "SUPPLIER_LIST" } })).toBe(1);
    });
  });

  describe("FR-SUP-03 view supplier", () => {
    it("returns details including categories and audits the view", async () => {
      const created = await createSupplier({ name: "Detail", city: "Austin", categories: [{ name: "Tools" }] });
      const res = await request(app.server)
        .get(`/api/v1/suppliers/${created.body.supplier.id}`)
        .set("Cookie", readerCookie);

      expect(res.status).toBe(200);
      expect(res.body.supplier.city).toBe("Austin");
      expect(res.body.supplier.categories[0].name).toBe("Tools");
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
    it("updates fields and replaces categories when provided, auditing before and after", async () => {
      const created = await createSupplier({ name: "Old Name", city: "Boston", categories: [{ name: "A" }] });
      const id = created.body.supplier.id;

      const res = await request(app.server)
        .put(`/api/v1/suppliers/${id}`)
        .set(unsafeHeaders(adminCookie))
        .send({ name: "New Name", city: "Denver", categories: [{ name: "B" }] });

      expect(res.status).toBe(200);
      expect(res.body.supplier.name).toBe("New Name");
      expect(res.body.supplier.categories.map((c: { name: string }) => c.name)).toEqual(["B"]);

      const audit = await db.auditLog.findFirstOrThrow({ where: { action: "SUPPLIER_UPDATE", entityId: id } });
      expect(audit.changes).toMatchObject({
        name: { before: "Old Name", after: "New Name" },
        city: { before: "Boston", after: "Denver" },
        categories: { before: ["A"], after: ["B"] },
      });
    });

    it("keeps existing categories when the categories field is omitted", async () => {
      const created = await createSupplier({ name: "Keeper", categories: [{ name: "Keep" }] });
      const res = await request(app.server)
        .put(`/api/v1/suppliers/${created.body.supplier.id}`)
        .set(unsafeHeaders(adminCookie))
        .send({ name: "Keeper Renamed" });
      expect(res.body.supplier.categories.map((c: { name: string }) => c.name)).toEqual(["Keep"]);
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

  describe("FR-CAT-01..04 category management", () => {
    it("lists categories for any signed-in user, filtered by q", async () => {
      await request(app.server).post("/api/v1/categories").set(unsafeHeaders(adminCookie)).send({ name: "Wood" });
      await request(app.server).post("/api/v1/categories").set(unsafeHeaders(adminCookie)).send({ name: "Metal" });
      const res = await request(app.server).get("/api/v1/categories?q=wo").set("Cookie", readerCookie);
      expect(res.status).toBe(200);
      expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(["Wood"]);
    });

    it("creates a category and rejects a case-insensitive duplicate", async () => {
      const first = await request(app.server)
        .post("/api/v1/categories")
        .set(unsafeHeaders(adminCookie))
        .send({ name: "Paint" });
      expect(first.status).toBe(201);

      const dupe = await request(app.server)
        .post("/api/v1/categories")
        .set(unsafeHeaders(adminCookie))
        .send({ name: "PAINT" });
      expect(dupe.status).toBe(409);
    });

    it("renames a category and audits the change", async () => {
      const created = await request(app.server)
        .post("/api/v1/categories")
        .set(unsafeHeaders(adminCookie))
        .send({ name: "Tile" });
      const res = await request(app.server)
        .put(`/api/v1/categories/${created.body.category.id}`)
        .set(unsafeHeaders(adminCookie))
        .send({ name: "Ceramic Tile" });

      expect(res.status).toBe(200);
      const audit = await db.auditLog.findFirstOrThrow({ where: { action: "CATEGORY_UPDATE" } });
      expect(audit.changes).toMatchObject({ name: { before: "Tile", after: "Ceramic Tile" } });
    });

    it("deletes a category, removes it from suppliers, and keeps the suppliers", async () => {
      const supplier = await createSupplier({ name: "Keeps Suppliers", categories: [{ name: "Temp" }] });
      const categoryId = supplier.body.supplier.categories[0].id;

      const res = await request(app.server)
        .delete(`/api/v1/categories/${categoryId}`)
        .set(unsafeHeaders(adminCookie));
      expect(res.status).toBe(204);

      const after = await request(app.server)
        .get(`/api/v1/suppliers/${supplier.body.supplier.id}`)
        .set("Cookie", readerCookie);
      expect(after.status).toBe(200);
      expect(after.body.supplier.categories).toEqual([]);
    });

    it("forbids category writes for standard users", async () => {
      const create = await request(app.server)
        .post("/api/v1/categories")
        .set(unsafeHeaders(readerCookie))
        .send({ name: "Nope" });
      expect(create.status).toBe(403);
    });

    it("returns 404 when renaming or deleting an unknown category", async () => {
      const rename = await request(app.server)
        .put(`/api/v1/categories/${NIL_UUID}`)
        .set(unsafeHeaders(adminCookie))
        .send({ name: "Ghost" });
      expect(rename.status).toBe(404);

      const remove = await request(app.server)
        .delete(`/api/v1/categories/${NIL_UUID}`)
        .set(unsafeHeaders(adminCookie));
      expect(remove.status).toBe(404);
    });
  });
});

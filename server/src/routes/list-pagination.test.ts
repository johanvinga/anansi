import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n");
const translated = (value: string) => ({ en: value, fr: value });

interface ListCase {
  name: string;
  path: () => string;
}

describe("FR-LST-02/03 optional list pagination", () => {
  let db: Database;
  let app: FastifyInstance;
  let uploadDir: string;
  let adminCookie: string;
  let readerCookie: string;
  let supplierId: string;

  beforeAll(async () => {
    db = createTestDatabase();
    uploadDir = await mkdtemp(path.join(tmpdir(), "list-pagination-"));
    app = await createTestApp(db, { uploadDir, maxUploadMb: 1 });
  });

  afterAll(async () => {
    await app.close();
    await rm(uploadDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await seedUser(db, ADMIN, "admin");
    await seedUser(db, READER, "standard");
    adminCookie = await loginCookie(app, ADMIN);
    readerCookie = await loginCookie(app, READER);

    const supplier = await request(app.server)
      .post("/api/v1/suppliers")
      .set(unsafeHeaders(adminCookie))
      .send({ name: "Paged Supplier" });
    supplierId = supplier.body.supplier.id;

    for (const name of ["Alpha", "Bravo", "Charlie"]) {
      const write = (path: string, body: object) =>
        request(app.server).post(`/api/v1${path}`).set(unsafeHeaders(adminCookie)).send(body);
      expect((await write("/tags", { name: { en: name } })).status).toBe(201);
      expect((await write("/attribute-sets", { name: translated(name) })).status).toBe(201);
      expect((await write("/attributes", { name: translated(name) })).status).toBe(201);
      const asset = await request(app.server)
        .post(`/api/v1/suppliers/${supplierId}/assets`)
        .set(unsafeHeaders(adminCookie))
        .field("title", name)
        .attach("file", PDF, { filename: `${name}.pdf`, contentType: "application/pdf" });
      expect(asset.status).toBe(201);
      const catalog = await request(app.server)
        .post(`/api/v1/suppliers/${supplierId}/catalogs`)
        .set(unsafeHeaders(adminCookie))
        .field("name", name)
        .attach("file", PDF, { filename: `${name}.pdf`, contentType: "application/pdf" });
      expect(catalog.status).toBe(201);
    }
  });

  const cases: ListCase[] = [
    { name: "tags", path: () => "/api/v1/tags" },
    { name: "attribute sets", path: () => "/api/v1/attribute-sets" },
    { name: "independent attributes", path: () => "/api/v1/attributes" },
    { name: "supplier assets", path: () => `/api/v1/suppliers/${supplierId}/assets` },
    { name: "supplier catalogs", path: () => `/api/v1/suppliers/${supplierId}/catalogs` },
  ];

  describe.each(cases)("$name", ({ path: listPath }) => {
    const get = (query: string, cookie = readerCookie) =>
      request(app.server).get(`${listPath()}${query}`).set("Cookie", cookie);

    it("returns the full list without pagination metadata when no page is requested", async () => {
      const res = await get("");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(3);
      expect(res.body).not.toHaveProperty("total");
    });

    it("returns consecutive, non-overlapping pages with totals", async () => {
      const first = await get("?page=1&pageSize=2");
      const second = await get("?page=2&pageSize=2");
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
      expect(first.body.items).toHaveLength(2);
      expect(second.body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(second.body.items).toHaveLength(1);

      const ids = [...first.body.items, ...second.body.items].map((item: { id: string }) => item.id);
      expect(new Set(ids).size).toBe(3);
    });

    it("applies the default page size when only page is given and returns an empty page past the end", async () => {
      const defaulted = await get("?page=1");
      expect(defaulted.body).toMatchObject({ total: 3, page: 1, pageSize: 25 });
      const past = await get("?page=9&pageSize=2");
      expect(past.status).toBe(200);
      expect(past.body).toMatchObject({ items: [], total: 3 });
    });

    it("rejects invalid page parameters", async () => {
      for (const query of ["?page=0", "?page=abc", "?pageSize=0", "?pageSize=101"]) {
        const res = await get(query);
        expect(res.status, query).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("requires authentication", async () => {
      const res = await request(app.server).get(`${listPath()}?page=1`);
      expect(res.status).toBe(401);
    });
  });

  describe("search", () => {
    it.each(["/api/v1/attribute-sets", "/api/v1/attributes"])("filters %s by name before paginating", async (listPath) => {
      const res = await request(app.server).get(`${listPath}?q=ARL&page=1&pageSize=5`).set("Cookie", readerCookie);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 1, page: 1, pageSize: 5 });
      expect(res.body.items).toEqual([expect.objectContaining({ name: translated("Charlie") })]);
    });
  });
});

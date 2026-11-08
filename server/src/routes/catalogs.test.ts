import { mkdtemp, readdir, rm } from "node:fs/promises";
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

const NIL_UUID = "9f1c2a4e-1111-4222-8333-444455556666";
const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n");

describe("supplier catalogs", () => {
  let db: Database;
  let app: FastifyInstance;
  let uploadDir: string;
  let adminCookie: string;
  let readerCookie: string;
  let supplierId: string;

  beforeAll(async () => {
    db = createTestDatabase();
    uploadDir = await mkdtemp(path.join(tmpdir(), "catalog-tests-"));
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
      .send({ name: "Catalog Supplier" });
    supplierId = supplier.body.supplier.id;
    await rm(uploadDir, { recursive: true, force: true });
  });

  function upload(
    cookie: string | undefined,
    buffer: Buffer,
    options: { filename?: string; contentType?: string; fields?: Record<string, string>; targetSupplierId?: string } = {},
  ) {
    const target = options.targetSupplierId ?? supplierId;
    let req = request(app.server)
      .post(`/api/v1/suppliers/${target}/catalogs`)
      .set(cookie ? unsafeHeaders(cookie) : { Origin: "http://localhost:5173" })
      .attach("file", buffer, {
        filename: options.filename ?? "price-list.pdf",
        contentType: options.contentType ?? "application/pdf",
      });
    const fields = options.fields ?? { name: "Spring Price List", version: "2026.1" };
    for (const [name, value] of Object.entries(fields)) {
      req = req.field(name, value);
    }
    return req;
  }

  async function uploadAsAdmin(fields?: Record<string, string>) {
    const res = await upload(adminCookie, PDF_BYTES, { fields });
    expect(res.status).toBe(201);
    return res.body.catalog as { id: string; updatedAt: string; createdAt: string };
  }

  async function storedFiles(): Promise<string[]> {
    try {
      return await readdir(uploadDir);
    } catch {
      return [];
    }
  }

  describe("FR-CLG-01/02/03 create catalog", () => {
    it("uploads a PDF with name and version, stores it under a generated name, and returns metadata", async () => {
      const res = await upload(adminCookie, PDF_BYTES, {
        filename: "../../Price List (2026).pdf",
      });

      expect(res.status).toBe(201);
      expect(res.body.catalog).toEqual(
        expect.objectContaining({
          supplierId,
          name: "Spring Price List",
          version: "2026.1",
          originalFileName: "Price List (2026).pdf",
          mimeType: "application/pdf",
          sizeBytes: PDF_BYTES.byteLength,
        }),
      );
      expect(res.body.catalog.updatedAt).toEqual(expect.any(String));
      const [stored] = await storedFiles();
      expect(stored).toMatch(/^[0-9a-f-]{36}\.pdf$/);
      expect(await db.auditLog.count({ where: { action: "CATALOG_UPLOAD" } })).toBe(1);
    });

    it("trims name and version", async () => {
      const res = await upload(adminCookie, PDF_BYTES, {
        fields: { name: "  Autumn  ", version: " v3 " },
      });
      expect(res.status).toBe(201);
      expect(res.body.catalog).toEqual(expect.objectContaining({ name: "Autumn", version: "v3" }));
    });

    it("returns 400 when name is missing, and allows an omitted optional version", async () => {
      const missingName = await upload(adminCookie, PDF_BYTES, { fields: { version: "1" } });
      expect(missingName.status).toBe(400);
      expect(missingName.body.error.code).toBe("VALIDATION_ERROR");
      expect(missingName.body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "name" })]),
      );
      expect(await db.catalog.count()).toBe(0);

      // Version is optional since FR-CLG-01 was relaxed (2026-11-08).
      const noVersion = await upload(adminCookie, PDF_BYTES, { fields: { name: "List" } });
      expect(noVersion.status).toBe(201);
      expect(noVersion.body.catalog).toEqual(expect.objectContaining({ version: null }));
      expect(await db.catalog.count()).toBe(1);
      expect(await storedFiles()).toHaveLength(1);
    });

    it("returns 400 when name exceeds 200 characters", async () => {
      const res = await upload(adminCookie, PDF_BYTES, { fields: { name: "x".repeat(201), version: "1" } });
      expect(res.status).toBe(400);
      expect(await db.catalog.count()).toBe(0);
    });

    it("rejects a non-PDF MIME type with 415 and stores nothing", async () => {
      const res = await upload(adminCookie, PDF_BYTES, { filename: "a.txt", contentType: "text/plain" });
      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
      expect(await storedFiles()).toEqual([]);
    });

    it("rejects a file whose content is not a PDF, even when the MIME type claims PDF", async () => {
      const res = await upload(adminCookie, Buffer.from("<html>not a pdf</html>"));
      expect(res.status).toBe(415);
      expect(await storedFiles()).toEqual([]);
      expect(await db.catalog.count()).toBe(0);
    });

    it("returns 400 when the file part is missing", async () => {
      const res = await request(app.server)
        .post(`/api/v1/suppliers/${supplierId}/catalogs`)
        .set(unsafeHeaders(adminCookie))
        .field("name", "No file")
        .field("version", "1");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 413 when the file exceeds the size limit", async () => {
      const big = Buffer.concat([PDF_BYTES, Buffer.alloc(2 * 1024 * 1024, 0x20)]);
      const res = await upload(adminCookie, big);
      expect(res.status).toBe(413);
      expect(await storedFiles()).toEqual([]);
    });

    it("returns 404 when the supplier does not exist", async () => {
      const res = await upload(adminCookie, PDF_BYTES, { targetSupplierId: NIL_UUID });
      expect(res.status).toBe(404);
      expect(await storedFiles()).toEqual([]);
    });

    it("returns 403 for a standard user and stores nothing", async () => {
      const res = await upload(readerCookie, PDF_BYTES);
      expect(res.status).toBe(403);
      expect(await db.catalog.count()).toBe(0);
    });

    it("returns 401 without a session", async () => {
      const res = await upload(undefined, PDF_BYTES);
      expect(res.status).toBe(401);
    });
  });

  describe("FR-CLG-04 list catalogs", () => {
    it("lists a supplier's catalogs with name, version, size, and last updated", async () => {
      await uploadAsAdmin({ name: "B list", version: "2" });
      await uploadAsAdmin({ name: "A list", version: "1" });

      const res = await request(app.server)
        .get(`/api/v1/suppliers/${supplierId}/catalogs`)
        .set(unsafeHeaders(readerCookie));

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[0]).toEqual(
        expect.objectContaining({ name: "A list", version: "1", sizeBytes: PDF_BYTES.byteLength }),
      );
      expect(res.body.items[0].updatedAt).toEqual(expect.any(String));
      expect(await db.auditLog.count({ where: { action: "CATALOG_LIST", entityId: supplierId } })).toBe(1);
    });

    it("returns 404 for an unknown supplier", async () => {
      const res = await request(app.server)
        .get(`/api/v1/suppliers/${NIL_UUID}/catalogs`)
        .set(unsafeHeaders(readerCookie));
      expect(res.status).toBe(404);
    });

    it("returns 401 without a session", async () => {
      const res = await request(app.server).get(`/api/v1/suppliers/${supplierId}/catalogs`);
      expect(res.status).toBe(401);
    });

    it("does not list catalogs from other suppliers", async () => {
      await uploadAsAdmin();
      const other = await request(app.server)
        .post("/api/v1/suppliers")
        .set(unsafeHeaders(adminCookie))
        .send({ name: "Other Supplier" });

      const res = await request(app.server)
        .get(`/api/v1/suppliers/${other.body.supplier.id}/catalogs`)
        .set(unsafeHeaders(readerCookie));
      expect(res.body.items).toEqual([]);
    });
  });

  describe("FR-CLG-05 download catalog", () => {
    it("downloads the PDF as an attachment and audits the download", async () => {
      const catalog = await uploadAsAdmin();

      const res = await request(app.server)
        .get(`/api/v1/catalogs/${catalog.id}/download`)
        .set(unsafeHeaders(readerCookie))
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["content-disposition"]).toContain("attachment");
      expect(Buffer.from(res.body).equals(PDF_BYTES)).toBe(true);
      expect(await db.auditLog.count({ where: { action: "CATALOG_DOWNLOAD", entityId: catalog.id } })).toBe(1);
    });

    it("returns 404 for an unknown catalog", async () => {
      const res = await request(app.server)
        .get(`/api/v1/catalogs/${NIL_UUID}/download`)
        .set(unsafeHeaders(readerCookie));
      expect(res.status).toBe(404);
    });

    it("returns 404 when the stored file is missing", async () => {
      const catalog = await uploadAsAdmin();
      await rm(path.join(uploadDir, (await storedFiles())[0]!), { force: true });

      const res = await request(app.server)
        .get(`/api/v1/catalogs/${catalog.id}/download`)
        .set(unsafeHeaders(readerCookie));
      expect(res.status).toBe(404);
    });

    it("returns 401 without a session", async () => {
      const catalog = await uploadAsAdmin();
      const res = await request(app.server).get(`/api/v1/catalogs/${catalog.id}/download`);
      expect(res.status).toBe(401);
    });
  });

  describe("FR-CLG-06 update catalog", () => {
    it("updates name and version, refreshes updatedAt, and audits the change", async () => {
      const catalog = await uploadAsAdmin();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const res = await request(app.server)
        .patch(`/api/v1/catalogs/${catalog.id}`)
        .set(unsafeHeaders(adminCookie))
        .send({ name: "Winter List", version: "2026.2" });

      expect(res.status).toBe(200);
      expect(res.body.catalog).toEqual(
        expect.objectContaining({ name: "Winter List", version: "2026.2", sizeBytes: PDF_BYTES.byteLength }),
      );
      expect(new Date(res.body.catalog.updatedAt).getTime()).toBeGreaterThan(new Date(catalog.updatedAt).getTime());

      const audit = await db.auditLog.findFirst({ where: { action: "CATALOG_UPDATE", entityId: catalog.id } });
      expect(audit).not.toBeNull();
      expect(audit?.changes).toEqual({
        name: { before: "Spring Price List", after: "Winter List" },
        version: { before: "2026.1", after: "2026.2" },
      });
    });

    it("updates only the version when name is omitted", async () => {
      const catalog = await uploadAsAdmin();
      const res = await request(app.server)
        .patch(`/api/v1/catalogs/${catalog.id}`)
        .set(unsafeHeaders(adminCookie))
        .send({ version: "9" });
      expect(res.status).toBe(200);
      expect(res.body.catalog).toEqual(expect.objectContaining({ name: "Spring Price List", version: "9" }));
    });

    it("returns 400 for an empty body or a blank name", async () => {
      const catalog = await uploadAsAdmin();

      const empty = await request(app.server)
        .patch(`/api/v1/catalogs/${catalog.id}`)
        .set(unsafeHeaders(adminCookie))
        .send({});
      expect(empty.status).toBe(400);

      const blank = await request(app.server)
        .patch(`/api/v1/catalogs/${catalog.id}`)
        .set(unsafeHeaders(adminCookie))
        .send({ name: "   " });
      expect(blank.status).toBe(400);
    });

    it("does not write an audit entry when nothing changes", async () => {
      const catalog = await uploadAsAdmin();
      await request(app.server)
        .patch(`/api/v1/catalogs/${catalog.id}`)
        .set(unsafeHeaders(adminCookie))
        .send({ name: "Spring Price List" });
      expect(await db.auditLog.count({ where: { action: "CATALOG_UPDATE" } })).toBe(0);
    });

    it("returns 403 for a standard user", async () => {
      const catalog = await uploadAsAdmin();
      const res = await request(app.server)
        .patch(`/api/v1/catalogs/${catalog.id}`)
        .set(unsafeHeaders(readerCookie))
        .send({ name: "Hacked" });
      expect(res.status).toBe(403);
      expect((await db.catalog.findUniqueOrThrow({ where: { id: catalog.id } })).name).toBe("Spring Price List");
    });

    it("returns 404 for an unknown catalog", async () => {
      const res = await request(app.server)
        .patch(`/api/v1/catalogs/${NIL_UUID}`)
        .set(unsafeHeaders(adminCookie))
        .send({ name: "X" });
      expect(res.status).toBe(404);
    });
  });

  describe("FR-CLG-07 delete catalog", () => {
    it("deletes the metadata and the stored file, and audits the deletion", async () => {
      const catalog = await uploadAsAdmin();
      expect(await storedFiles()).toHaveLength(1);

      const res = await request(app.server)
        .delete(`/api/v1/catalogs/${catalog.id}`)
        .set(unsafeHeaders(adminCookie));

      expect(res.status).toBe(204);
      expect(await db.catalog.count()).toBe(0);
      expect(await storedFiles()).toEqual([]);
      expect(await db.auditLog.count({ where: { action: "CATALOG_DELETE", entityId: catalog.id } })).toBe(1);
    });

    it("returns 403 for a standard user and keeps the catalog", async () => {
      const catalog = await uploadAsAdmin();
      const res = await request(app.server)
        .delete(`/api/v1/catalogs/${catalog.id}`)
        .set(unsafeHeaders(readerCookie));
      expect(res.status).toBe(403);
      expect(await db.catalog.count()).toBe(1);
    });

    it("returns 404 for an unknown catalog", async () => {
      const res = await request(app.server)
        .delete(`/api/v1/catalogs/${NIL_UUID}`)
        .set(unsafeHeaders(adminCookie));
      expect(res.status).toBe(404);
    });

    it("removes catalog files when the supplier is deleted", async () => {
      await uploadAsAdmin();
      await uploadAsAdmin({ name: "Second", version: "1" });
      expect(await storedFiles()).toHaveLength(2);

      const res = await request(app.server)
        .delete(`/api/v1/suppliers/${supplierId}`)
        .set(unsafeHeaders(adminCookie));

      expect(res.status).toBe(204);
      expect(await db.catalog.count()).toBe(0);
      expect(await storedFiles()).toEqual([]);
    });
  });
});

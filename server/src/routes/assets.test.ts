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

describe("supplier assets", () => {
  let db: Database;
  let app: FastifyInstance;
  let uploadDir: string;
  let adminCookie: string;
  let readerCookie: string;
  let supplierId: string;

  beforeAll(async () => {
    db = createTestDatabase();
    uploadDir = await mkdtemp(path.join(tmpdir(), "asset-tests-"));
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

  function upload(cookie: string, buffer: Buffer, options: { filename?: string; contentType?: string; fields?: Record<string, string> } = {}) {
    let req = request(app.server)
      .post(`/api/v1/suppliers/${supplierId}/assets`)
      .set(unsafeHeaders(cookie))
      .attach("file", buffer, {
        filename: options.filename ?? "catalog.pdf",
        contentType: options.contentType ?? "application/pdf",
      });
    for (const [name, value] of Object.entries(options.fields ?? {})) {
      req = req.field(name, value);
    }
    return req;
  }

  async function storedFiles(): Promise<string[]> {
    try {
      return await readdir(uploadDir);
    } catch {
      return [];
    }
  }

  describe("FR-AST-01/02 upload validation", () => {
    it("uploads a PDF, stores it under a generated name, and returns metadata", async () => {
      const res = await upload(adminCookie, PDF_BYTES, {
        filename: "../../Price List (2026).pdf",
        fields: { title: "Price list", description: "Spring catalog" },
      });

      expect(res.status).toBe(201);
      expect(res.body.asset).toEqual(
        expect.objectContaining({
          originalFileName: "Price List (2026).pdf",
          mimeType: "application/pdf",
          sizeBytes: PDF_BYTES.byteLength,
          title: "Price list",
          description: "Spring catalog",
        }),
      );
      const [stored] = await storedFiles();
      expect(stored).toMatch(/^[0-9a-f-]{36}\.pdf$/);
      expect(await db.auditLog.count({ where: { action: "ASSET_UPLOAD" } })).toBe(1);
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
      expect(await db.supplierAsset.count()).toBe(0);
    });

    it("rejects files above MAX_UPLOAD_MB with 413", async () => {
      const big = Buffer.concat([PDF_BYTES, Buffer.alloc(1024 * 1024 + 10, 0x20)]);
      const res = await upload(adminCookie, big);
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
      expect(await db.supplierAsset.count()).toBe(0);
    });

    it("returns 400 when no file part is sent", async () => {
      const res = await request(app.server)
        .post(`/api/v1/suppliers/${supplierId}/assets`)
        .set(unsafeHeaders(adminCookie))
        .field("title", "No file");
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe("file");
    });

    it("returns 403 to standard users and 404 for an unknown supplier", async () => {
      const denied = await upload(readerCookie, PDF_BYTES);
      expect(denied.status).toBe(403);

      const missing = await request(app.server)
        .post(`/api/v1/suppliers/${NIL_UUID}/assets`)
        .set(unsafeHeaders(adminCookie))
        .attach("file", PDF_BYTES, { filename: "x.pdf", contentType: "application/pdf" });
      expect(missing.status).toBe(404);
    });

    it("returns 401 without a session", async () => {
      const res = await request(app.server)
        .post(`/api/v1/suppliers/${supplierId}/assets`)
        .set("Origin", "http://localhost:5173")
        .attach("file", PDF_BYTES, { filename: "x.pdf", contentType: "application/pdf" });
      expect(res.status).toBe(401);
    });

    it("removes the stored file when the metadata write fails (NFR-11)", async () => {
      const originalTransaction = db.$transaction.bind(db);
      const failing = db as unknown as { $transaction: unknown };
      failing.$transaction = () => Promise.reject(new Error("simulated database failure"));
      try {
        const res = await upload(adminCookie, PDF_BYTES);
        expect(res.status).toBe(500);
        expect(await storedFiles()).toEqual([]);
      } finally {
        failing.$transaction = originalTransaction;
      }
    });
  });

  describe("FR-AST-05 list assets", () => {
    it("lists a supplier's assets for any signed-in user and audits the list view", async () => {
      await upload(adminCookie, PDF_BYTES, { filename: "one.pdf" });
      const res = await request(app.server)
        .get(`/api/v1/suppliers/${supplierId}/assets`)
        .set("Cookie", readerCookie);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toHaveProperty("sizeBytes");
      expect(res.body.items[0]).not.toHaveProperty("storageKey");
      expect(await db.auditLog.count({ where: { action: "ASSET_LIST" } })).toBe(1);
    });
  });

  describe("FR-AST-06 download", () => {
    it("streams the PDF as an attachment with a sanitized file name and audits the download", async () => {
      const created = await upload(adminCookie, PDF_BYTES, { filename: "Quote: final*.pdf" });
      const assetId = created.body.asset.id;

      const res = await request(app.server)
        .get(`/api/v1/assets/${assetId}/download`)
        .set("Cookie", readerCookie)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["content-disposition"]).toContain("attachment;");
      expect(res.headers["content-disposition"]).toContain('filename="Quote_ final_.pdf"');
      expect(Buffer.compare(res.body as Buffer, PDF_BYTES)).toBe(0);
      expect(await db.auditLog.count({ where: { action: "ASSET_DOWNLOAD", entityId: assetId } })).toBe(1);
    });

    it("returns 401 without a session and 404 for an unknown asset", async () => {
      const anonymous = await request(app.server).get(`/api/v1/assets/${NIL_UUID}/download`);
      expect(anonymous.status).toBe(401);

      const missing = await request(app.server)
        .get(`/api/v1/assets/${NIL_UUID}/download`)
        .set("Cookie", readerCookie);
      expect(missing.status).toBe(404);
    });

    it("returns 404 when the stored file is missing from disk", async () => {
      const created = await upload(adminCookie, PDF_BYTES);
      await rm(uploadDir, { recursive: true, force: true });

      const res = await request(app.server)
        .get(`/api/v1/assets/${created.body.asset.id}/download`)
        .set("Cookie", readerCookie);
      expect(res.status).toBe(404);
    });
  });

  describe("FR-AST-09 update title and description", () => {
    it("updates metadata, audits before and after values, and allows clearing fields", async () => {
      const created = await upload(adminCookie, PDF_BYTES, { fields: { title: "Old" } });
      const assetId = created.body.asset.id;

      const res = await request(app.server)
        .patch(`/api/v1/assets/${assetId}`)
        .set(unsafeHeaders(adminCookie))
        .send({ title: "New", description: "Added later" });
      expect(res.status).toBe(200);
      expect(res.body.asset.title).toBe("New");

      const audit = await db.auditLog.findFirstOrThrow({ where: { action: "ASSET_UPDATE", entityId: assetId } });
      expect(audit.changes).toMatchObject({ title: { before: "Old", after: "New" } });

      const cleared = await request(app.server)
        .patch(`/api/v1/assets/${assetId}`)
        .set(unsafeHeaders(adminCookie))
        .send({ title: "" });
      expect(cleared.body.asset.title).toBeNull();
    });

    it("rejects an empty body and standard users", async () => {
      const created = await upload(adminCookie, PDF_BYTES);
      const empty = await request(app.server)
        .patch(`/api/v1/assets/${created.body.asset.id}`)
        .set(unsafeHeaders(adminCookie))
        .send({});
      expect(empty.status).toBe(400);

      const denied = await request(app.server)
        .patch(`/api/v1/assets/${created.body.asset.id}`)
        .set(unsafeHeaders(readerCookie))
        .send({ title: "Nope" });
      expect(denied.status).toBe(403);
    });
  });

  describe("FR-AST-07 delete asset", () => {
    it("deletes the metadata and the stored file, and audits the deletion", async () => {
      const created = await upload(adminCookie, PDF_BYTES);
      const assetId = created.body.asset.id;
      expect(await storedFiles()).toHaveLength(1);

      const res = await request(app.server)
        .delete(`/api/v1/assets/${assetId}`)
        .set(unsafeHeaders(adminCookie));

      expect(res.status).toBe(204);
      expect(await db.supplierAsset.findUnique({ where: { id: assetId } })).toBeNull();
      expect(await storedFiles()).toEqual([]);
      expect(await db.auditLog.count({ where: { action: "ASSET_DELETE", entityId: assetId } })).toBe(1);
    });

    it("returns 403 to standard users and 404 for unknown assets", async () => {
      const created = await upload(adminCookie, PDF_BYTES);
      const denied = await request(app.server)
        .delete(`/api/v1/assets/${created.body.asset.id}`)
        .set(unsafeHeaders(readerCookie));
      expect(denied.status).toBe(403);

      const missing = await request(app.server)
        .delete(`/api/v1/assets/${NIL_UUID}`)
        .set(unsafeHeaders(adminCookie));
      expect(missing.status).toBe(404);
    });
  });

  describe("supplier deletion removes its assets", () => {
    it("deletes stored files along with the supplier", async () => {
      await upload(adminCookie, PDF_BYTES);
      await upload(adminCookie, PDF_BYTES);
      expect(await storedFiles()).toHaveLength(2);

      const res = await request(app.server)
        .delete(`/api/v1/suppliers/${supplierId}`)
        .set(unsafeHeaders(adminCookie));

      expect(res.status).toBe(204);
      expect(await db.supplierAsset.count()).toBe(0);
      expect(await storedFiles()).toEqual([]);
    });
  });
});

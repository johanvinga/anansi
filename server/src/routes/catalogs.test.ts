import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { Database } from "../db.js";
import { createLocalAssetStorage } from "../lib/asset-storage.js";
import { processCatalogExtraction } from "../services/catalog-extraction.js";
import { processGeminiCatalogExtraction } from "../services/catalog-gemini-extraction.js";
import {
  ADMIN,
  READER,
  createTestApp,
  createTestDatabase,
  loginCookie,
  resetDatabase,
  seedUser,
  unsafeHeaders,
  testConfig,
} from "../test/helpers.js";

const NIL_UUID = "9f1c2a4e-1111-4222-8333-444455556666";
const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n");

function textPdf(lines: string[]): Buffer {
  const content = [
    "BT",
    "/F1 12 Tf",
    "72 740 Td",
    ...lines.flatMap((line, index) => [index === 0 ? "" : "0 -18 Td", `(${line.replace(/[\\()]/g, "\\$&")}) Tj`]),
    "ET",
  ]
    .filter(Boolean)
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output, "ascii"));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, "ascii");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}

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
    return res.body.catalog as {
      id: string;
      updatedAt: string;
      createdAt: string;
      analysisStatus: string;
    };
  }

  async function storedFiles(): Promise<string[]> {
    try {
      return await readdir(path.join(uploadDir, "catalogs"));
    } catch {
      return [];
    }
  }

  describe("FR-CLG-01/02/03 create catalog", () => {
    it("accepts a 40 MiB catalog when the upload limit is 50 MiB", async () => {
      const largeUploadDb = createTestDatabase();
      const largeUploadApp = await buildApp(testConfig({
        uploadDir,
        maxUploadMb: 50,
        catalogExtractionEnabled: false,
      }), { db: largeUploadDb, logger: false });
      try {
        await largeUploadApp.ready();
        const pdf = Buffer.alloc(40 * 1024 * 1024);
        PDF_BYTES.copy(pdf);
        const res = await request(largeUploadApp.server)
          .post(`/api/v1/suppliers/${supplierId}/catalogs`)
          .set(unsafeHeaders(adminCookie))
          .field("name", "Large catalog")
          .attach("file", pdf, { filename: "large.pdf", contentType: "application/pdf" });
        expect(res.status).toBe(201);
        expect(res.body.catalog.sizeBytes).toBe(pdf.byteLength);
        expect(await db.auditLog.count({ where: { action: "CATALOG_UPLOAD", entityId: res.body.catalog.id } })).toBe(1);
      } finally {
        await largeUploadApp.close();
      }
    });

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

    it("uses a filename immediately for omitted or blank names and preserves a supplied name", async () => {
      const inferred = await upload(adminCookie, PDF_BYTES, {
        filename: "generic.pdf",
        fields: {},
      });
      const fallback = await upload(adminCookie, PDF_BYTES, {
        filename: "Fallback Catalog.pdf",
        fields: { name: "   " },
      });
      const supplied = await upload(adminCookie, PDF_BYTES, {
        filename: "ignored.pdf",
        fields: { name: "My title" },
      });

      expect(inferred.status).toBe(201);
      expect(inferred.body.catalog.name).toBe("generic");
      expect(fallback.status).toBe(201);
      expect(fallback.body.catalog.name).toBe("Fallback Catalog");
      expect(supplied.status).toBe(201);
      expect(supplied.body.catalog.name).toBe("My title");
    });

    it("deduces a missing name and allows an omitted optional version", async () => {
      const missingName = await upload(adminCookie, PDF_BYTES, { fields: { version: "1" } });
      expect(missingName.status).toBe(201);
      expect(missingName.body.catalog).toEqual(expect.objectContaining({ name: "price-list", version: "1" }));
      expect(await db.catalog.count()).toBe(1);

      // Version is optional since FR-CLG-01 was relaxed (2026-11-08).
      const noVersion = await upload(adminCookie, PDF_BYTES, { fields: { name: "List" } });
      expect(noVersion.status).toBe(201);
      expect(noVersion.body.catalog).toEqual(expect.objectContaining({ version: null }));
      expect(await db.catalog.count()).toBe(2);
      expect(await storedFiles()).toHaveLength(2);
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

  describe("catalog analysis jobs", () => {
    it("disables analysis without Redis while retaining catalog uploads and downloads", async () => {
      const previouslyQueued = await uploadAsAdmin();
      expect(previouslyQueued.analysisStatus).toBe("not_processed");
      const disabledDb = createTestDatabase();
      const disabledApp = await buildApp(testConfig({
        uploadDir,
        maxUploadMb: 1,
        catalogExtractionEnabled: false,
        redisUrl: "redis://127.0.0.1:1",
      }), { db: disabledDb, logger: false });
      try {
        await disabledApp.ready();
        const settings = await request(disabledApp.server).get("/api/v1/settings").set("Cookie", readerCookie);
        expect(settings.status).toBe(200);
        expect(settings.body.catalogExtractionEnabled).toBe(false);

        const uploaded = await request(disabledApp.server)
          .post(`/api/v1/suppliers/${supplierId}/catalogs`)
          .set(unsafeHeaders(adminCookie))
          .field("name", "Unanalyzed catalog")
          .attach("file", PDF_BYTES, { filename: "test.pdf", contentType: "application/pdf" });
        expect(uploaded.status).toBe(201);
        expect(uploaded.body.catalog.analysisStatus).toBe("not_processed");
        const id = uploaded.body.catalog.id as string;
        expect(await db.catalogExtractionJob.count({ where: { catalogId: id } })).toBe(0);
        expect(await db.auditLog.count({ where: { action: "CATALOG_UPLOAD", entityId: id } })).toBe(1);
        expect((await db.catalog.findUniqueOrThrow({ where: { id: previouslyQueued.id } })).analysisStatus).toBe("not_processed");
        expect(await db.catalogExtractionJob.count({ where: { catalogId: previouslyQueued.id } })).toBe(0);

        const download = await request(disabledApp.server).get(`/api/v1/catalogs/${id}/download`).set("Cookie", readerCookie);
        expect(download.status).toBe(200);
        expect(download.body).toEqual(PDF_BYTES);

        expect((await request(disabledApp.server).get(`/api/v1/catalogs/${id}/extraction`)).status).toBe(401);
        expect((await request(disabledApp.server).post(`/api/v1/catalogs/${id}/extraction`).set(unsafeHeaders(readerCookie))).status).toBe(403);
        for (const response of [
          await request(disabledApp.server).get(`/api/v1/catalogs/${id}/extraction`).set("Cookie", readerCookie),
          await request(disabledApp.server).post(`/api/v1/catalogs/${id}/extraction`).set(unsafeHeaders(adminCookie)),
          await request(disabledApp.server).post(`/api/v1/catalogs/${id}/extraction/preview`).set(unsafeHeaders(adminCookie)).send({ jobId: NIL_UUID, indexes: [0] }),
        ]) {
          expect(response.status).toBe(503);
          expect(response.body.error.code).toBe("FEATURE_DISABLED");
        }
        expect(await db.catalogExtractionJob.count({ where: { catalogId: id } })).toBe(0);

        const enabledSettings = await request(app.server).get("/api/v1/settings").set("Cookie", readerCookie);
        expect(enabledSettings.body.catalogExtractionEnabled).toBe(true);
        const started = await request(app.server)
          .post(`/api/v1/catalogs/${id}/extraction`)
          .set(unsafeHeaders(adminCookie));
        expect(started.status).toBe(202);
        expect(started.body.job.status).toBe("queued");
        expect(await db.catalogExtractionJob.count({ where: { catalogId: id } })).toBe(1);
      } finally {
        await disabledApp.close();
      }
    });

    it("does not queue on upload and lets an admin start analysis", async () => {
      const catalog = await uploadAsAdmin();
      expect(catalog.analysisStatus).toBe("not_processed");
      expect(await db.catalogExtractionJob.count({ where: { catalogId: catalog.id } })).toBe(0);
      const start = await request(app.server).post(`/api/v1/catalogs/${catalog.id}/extraction`).set(unsafeHeaders(adminCookie));
      expect(start.status).toBe(202);

      const res = await request(app.server)
        .get(`/api/v1/catalogs/${catalog.id}/extraction`)
        .set("Cookie", readerCookie);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        analysisStatus: "queued",
        job: {
          status: "queued",
          stage: "queued",
          progress: 0,
          currentPage: 0,
          totalPages: 0,
          productsIdentified: 0,
        },
      });
      expect(await db.auditLog.count({ where: { action: "CATALOG_ANALYSIS_VIEW", entityId: catalog.id } })).toBe(1);
    });

    it("applies the catalog name and all product-derived category paths only while analysis runs", async () => {
      const materials = await db.category.create({
        data: {
          nameEn: "Building materials",
          nameFr: "Matériaux de construction",
          nameKey: "building materials",
        },
      });
      const uploaded = await upload(adminCookie, textPdf(["Fasteners"]), {
        filename: "generic.pdf",
        fields: {},
      });
      expect(uploaded.status).toBe(201);
      expect(uploaded.body.catalog.name).toBe("generic");
      expect(uploaded.body.catalog.categories).toEqual([]);
      const catalogId = uploaded.body.catalog.id as string;
      const started = await request(app.server)
        .post(`/api/v1/catalogs/${catalogId}/extraction`)
        .set(unsafeHeaders(adminCookie));

      await processGeminiCatalogExtraction(
        started.body.job.jobId,
        { db, storage: createLocalAssetStorage(uploadDir), maxPages: 100 },
        async () => ({
          catalog: {
            name: "Structural Fastener Catalog",
            categoryPaths: [
              [
                { en: "Building materials", fr: "Matériaux de construction" },
                { en: "Fasteners", fr: "Fixations" },
              ],
              [
                { en: "Building materials", fr: "Matériaux de construction" },
                { en: "Brackets", fr: "Équerres" },
              ],
            ],
          },
          products: [],
        }),
      );

      const catalog = await db.catalog.findUniqueOrThrow({
        where: { id: catalogId },
        include: { categories: { include: { category: true } } },
      });
      expect(catalog.name).toBe("Structural Fastener Catalog");
      expect(catalog.analysisStatus).toBe("processed");
      expect(catalog.categories).toHaveLength(2);
      expect(catalog.categories.map((link) => link.category)).toEqual(expect.arrayContaining([
        expect.objectContaining({ nameEn: "Fasteners", nameFr: "Fixations", parentId: materials.id }),
        expect.objectContaining({ nameEn: "Brackets", nameFr: "Équerres", parentId: materials.id }),
      ]));
      expect(await db.auditLog.count({ where: { action: "CATEGORY_CREATE" } })).toBe(2);
      expect(await db.supplierCategory.count({ where: { supplierId } })).toBe(2);
    });

    it("reuses one queued job when admins start analysis concurrently", async () => {
      const catalog = await uploadAsAdmin();
      const start = () => request(app.server).post(`/api/v1/catalogs/${catalog.id}/extraction`).set(unsafeHeaders(adminCookie));
      const responses = await Promise.all([start(), start()]);
      expect(responses.map((response) => response.status)).toEqual([202, 202]);
      expect(responses[0]!.body.job.jobId).toBe(responses[1]!.body.job.jobId);
      expect(await db.catalogExtractionJob.count({ where: { catalogId: catalog.id } })).toBe(1);
    });

    it("allows admins to retry a failed analysis and denies retry to standard users", async () => {
      const catalog = await uploadAsAdmin();
      await request(app.server).post(`/api/v1/catalogs/${catalog.id}/extraction`).set(unsafeHeaders(adminCookie));
      await db.catalogExtractionJob.updateMany({
        where: { catalogId: catalog.id },
        data: { status: "failed", stage: "failed", processingError: "Test failure" },
      });
      await db.catalog.update({ where: { id: catalog.id }, data: { analysisStatus: "failed" } });

      const denied = await request(app.server)
        .post(`/api/v1/catalogs/${catalog.id}/extraction`)
        .set(unsafeHeaders(readerCookie));
      expect(denied.status).toBe(403);

      const retried = await request(app.server)
        .post(`/api/v1/catalogs/${catalog.id}/extraction`)
        .set(unsafeHeaders(adminCookie));
      expect(retried.status).toBe(202);
      expect(retried.body.job).toMatchObject({ status: "queued", stage: "queued", progress: 0 });
      expect(await db.catalogExtractionJob.count({ where: { catalogId: catalog.id } })).toBe(2);
      expect(await db.auditLog.count({ where: { action: "CATALOG_ANALYSIS_START", entityId: catalog.id } })).toBe(2);
    });

    it("allows admins to rerun a completed analysis", async () => {
      const catalog = await uploadAsAdmin();
      await request(app.server).post(`/api/v1/catalogs/${catalog.id}/extraction`).set(unsafeHeaders(adminCookie));
      await db.catalogExtractionJob.updateMany({
        where: { catalogId: catalog.id },
        data: { status: "processed", stage: "completed", progress: 100, completedAt: new Date() },
      });
      await db.catalog.update({ where: { id: catalog.id }, data: { analysisStatus: "processed" } });

      const retried = await request(app.server)
        .post(`/api/v1/catalogs/${catalog.id}/extraction`)
        .set(unsafeHeaders(adminCookie));

      expect(retried.status).toBe(202);
      expect(retried.body.job).toMatchObject({ status: "queued", stage: "queued", progress: 0 });
      expect(await db.catalogExtractionJob.count({ where: { catalogId: catalog.id } })).toBe(2);
      expect(await db.auditLog.count({ where: { action: "CATALOG_ANALYSIS_START", entityId: catalog.id } })).toBe(2);
    });

    it("requires authentication and returns 404 for an unknown catalog", async () => {
      const anonymous = await request(app.server).get(`/api/v1/catalogs/${NIL_UUID}/extraction`);
      expect(anonymous.status).toBe(401);

      const missing = await request(app.server)
        .get(`/api/v1/catalogs/${NIL_UUID}/extraction`)
        .set("Cookie", readerCookie);
      expect(missing.status).toBe(404);
    });

    it("extracts product candidates and labeled attributes from selectable PDF text", async () => {
      const pdf = textPdf([
        "DRL-2040",
        "Cordless Drill 20V",
        "Maximum Torque: 450 in-lbs",
        "Variable Speed: 0-1800 RPM",
        "Chuck Size: 1/2 inch",
        "Lithium-ion battery powered tool designed for regular workshop use.",
      ]);
      const uploadResult = await upload(adminCookie, pdf);
      expect(uploadResult.status).toBe(201);
      const catalogId = uploadResult.body.catalog.id as string;
      const job = await db.catalogExtractionJob.create({ data: { catalogId } });

      await processCatalogExtraction(
        job.id,
        { db, storage: createLocalAssetStorage(uploadDir), maxPages: 100 },
        async () => {
          throw new Error("OCR should not run for selectable PDF text.");
        },
      );

      const processed = await db.catalogExtractionJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(processed.status).toBe("processed");
      expect(processed.totalPages).toBe(1);
      expect(processed.productsIdentified).toBe(1);
      const results = processed.results as {
        products: { sku: string | null; name: string; attributes: { name: string; value: string }[] }[];
        pages: { pageNumber: number; textSource: string }[];
      };
      expect(results.products[0]).toMatchObject({
        sku: "DRL-2040",
        name: "Cordless Drill 20V",
        attributes: [
          { name: "Maximum Torque", value: "450 in-lbs" },
          { name: "Variable Speed", value: "0-1800 RPM" },
          { name: "Chuck Size", value: "1/2 inch" },
        ],
      });
      expect(results.pages).toEqual([{ pageNumber: 1, textSource: "pdf", confidence: null }]);
      expect((await db.catalog.findUniqueOrThrow({ where: { id: catalogId } })).analysisStatus).toBe("processed");
      expect(await db.product.count()).toBe(0);
      expect(await db.attributeSet.count()).toBe(0);
    });

    it("uses OCR for scanned pages and stores recognized candidates for review", async () => {
      const uploadResult = await upload(adminCookie, textPdf([]));
      expect(uploadResult.status).toBe(201);
      const catalogId = uploadResult.body.catalog.id as string;
      const job = await db.catalogExtractionJob.create({ data: { catalogId } });

      await processCatalogExtraction(
        job.id,
        { db, storage: createLocalAssetStorage(uploadDir), maxPages: 100 },
        async () => ({
          recognize: async () => ({
            data: {
              text: "SKU: OCR-2040\nCordless Drill OCR\nMaterial: Steel",
              confidence: 92,
            },
          }),
        }),
      );

      const processed = await db.catalogExtractionJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(processed.status).toBe("processed");
      expect(processed.results).toMatchObject({
        products: [
          {
            sku: "OCR-2040",
            name: "Cordless Drill OCR",
            attributes: [{ name: "Material", value: "Steel", sourcePage: 1 }],
            validationStatus: "pending",
          },
        ],
        pages: [{ pageNumber: 1, textSource: "ocr", confidence: 0.92 }],
      });
      expect(await db.product.count()).toBe(0);
      expect(await db.attributeSet.count()).toBe(0);
    });

    it("extracts a labeled hinge product, its page category, and specs from OCR", async () => {
      const uploadResult = await upload(adminCookie, textPdf([]));
      expect(uploadResult.status).toBe(201);
      const catalogId = uploadResult.body.catalog.id as string;
      const job = await db.catalogExtractionJob.create({ data: { catalogId } });

      await processCatalogExtraction(
        job.id,
        { db, storage: createLocalAssetStorage(uploadDir), maxPages: 100 },
        async () => ({
          recognize: async () => ({
            data: {
              text: [
                "MONSOON VY Jd Furniture Hinges gy",
                "Make trust as nature",
                "35MM CLIP ON HINGE Sa",
                "Item NO.: MO2105 BS Jo",
                "Materials:lron Optional Plates: p 7",
                "Finish: Nickel plated 6 > @y Zs",
                "Diameter of hinge cup:$p35mm NA / : i a",
                "Opening degree: 98° er 748)",
                "Door thinckness:14-20mm ~ 7/4 a 4 Full Overlay A",
                "Quality grade:Comply with BS EN15570,ANSI/BIFMA X5.5",
                "Product features: Open and close with clear voice, Easy disassemble. Fr NE",
              ].join("\n"),
              confidence: 57,
            },
          }),
        }),
      );

      const processed = await db.catalogExtractionJob.findUniqueOrThrow({ where: { id: job.id } });
      const results = processed.results as {
        products: {
          sku: string | null;
          name: string;
          categories: string[];
          attributes: { name: string; value: string }[];
        }[];
        suggestedAttributeFields: { name: string; type: string }[];
      };
      expect(results.products).toHaveLength(1);
      expect(results.products[0]).toMatchObject({
        sku: "MO2105",
        name: "35MM CLIP ON HINGE",
        categories: ["Furniture Hinges"],
      });
      expect(results.products[0]!.attributes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "Material", value: "Iron" }),
        expect.objectContaining({ name: "Finish", value: "Nickel plated" }),
        expect.objectContaining({ name: "Diameter Of Hinge Cup", value: "Ø35mm" }),
        expect.objectContaining({ name: "Opening Degree", value: "98°" }),
        expect.objectContaining({ name: "Door thickness", value: "14-20mm" }),
        expect.objectContaining({ name: "Quality Grade", value: "Comply with BS EN15570,ANSI/BIFMA X5.5" }),
        expect.objectContaining({ name: "Product Features", value: "Open and close with clear voice, Easy disassemble." }),
      ]));
      expect(results.suggestedAttributeFields).toEqual(expect.arrayContaining([
        { name: "Material", type: "text" },
        { name: "Finish", type: "text" },
      ]));
    });

    it("sends the entire PDF once and stores Gemini results as review candidates", async () => {
      const uploaded = await request(app.server)
        .post("/api/v1/catalogs")
        .set(unsafeHeaders(adminCookie))
        .field("name", "Example catalog")
        .attach("file", textPdf(["Example catalog"]), { filename: "example.pdf", contentType: "application/pdf" });
      expect(uploaded.status).toBe(201);
      const catalogId = uploaded.body.catalog.id as string;
      const started = await request(app.server).post(`/api/v1/catalogs/${catalogId}/extraction`).set(unsafeHeaders(adminCookie));
      expect(started.status).toBe(202);
      let calls = 0;
      await processGeminiCatalogExtraction(started.body.job.jobId, {
        db, storage: createLocalAssetStorage(uploadDir), maxPages: 100,
      }, async (pdf, totalPages) => {
        calls++;
        expect(pdf).toEqual(textPdf(["Example catalog"]));
        expect(totalPages).toBe(1);
        return { supplier: { name: "CATALOG SUPPLIER", sourcePage: 1, excerpt: "Supplied by Catalog Supplier" }, products: [{
          name: "Example", sku: "EX-123", description: null, categories: ["Hardware"],
          attributes: [{ name: "Material", value: "Steel", sourcePage: 1 }], pageNumbers: [1], excerpt: "Example EX-123",
        }] };
      });
      expect(calls).toBe(1);
      const job = await db.catalogExtractionJob.findUniqueOrThrow({ where: { id: started.body.job.jobId } });
      expect(job.status).toBe("processed");
      expect(job.results).toMatchObject({
        supplier: { name: "CATALOG SUPPLIER", sourcePage: 1, excerpt: "Supplied by Catalog Supplier" },
        products: [{ name: "Example", sku: "EX-123", attributes: [{ name: "Material", value: "Steel", sourcePage: 1 }], source: { pageNumbers: [1] }, validationStatus: "pending" }],
        pages: [{ pageNumber: 1, textSource: "gemini", confidence: null }],
      });
      expect(await db.product.count()).toBe(0);
      expect(await db.attributeSet.count()).toBe(0);
      expect((await db.catalog.findUniqueOrThrow({ where: { id: catalogId } })).supplierId).toBeNull();
      const review = await request(app.server).get(`/api/v1/catalogs/${catalogId}/extraction`).set("Cookie", readerCookie);
      expect(review.status).toBe(200);
      expect(review.body.matchingSupplier).toEqual({ id: supplierId, name: "Catalog Supplier" });
      expect(await db.supplier.count()).toBe(1);
      const existing = await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`)
        .set(unsafeHeaders(adminCookie))
        .send({ name: { en: "Existing" }, supplierSku: "ex-123", cost: "1", currency: "USD", minQuantity: 1 });
      expect(existing.status).toBe(201);
      const previewUrl = `/api/v1/catalogs/${catalogId}/extraction/preview`;
      const previewBody = { jobId: started.body.job.jobId, indexes: [0] };
      const beforeAssignment = await request(app.server).post(previewUrl).set(unsafeHeaders(adminCookie)).send(previewBody);
      expect(beforeAssignment.status).toBe(200);
      expect(beforeAssignment.body).toMatchObject({ supplierId: null, products: [{ duplicateExisting: false }] });
      const assigned = await request(app.server).patch(`/api/v1/catalogs/${catalogId}`)
        .set(unsafeHeaders(adminCookie)).send({ supplierId });
      expect(assigned.status).toBe(200);
      const afterAssignment = await request(app.server).post(previewUrl).set(unsafeHeaders(adminCookie)).send(previewBody);
      expect(afterAssignment.status).toBe(200);
      expect(afterAssignment.body).toMatchObject({ supplierId, products: [{ duplicateExisting: true }] });
      const assignedReview = await request(app.server).get(`/api/v1/catalogs/${catalogId}/extraction`).set("Cookie", readerCookie);
      expect(assignedReview.body.matchingSupplier).toBeNull();
      expect(await db.auditLog.count({ where: { entityId: catalogId, action: "CATALOG_UPDATE" } })).toBe(1);
    });

    it("does not save partial results when Gemini fails", async () => {
      const uploaded = await upload(adminCookie, textPdf(["Example catalog"]));
      const catalogId = uploaded.body.catalog.id as string;
      const started = await request(app.server).post(`/api/v1/catalogs/${catalogId}/extraction`).set(unsafeHeaders(adminCookie));
      await expect(processGeminiCatalogExtraction(started.body.job.jobId, {
        db, storage: createLocalAssetStorage(uploadDir), maxPages: 100,
      }, async () => { throw new Error("Gemini request failed"); })).rejects.toThrow("Gemini request failed");
      const job = await db.catalogExtractionJob.findUniqueOrThrow({ where: { id: started.body.job.jobId } });
      expect(job.results).toBeNull();
      expect(await db.product.count()).toBe(0);
    });

    it("requires reviewed typed values and rolls back an invalid bulk import", async () => {
      const uploaded = await upload(adminCookie, textPdf(["Example catalog"]));
      const catalogId = uploaded.body.catalog.id as string;
      const started = await request(app.server).post(`/api/v1/catalogs/${catalogId}/extraction`).set(unsafeHeaders(adminCookie));
      const jobId = started.body.job.jobId as string;
      await processGeminiCatalogExtraction(jobId, {
        db, storage: createLocalAssetStorage(uploadDir), maxPages: 100,
      }, async () => ({
        products: [
          { name: "First", sku: "T1", description: null, categories: [], attributes: [
            { name: "Length", value: "30 mm", sourcePage: 1 },
            { name: "Available", value: "No", sourcePage: 1 },
            { name: "Finish", value: "Matte", sourcePage: 1 },
            { name: "New", value: "Example", sourcePage: 1 },
          ], pageNumbers: [1], excerpt: "First" },
          { name: "Second", sku: "T2", description: null, categories: [], attributes: [
            { name: "Length", value: "50 mm", sourcePage: 1 },
          ], pageNumbers: [1], excerpt: "Second" },
        ],
      }));
      const length = await request(app.server).post("/api/v1/attributes").set(unsafeHeaders(adminCookie))
        .send({ name: { en: "Length" }, dataType: "decimal", unit: "mm" });
      const available = await request(app.server).post("/api/v1/attributes").set(unsafeHeaders(adminCookie))
        .send({ name: { en: "Available" }, dataType: "boolean" });
      const finish = await request(app.server).post("/api/v1/attributes").set(unsafeHeaders(adminCookie))
        .send({ name: { en: "Finish" }, dataType: "select", options: [{ en: "Matte" }, { en: "Gloss" }] });
      expect([length.status, available.status, finish.status]).toEqual([201, 201, 201]);
      const optionId = finish.body.attribute.options[0].id as string;
      const url = `/api/v1/catalogs/${catalogId}/extraction/import`;
      const first = { index: 0, sku: "T1", cost: "1", currency: "USD", minQuantity: 1, attributeValues: [
        { name: "Length", value: "30" }, { name: "Available", value: false }, { name: "Finish", value: optionId },
      ] };
      const second = { index: 1, sku: "T2", cost: "2", currency: "USD", minQuantity: 1,
        attributeValues: [{ name: "Length", value: "50" }] };
      const body = { jobId, supplierId, products: [first, second], mappings: [
        { name: "Length", attributeId: length.body.attribute.id },
        { name: "Available", attributeId: available.body.attribute.id },
        { name: "Finish", attributeId: finish.body.attribute.id },
        { name: "New", attributeId: null },
      ] };
      expect((await request(app.server).post(url).set(unsafeHeaders(adminCookie)).send({
        jobId, supplierId, products: [{ index: 0, sku: "T1" }],
      })).status).toBe(400);
      expect((await request(app.server).post(url).set(unsafeHeaders(adminCookie)).send({
        ...body, products: [{ ...first, attributeValues: [] }, second],
      })).status).toBe(400);
      const invalidLength = await request(app.server).post(url).set(unsafeHeaders(adminCookie)).send({
        ...body, products: [first, { ...second, attributeValues: [{ name: "Length", value: "50 mm" }] }],
      });
      expect(invalidLength.status).toBe(400);
      expect(invalidLength.body.error.details).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("Second: Length:") }),
      ]));
      expect((await request(app.server).post(url).set(unsafeHeaders(adminCookie)).send({
        ...body, products: [{ ...first, attributeValues: [
          { name: "Length", value: "30" }, { name: "Available", value: false }, { name: "Finish", value: NIL_UUID },
        ] }, second],
      })).status).toBe(400);
      expect(await db.product.count()).toBe(0);
      expect(await db.attributeField.count({ where: { attributeSetId: null } })).toBe(3);
      const imported = await request(app.server).post(url).set(unsafeHeaders(adminCookie)).send(body);
      expect(imported.status).toBe(200);
      expect(imported.body.created).toHaveLength(2);
      const stored = await request(app.server).get(`/api/v1/products/${imported.body.created[0]}`).set("Cookie", readerCookie);
      expect(stored.body.product.attributeValues).toEqual(expect.arrayContaining([
        expect.objectContaining({ fieldId: length.body.attribute.id, value: "30" }),
        expect.objectContaining({ fieldId: available.body.attribute.id, value: false }),
        expect.objectContaining({ fieldId: finish.body.attribute.id, value: optionId }),
        expect.objectContaining({ name: expect.objectContaining({ en: "New" }), value: "Example" }),
      ]));
      const repeated = await request(app.server).post(url).set(unsafeHeaders(adminCookie)).send({
        ...body, products: [{ index: 0, sku: "T1" }, { index: 1, sku: "T2" }], mappings: [],
      });
      expect(repeated.status).toBe(200);
      expect(repeated.body.skipped).toEqual([0, 1]);
    });

    it("reviews category decisions and imports approved hierarchy assignments transactionally", async () => {
      const uploaded = await upload(adminCookie, textPdf(["Example catalog"]));
      const catalogId = uploaded.body.catalog.id as string;
      const started = await request(app.server).post(`/api/v1/catalogs/${catalogId}/extraction`).set(unsafeHeaders(adminCookie));
      const jobId = started.body.job.jobId as string;
      await processGeminiCatalogExtraction(jobId, {
        db, storage: createLocalAssetStorage(uploadDir), maxPages: 100,
      }, async () => ({
        products: [
          { name: "First", sku: "C1", description: null, categories: ["Blinds", "Zebra"], attributes: [], pageNumbers: [1], excerpt: "First" },
          { name: "Second", sku: "C2", description: null, categories: ["Zebra"], attributes: [], pageNumbers: [1], excerpt: "Second" },
        ],
      }));
      async function category(name: string, parentId?: string) {
        const result = await request(app.server).post("/api/v1/categories").set(unsafeHeaders(adminCookie)).send({ name: { en: name }, parentId });
        expect(result.status).toBe(201);
        return result.body.category.id as string;
      }
      const home = await category("Home");
      const smart = await category("Smart");
      const firstBlinds = await category("Blinds", home);
      const secondBlinds = await category("Blinds", smart);
      const previewUrl = `/api/v1/catalogs/${catalogId}/extraction/preview`;
      const previewRequest = { jobId, indexes: [0, 1] };
      const preview = await request(app.server).post(previewUrl).set(unsafeHeaders(adminCookie)).send(previewRequest);
      expect(preview.status).toBe(200);
      expect(preview.body.products[0].categories).toEqual([
        { name: "Blinds", matches: expect.arrayContaining([firstBlinds, secondBlinds]) },
        { name: "Zebra", matches: [] },
      ]);
      const importUrl = `/api/v1/catalogs/${catalogId}/extraction/import`;
      const body = {
        jobId, supplierId, categoryTreeVersion: preview.body.categoryTree.version,
        products: [
          { index: 0, sku: "C1", categoryDecisions: [
            { name: "Blinds", action: "reuse", categoryId: firstBlinds },
            { name: "Zebra", action: "create", parentId: firstBlinds },
          ], additionalCategoryIds: [smart] },
          { index: 1, sku: "C2", categoryDecisions: [{ name: "Zebra", action: "create", parentId: firstBlinds }] },
        ],
      };
      expect((await request(app.server).post(importUrl).set(unsafeHeaders(adminCookie))
        .send({ ...body, products: [{ index: 0, sku: "C1" }] })).status).toBe(400);
      expect((await request(app.server).post(importUrl).set(unsafeHeaders(adminCookie))
        .send({ ...body, products: [body.products[0], { ...body.products[1], categoryDecisions: [] }] })).status).toBe(400);
      expect(await db.category.count({ where: { nameKey: "zebra" } })).toBe(0);
      expect(await db.product.count()).toBe(0);
      await category("New category");
      expect((await request(app.server).post(importUrl).set(unsafeHeaders(adminCookie)).send(body)).status).toBe(409);
      const refreshed = await request(app.server).post(previewUrl).set(unsafeHeaders(adminCookie)).send(previewRequest);
      const imported = await request(app.server).post(importUrl).set(unsafeHeaders(adminCookie))
        .send({ ...body, categoryTreeVersion: refreshed.body.categoryTree.version });
      expect(imported.status).toBe(200);
      expect(imported.body.created).toHaveLength(2);
      const zebra = await db.category.findMany({ where: { nameKey: "zebra" } });
      expect(zebra).toHaveLength(1);
      expect(zebra[0]!.parentId).toBe(firstBlinds);
      const first = await db.product.findUniqueOrThrow({ where: { id: imported.body.created[0] }, include: { categories: true } });
      const second = await db.product.findUniqueOrThrow({ where: { id: imported.body.created[1] }, include: { categories: true } });
      expect(first.categories.map((link) => link.categoryId)).toEqual(expect.arrayContaining([firstBlinds, smart, zebra[0]!.id]));
      expect(second.categories.map((link) => link.categoryId)).toEqual([zebra[0]!.id]);
      expect(first).toMatchObject({
        sourceCatalogId: catalogId,
        sourcePageNumbers: [1],
      });
      const productResponse = await request(app.server)
        .get(`/api/v1/products/${first.id}`)
        .set("Cookie", readerCookie);
      expect(productResponse.body.product.catalogSource).toMatchObject({
        id: catalogId,
        name: uploaded.body.catalog.name,
        version: uploaded.body.catalog.version,
        pageNumbers: [1],
      });
      expect(await db.auditLog.count({ where: { entityId: zebra[0]!.id, action: "CATEGORY_CREATE" } })).toBe(1);
      const repeated = await request(app.server).post(importUrl).set(unsafeHeaders(adminCookie)).send(body);
      expect(repeated.status).toBe(200);
      expect(repeated.body.skipped).toEqual([0, 1]);
    });

    it("reuses matched attributes, creates approved attributes, and skips unselected attributes", async () => {
      const uploaded = await upload(adminCookie, textPdf(["Example catalog"]));
      const catalogId = uploaded.body.catalog.id as string;
      const started = await request(app.server).post(`/api/v1/catalogs/${catalogId}/extraction`).set(unsafeHeaders(adminCookie));
      const jobId = started.body.job.jobId as string;
      await processGeminiCatalogExtraction(jobId, {
        db, storage: createLocalAssetStorage(uploadDir), maxPages: 100,
      }, async () => ({
        products: [
          { name: "First", sku: "AUTO-1", description: null, categories: [], attributes: [
            { name: "Material", value: "Steel", sourcePage: 1 },
            { name: "Finish", value: "Matte", sourcePage: 1 },
            { name: "Weight", value: "10 kg", sourcePage: 1 },
          ], pageNumbers: [1], excerpt: "First" },
          { name: "Second", sku: "AUTO-2", description: null, categories: [], attributes: [
            { name: "Matériau", value: "Wood", sourcePage: 1 },
            { name: "Finish", value: "Gloss", sourcePage: 1 },
            { name: "Weight", value: "20 kg", sourcePage: 1 },
          ], pageNumbers: [1], excerpt: "Second" },
        ],
      }));
      const material = await request(app.server).post("/api/v1/attributes").set(unsafeHeaders(adminCookie))
        .send({ name: { en: "Material", fr: "Matériau" } });
      expect(material.status).toBe(201);
      const url = `/api/v1/catalogs/${catalogId}/extraction/import`;
      const base = { jobId, supplierId, products: [
        { index: 0, sku: "AUTO-1" }, { index: 1, sku: "AUTO-2", cost: "0", currency: "USD", minQuantity: 0 },
      ] };
      expect((await request(app.server).post(url).set(unsafeHeaders(adminCookie))
        .send({ ...base, products: [{ index: 0, sku: "" }] })).status).toBe(400);
      expect((await request(app.server).post(url).set(unsafeHeaders(adminCookie))
        .send({ ...base, products: [{ index: 0, sku: "AUTO-1", cost: "-1" }] })).status).toBe(400);
      expect((await request(app.server).post(url).set(unsafeHeaders(adminCookie))
        .send({ ...base, products: [{ index: 0, sku: "AUTO-1", currency: "BAD" }] })).status).toBe(400);
      expect((await request(app.server).post(url).set(unsafeHeaders(adminCookie)).send(base)).status).toBe(400);
      expect(await db.product.count()).toBe(0);
      expect(await db.attributeField.count({ where: { attributeSetId: null } })).toBe(1);
      const mappings = [
        { name: "Finish", attributeId: null },
        { name: "Weight", attributeId: null, skip: true },
      ];
      expect((await request(app.server).post(url).set(unsafeHeaders(adminCookie))
        .send({ ...base, mappings: [{ name: "Weight", attributeId: material.body.attribute.id, skip: true }] })).status).toBe(400);
      expect((await request(app.server).post(url).set(unsafeHeaders(adminCookie))
        .send({ ...base, products: [{ index: 0, sku: "AUTO-1", attributeValues: [{ name: "Weight", value: "10 kg" }] }], mappings })).status).toBe(400);
      const imported = await request(app.server).post(url).set(unsafeHeaders(adminCookie)).send({ ...base, mappings });
      expect(imported.status).toBe(200);
      expect(imported.body.created).toHaveLength(2);
      const first = await request(app.server).get(`/api/v1/products/${imported.body.created[0]}`).set("Cookie", readerCookie);
      expect(first.body.product).toMatchObject({
        minQuantity: null, cost: null, currency: null,
        attributeValues: expect.arrayContaining([
          expect.objectContaining({ fieldId: material.body.attribute.id, value: "Steel" }),
          expect.objectContaining({ name: expect.objectContaining({ en: "Finish" }), value: "Matte" }),
        ]),
      });
      expect(await db.attributeField.count({ where: { attributeSetId: null } })).toBe(2);
      expect(await db.attributeField.count({ where: { nameEn: "Weight" } })).toBe(0);
      expect(first.body.product.attributeValues).toHaveLength(2);
      const second = await request(app.server).get(`/api/v1/products/${imported.body.created[1]}`).set("Cookie", readerCookie);
      expect(second.body.product).toMatchObject({ minQuantity: 0, cost: "0.00", currency: "USD" });
      expect(second.body.product.attributeValues).toEqual(expect.arrayContaining([
        expect.objectContaining({ fieldId: material.body.attribute.id, value: "Wood" }),
        expect.objectContaining({ name: expect.objectContaining({ en: "Finish" }), value: "Gloss" }),
      ]));
      expect(second.body.product.attributeValues).toHaveLength(2);
      const edited = await request(app.server).put(`/api/v1/products/${imported.body.created[0]}`)
        .set(unsafeHeaders(adminCookie)).send({
          name: { en: "Updated", fr: "Updated" }, supplierSku: "AUTO-1", minQuantity: null, cost: null, currency: null,
        });
      expect(edited.status).toBe(200);
      expect(edited.body.product).toMatchObject({ minQuantity: null, cost: null, currency: null });
      const repeated = await request(app.server).post(url).set(unsafeHeaders(adminCookie)).send(base);
      expect(repeated.body).toMatchObject({ created: [], skipped: [0, 1] });
    });

    it("previews selected products and potential field matches without importing", async () => {
      const uploaded = await upload(adminCookie, textPdf(["Example catalog"]));
      const catalogId = uploaded.body.catalog.id as string;
      const started = await request(app.server).post(`/api/v1/catalogs/${catalogId}/extraction`).set(unsafeHeaders(adminCookie));
      const jobId = started.body.job.jobId as string;
      await processGeminiCatalogExtraction(jobId, {
        db, storage: createLocalAssetStorage(uploadDir), maxPages: 100,
      }, async () => ({
        products: [
          {
            name: "First", sku: "EX-123", description: null, categories: [],
            attributes: [{ name: "Material", value: "Steel", sourcePage: 1 }, { name: "Overall Length", value: "30 mm", sourcePage: 1 }],
            pageNumbers: [1], excerpt: "First",
          },
          {
            name: "Second", sku: null, description: null, categories: [],
            attributes: [{ name: "material", value: "Wood", sourcePage: 1 }, { name: "Finish", value: "Matte", sourcePage: 1 }],
            pageNumbers: [1], excerpt: "Second",
          },
          {
            name: "Third", sku: "ex-123", description: null, categories: [],
            attributes: [], pageNumbers: [1], excerpt: "Third",
          },
        ],
      }));
      const set = await request(app.server).post("/api/v1/attribute-sets").set(unsafeHeaders(adminCookie)).send({
        name: { en: "Hardware" },
        fields: [
          { name: { en: "Material" }, dataType: "text" },
          { name: { en: "Length" }, dataType: "decimal", unit: "mm" },
        ],
      });
      expect(set.status).toBe(201);
      const product = await request(app.server).post(`/api/v1/suppliers/${supplierId}/products`).set(unsafeHeaders(adminCookie))
        .send({ name: { en: "Existing" }, supplierSku: "ex-123", cost: "1", currency: "USD", minQuantity: 1 });
      expect(product.status).toBe(201);
      const url = `/api/v1/catalogs/${catalogId}/extraction/preview`;
      const payload = { jobId, indexes: [0, 1, 2] };
      expect((await request(app.server).post(url).set(unsafeHeaders()).send(payload)).status).toBe(401);
      expect((await request(app.server).post(url).set(unsafeHeaders(readerCookie)).send(payload)).status).toBe(403);
      expect((await request(app.server).post(url).set(unsafeHeaders(adminCookie)).send({ jobId, indexes: [0, 0] })).status).toBe(400);
      expect((await request(app.server).post(url).set(unsafeHeaders(adminCookie)).send({ jobId, indexes: [3] })).status).toBe(400);
      expect((await request(app.server).post(url).set(unsafeHeaders(adminCookie)).send({ jobId: NIL_UUID, indexes: [0] })).status).toBe(409);
      const response = await request(app.server).post(url).set(unsafeHeaders(adminCookie)).send(payload);
      expect(response.status).toBe(200);
      expect(response.body.products).toMatchObject([
        { name: "First", duplicateExisting: true, duplicateInSelection: true, attributeNames: ["Material", "Overall Length"], missing: [] },
        { name: "Second", duplicateExisting: false, attributeNames: ["Material", "Finish"], attributeValues: [{ name: "Material", value: "Wood" }, { name: "Finish", value: "Matte" }], missing: ["sku"] },
        { name: "Third", duplicateExisting: true, duplicateInSelection: true, attributeNames: [] },
      ]);
      expect(response.body.attributes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "Material", status: "review", examples: ["Steel", "Wood"] }),
        expect.objectContaining({ name: "Overall Length", status: "review", examples: ["30 mm"] }),
        expect.objectContaining({ name: "Finish", status: "create", examples: ["Matte"] }),
      ]));
      expect(await db.product.count()).toBe(1);
      expect(await db.attributeField.count()).toBe(2);
      expect(await db.auditLog.count({ where: { entityId: catalogId, action: "CATALOG_ANALYSIS_VIEW" } })).toBe(1);
      const individual = await request(app.server).post(url).set(unsafeHeaders(adminCookie)).send({ jobId, indexes: [1] });
      expect(individual.body.products).toHaveLength(1);
      expect(individual.body.attributes.find((attribute: { name: string }) => attribute.name === "material").examples).toEqual(["Wood"]);

      const independent = await request(app.server).post("/api/v1/attributes").set(unsafeHeaders(adminCookie))
        .send({ name: { en: "Material" } });
      expect(independent.status).toBe(201);
      const importUrl = `/api/v1/catalogs/${catalogId}/extraction/import`;
      const importBody = {
        jobId, supplierId,
        products: [
          { index: 0, sku: "EX-123" },
          { index: 1, sku: "NEW-2", cost: "12.50", currency: "USD", minQuantity: 2 },
          { index: 2, sku: "EX-123" },
        ],
        mappings: [{ name: "material", attributeId: independent.body.attribute.id }, { name: "Finish", attributeId: null }],
      };
      expect((await request(app.server).post(importUrl).set(unsafeHeaders()).send(importBody)).status).toBe(401);
      expect((await request(app.server).post(importUrl).set(unsafeHeaders(readerCookie)).send(importBody)).status).toBe(403);
      expect((await request(app.server).post(importUrl).set(unsafeHeaders(adminCookie))
        .send({ ...importBody, supplierId: NIL_UUID })).status).toBe(409);
      const conflictingMappings = await request(app.server).post(importUrl).set(unsafeHeaders(adminCookie))
        .send({ ...importBody, mappings: [
          { name: "material", attributeId: independent.body.attribute.id },
          { name: "Finish", attributeId: independent.body.attribute.id },
        ] });
      expect(conflictingMappings.status).toBe(400);
      expect(await db.product.count()).toBe(1);
      expect(await db.attributeField.count({ where: { attributeSetId: null } })).toBe(1);
      const imported = await request(app.server).post(importUrl).set(unsafeHeaders(adminCookie)).send(importBody);
      expect(imported.status).toBe(200);
      expect(imported.body.created).toHaveLength(1);
      expect(imported.body.skipped).toEqual([0, 2]);
      const stored = await request(app.server).get(`/api/v1/products/${imported.body.created[0]}`).set("Cookie", readerCookie);
      expect(stored.body.product).toMatchObject({
        supplierSku: "NEW-2", cost: "12.50",
        attributeValues: expect.arrayContaining([
          expect.objectContaining({ name: expect.objectContaining({ en: "Material" }), value: "Wood" }),
          expect.objectContaining({ name: expect.objectContaining({ en: "Finish" }), value: "Matte" }),
        ]),
      });
      expect(await db.auditLog.count({ where: { entityId: imported.body.created[0], action: "PRODUCT_CREATE" } })).toBe(1);
      const repeated = await request(app.server).post(importUrl).set(unsafeHeaders(adminCookie)).send(importBody);
      expect(repeated.status).toBe(200);
      expect(repeated.body.created).toEqual([]);
      expect(repeated.body.skipped).toEqual([0, 1, 2]);
      expect(await db.product.count()).toBe(2);
    });
  });

  describe("FR-CLG-05 download catalog", () => {
    it("returns catalog metadata for a workspace and audits the view", async () => {
      const catalog = await uploadAsAdmin();
      const res = await request(app.server)
        .get(`/api/v1/catalogs/${catalog.id}`)
        .set("Cookie", readerCookie);

      expect(res.status).toBe(200);
      expect(res.body.catalog).toMatchObject({
        id: catalog.id,
        supplierId,
        name: "Spring Price List",
      });
      expect(
        await db.auditLog.count({ where: { action: "CATALOG_VIEW", entityId: catalog.id } }),
      ).toBe(1);
    });

    it("opens the PDF inline and audits the browser view", async () => {
      const catalog = await uploadAsAdmin();
      const res = await request(app.server)
        .get(`/api/v1/catalogs/${catalog.id}/view`)
        .set("Cookie", readerCookie);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["content-disposition"]).toContain("inline");
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(Buffer.from(res.body).equals(PDF_BYTES)).toBe(true);
      expect(
        await db.auditLog.count({ where: { action: "CATALOG_PDF_VIEW", entityId: catalog.id } }),
      ).toBe(1);
    });

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
      await rm(path.join(uploadDir, "catalogs", (await storedFiles())[0]!), { force: true });

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

    it("retains catalog files and unassigns catalogs when the supplier is deleted", async () => {
      const first = await uploadAsAdmin();
      await uploadAsAdmin({ name: "Second", version: "1" });
      expect(await storedFiles()).toHaveLength(2);

      const res = await request(app.server)
        .delete(`/api/v1/suppliers/${supplierId}`)
        .set(unsafeHeaders(adminCookie));

      expect(res.status).toBe(204);
      expect(await db.catalog.count({ where: { supplierId: null } })).toBe(2);
      expect(await storedFiles()).toHaveLength(2);
      expect(await db.auditLog.count({ where: { action: "CATALOG_UPDATE" } })).toBe(2);
      const downloaded = await request(app.server).get(`/api/v1/catalogs/${first.id}/download`).set("Cookie", readerCookie);
      expect(downloaded.status).toBe(200);
      expect(downloaded.body).toEqual(PDF_BYTES);
    });
  });

  describe("catalog categories and supplier assignment", () => {
    it("merges categories during supplier-scoped upload without replacing existing tags", async () => {
      const prepared = await request(app.server).put(`/api/v1/suppliers/${supplierId}`)
        .set(unsafeHeaders(adminCookie)).send({ name: "Catalog Supplier", categories: [{ name: "Existing" }] });
      expect(prepared.status).toBe(200);
      const uploaded = await request(app.server).post(`/api/v1/suppliers/${supplierId}/catalogs`)
        .set(unsafeHeaders(adminCookie)).field("name", "Assigned")
        .field("categories", JSON.stringify([{ name: "Existing" }, { name: "New" }]))
        .attach("file", PDF_BYTES, { filename: "assigned.pdf", contentType: "application/pdf" });
      expect(uploaded.status).toBe(201);
      expect(uploaded.body.catalog.categories).toHaveLength(2);
      const supplier = await request(app.server).get(`/api/v1/suppliers/${supplierId}`).set("Cookie", readerCookie);
      expect(supplier.body.supplier.assignedCategories.map((c: { name: { en: string } }) => c.name.en)).toEqual(["Existing", "New"]);
      expect(await db.auditLog.count({ where: { action: "SUPPLIER_UPDATE", entityId: supplierId } })).toBe(2);
    });

    it("merges tags without duplicates and retains supplier tags after reassignment, unassignment and deletion", async () => {
      const withCategories = await request(app.server)
        .put(`/api/v1/suppliers/${supplierId}`)
        .set(unsafeHeaders(adminCookie))
        .send({ name: "Catalog Supplier", categories: [{ name: "Existing" }, { name: "Shared" }] });
      expect(withCategories.status).toBe(200);
      const uploaded = await request(app.server)
        .post("/api/v1/catalogs")
        .set(unsafeHeaders(adminCookie))
        .field("name", "Independent")
        .field("categories", JSON.stringify([{ name: "Shared" }, { name: "New" }, { name: "new" }]))
        .attach("file", PDF_BYTES, { filename: "independent.pdf", contentType: "application/pdf" });
      expect(uploaded.status).toBe(201);
      expect(uploaded.body.catalog.supplierId).toBeNull();
      expect(uploaded.body.catalog.categories.map((c: { name: { en: string } }) => c.name.en)).toEqual(["New", "Shared"]);
      const id = uploaded.body.catalog.id as string;
      const newCategoryId = uploaded.body.catalog.categories[0].id as string;
      const filtered = await request(app.server).get(`/api/v1/catalogs?category=${newCategoryId}`).set("Cookie", readerCookie);
      expect(filtered.body.items.map((c: { id: string }) => c.id)).toContain(id);
      expect(filtered.body.items[0].supplierName).toBeNull();

      const assigned = await request(app.server).patch(`/api/v1/catalogs/${id}`)
        .set(unsafeHeaders(adminCookie)).send({ supplierId });
      expect(assigned.status).toBe(200);
      const supplier = await request(app.server).get(`/api/v1/suppliers/${supplierId}`).set("Cookie", readerCookie);
      expect(supplier.body.supplier.assignedCategories.map((c: { name: { en: string } }) => c.name.en)).toEqual(["Existing", "New", "Shared"]);
      expect(await db.supplierCategory.count({ where: { supplierId } })).toBe(3);
      expect(await db.auditLog.count({ where: { action: "SUPPLIER_UPDATE", entityId: supplierId } })).toBeGreaterThan(0);

      const edited = await request(app.server).patch(`/api/v1/catalogs/${id}`)
        .set(unsafeHeaders(adminCookie)).send({ categories: [{ name: "Later" }] });
      expect(edited.status).toBe(200);
      expect(await db.supplierCategory.count({ where: { supplierId } })).toBe(4);
      const other = await request(app.server).post("/api/v1/suppliers")
        .set(unsafeHeaders(adminCookie)).send({ name: "Other", categories: [{ name: "Preserved" }] });
      const otherId = other.body.supplier.id as string;
      expect((await request(app.server).patch(`/api/v1/catalogs/${id}`)
        .set(unsafeHeaders(adminCookie)).send({ supplierId: otherId })).status).toBe(200);
      expect(await db.supplierCategory.count({ where: { supplierId: otherId } })).toBe(2);
      expect((await request(app.server).patch(`/api/v1/catalogs/${id}`)
        .set(unsafeHeaders(adminCookie)).send({ supplierId: null })).status).toBe(200);
      expect((await request(app.server).delete(`/api/v1/catalogs/${id}`).set(unsafeHeaders(adminCookie))).status).toBe(204);
      expect(await db.supplierCategory.count({ where: { supplierId } })).toBe(4);
      expect(await db.supplierCategory.count({ where: { supplierId: otherId } })).toBe(2);
      expect(await db.auditLog.count({ where: { action: "CATALOG_UPDATE", entityId: id } })).toBe(4);
    });

    it("validates and authorizes category and supplier changes atomically", async () => {
      const catalog = await uploadAsAdmin();
      const invalid = await request(app.server).patch(`/api/v1/catalogs/${catalog.id}`)
        .set(unsafeHeaders(adminCookie)).send({ supplierId: NIL_UUID, categories: [{ name: "Rollback" }] });
      expect(invalid.status).toBe(404);
      expect(await db.category.count({ where: { nameKey: "rollback" } })).toBe(0);
      expect((await request(app.server).patch(`/api/v1/catalogs/${catalog.id}`)
        .set(unsafeHeaders(readerCookie)).send({ supplierId: null })).status).toBe(403);
      expect((await request(app.server).post("/api/v1/catalogs")
        .set(unsafeHeaders(readerCookie)).field("name", "Denied")
        .attach("file", PDF_BYTES, { filename: "test.pdf", contentType: "application/pdf" })).status).toBe(403);
      expect((await request(app.server).post("/api/v1/catalogs")
        .set(unsafeHeaders(adminCookie)).field("name", "Invalid").field("categories", "bad json")
        .attach("file", PDF_BYTES, { filename: "test.pdf", contentType: "application/pdf" })).status).toBe(400);
    });
  });
});

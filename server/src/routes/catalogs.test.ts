import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db.js";
import { createLocalAssetStorage } from "../lib/asset-storage.js";
import { processCatalogExtraction } from "../services/catalog-extraction.js";
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

  describe("catalog analysis jobs", () => {
    it("queues analysis after upload and lets authenticated users check progress", async () => {
      const catalog = await uploadAsAdmin();
      expect(catalog.analysisStatus).toBe("queued");

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

    it("allows admins to retry a failed analysis and denies retry to standard users", async () => {
      const catalog = await uploadAsAdmin();
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
      expect(await db.auditLog.count({ where: { action: "CATALOG_ANALYSIS_START", entityId: catalog.id } })).toBe(1);
    });

    it("allows admins to rerun a completed analysis", async () => {
      const catalog = await uploadAsAdmin();
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
      expect(await db.auditLog.count({ where: { action: "CATALOG_ANALYSIS_START", entityId: catalog.id } })).toBe(1);
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
      const job = await db.catalogExtractionJob.findFirstOrThrow({ where: { catalogId } });

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
      const job = await db.catalogExtractionJob.findFirstOrThrow({ where: { catalogId } });

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
      const job = await db.catalogExtractionJob.findFirstOrThrow({ where: { catalogId } });

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

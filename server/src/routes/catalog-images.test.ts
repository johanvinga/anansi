import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db.js";
import { createLocalAssetStorage } from "../lib/asset-storage.js";
import { processGeminiCatalogExtraction } from "../services/catalog-gemini-extraction.js";
import { ADMIN, READER, createTestApp, createTestDatabase, loginCookie, resetDatabase, seedUser, unsafeHeaders } from "../test/helpers.js";
import { pdfWithImage } from "../test/image-pdf.js";

describe("catalog image review and import", () => {
  let db: Database;
  let app: FastifyInstance;
  let directory: string;
  let admin: string;
  let reader: string;
  let supplierId: string;
  let catalogId: string;
  let jobId: string;

  beforeAll(async () => {
    db = createTestDatabase();
    directory = await mkdtemp(path.join(tmpdir(), "catalog-image-tests-"));
    app = await createTestApp(db, { uploadDir: directory });
  });
  afterAll(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetDatabase(db);
    await seedUser(db, ADMIN, "admin");
    await seedUser(db, READER, "standard");
    admin = await loginCookie(app, ADMIN);
    reader = await loginCookie(app, READER);
    supplierId = (await request(app.server).post("/api/v1/suppliers").set(unsafeHeaders(admin)).send({ name: "Image Supplier" })).body.supplier.id;
    const catalog = await request(app.server).post(`/api/v1/suppliers/${supplierId}/catalogs`)
      .set(unsafeHeaders(admin)).field("name", "Image catalog")
      .attach("file", pdfWithImage(), { filename: "catalog.pdf", contentType: "application/pdf" });
    expect(catalog.status).toBe(201);
    catalogId = catalog.body.catalog.id;
    jobId = (await request(app.server).post(`/api/v1/catalogs/${catalogId}/extraction`).set(unsafeHeaders(admin))).body.job.jobId;
    await processGeminiCatalogExtraction(jobId, { db, storage: createLocalAssetStorage(directory), maxPages: 100 }, async () => ({
      products: [{
        name: "Chair", sku: "CHAIR", description: null, categories: [], attributes: [],
        pageNumbers: [1], excerpt: "Chair", imageRegions: [{ pageNumber: 1, box: [100, 400, 600, 900] }],
      }],
    }));
  });

  it("requires review and keeps imported product images after reanalysis and catalog deletion", async () => {
    expect(await db.product.count()).toBe(0);
    const preview = await request(app.server).post(`/api/v1/catalogs/${catalogId}/extraction/preview`)
      .set(unsafeHeaders(admin)).send({ jobId, indexes: [0] });
    expect(preview.status).toBe(200);
    const imageId = preview.body.products[0].images[0].id as string;
    const imageUrl = `/api/v1/catalogs/${catalogId}/extraction/${jobId}/images/${imageId}`;
    expect((await request(app.server).get(imageUrl).set("Cookie", reader)).status).toBe(403);
    expect((await request(app.server).get(imageUrl).set("Cookie", admin)).status).toBe(200);
    const result = await request(app.server).post(`/api/v1/catalogs/${catalogId}/extraction/import`)
      .set(unsafeHeaders(admin)).send({ jobId, supplierId, products: [{ index: 0, sku: "CHAIR", imageId }] });
    expect(result.status).toBe(200);
    const productId = result.body.created[0] as string;
    const productImage = await db.productImage.findUniqueOrThrow({ where: { productId } });
    expect((await request(app.server).get(`/api/v1/products/${productId}/image`).set("Cookie", reader)).status).toBe(200);
    expect((await request(app.server).post(`/api/v1/catalogs/${catalogId}/extraction`).set(unsafeHeaders(admin))).status).toBe(202);
    expect((await request(app.server).get(imageUrl).set("Cookie", admin)).status).toBe(404);
    expect((await request(app.server).delete(`/api/v1/catalogs/${catalogId}`).set(unsafeHeaders(admin))).status).toBe(204);
    expect((await db.productImage.findUniqueOrThrow({ where: { productId } })).storageKey).toBe(productImage.storageKey);
    expect((await request(app.server).get(`/api/v1/products/${productId}/image`).set("Cookie", reader)).status).toBe(200);
  });

  it("rejects foreign image IDs without creating a product", async () => {
    const result = await request(app.server).post(`/api/v1/catalogs/${catalogId}/extraction/import`)
      .set(unsafeHeaders(admin)).send({
        jobId, supplierId, products: [{ index: 0, sku: "CHAIR", imageId: "9f1c2a4e-1111-4222-8333-444455556666" }],
      });
    expect(result.status).toBe(409);
    expect(await db.product.count()).toBe(0);
  });

  it("rejects an image from a page that is not a product source", async () => {
    const image = await db.catalogImageCandidate.findFirstOrThrow({ where: { jobId } });
    await db.catalogImageCandidate.update({ where: { id: image.id }, data: { pageNumber: 2 } });
    const result = await request(app.server).post(`/api/v1/catalogs/${catalogId}/extraction/import`)
      .set(unsafeHeaders(admin)).send({
        jobId, supplierId, products: [{ index: 0, sku: "CHAIR", imageId: image.id }],
      });
    expect(result.status).toBe(409);
    expect(await db.product.count()).toBe(0);
    expect(await db.storedFileCleanup.count()).toBe(1);
  });

  it("keeps product candidates and reports image storage failures", async () => {
    const next = await request(app.server).post(`/api/v1/catalogs/${catalogId}/extraction`).set(unsafeHeaders(admin));
    const storage = createLocalAssetStorage(directory);
    await processGeminiCatalogExtraction(next.body.job.jobId, {
      db, maxPages: 100, storage: { ...storage, async save() { throw new Error("storage unavailable"); } },
    }, async () => ({
      products: [{
        name: "Chair", sku: "CHAIR", description: null, categories: [], attributes: [],
        pageNumbers: [1], excerpt: "Chair",
      }],
    }));
    const extraction = await request(app.server).get(`/api/v1/catalogs/${catalogId}/extraction`).set("Cookie", admin);
    expect(extraction.body.job.status).toBe("processed");
    expect(extraction.body.job.results.products).toHaveLength(1);
    expect(extraction.body.job.results.imageWarnings).toContain("An image on page 1 could not be stored.");
    const preview = await request(app.server).post(`/api/v1/catalogs/${catalogId}/extraction/preview`)
      .set(unsafeHeaders(admin)).send({ jobId: next.body.job.jobId, indexes: [0] });
    expect(preview.body.imageWarnings).toContain("An image on page 1 could not be stored.");
  });
});

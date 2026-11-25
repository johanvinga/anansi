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

const PDF = Buffer.from("%PDF-1.4 split prompt catalog\n%%EOF\n");

describe("split catalog analysis", () => {
  let db: Database;
  let app: FastifyInstance;
  let uploadDir: string;
  let adminCookie: string;
  let readerCookie: string;
  let catalogId: string;

  beforeAll(async () => {
    db = createTestDatabase();
    uploadDir = await mkdtemp(path.join(tmpdir(), "catalog-tag-tests-"));
    app = await createTestApp(db, { uploadDir, catalogExtractionEnabled: true });
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
    const uploaded = await request(app.server)
      .post("/api/v1/catalogs")
      .set(unsafeHeaders(adminCookie))
      .field("name", "Split catalog")
      .attach("file", PDF, { filename: "split.pdf", contentType: "application/pdf" });
    expect(uploaded.status).toBe(201);
    catalogId = uploaded.body.catalog.id as string;
  });

  it("starts Prompt A independently and records its prompt", async () => {
    const started = await request(app.server)
      .post(`/api/v1/catalogs/${catalogId}/extraction`)
      .set(unsafeHeaders(adminCookie))
      .send({ prompt: "supplier" });
    expect(started.status).toBe(202);
    expect(started.body.job).toMatchObject({ prompt: "supplier", status: "queued" });
  });

  it("starts Prompt B independently and records its prompt", async () => {
    const started = await request(app.server)
      .post(`/api/v1/catalogs/${catalogId}/extraction`)
      .set(unsafeHeaders(adminCookie))
      .send({ prompt: "tags" });
    expect(started.status).toBe(202);
    expect(started.body.job).toMatchObject({ prompt: "tags", status: "queued" });
  });

  it("rejects invalid prompt values", async () => {
    const started = await request(app.server)
      .post(`/api/v1/catalogs/${catalogId}/extraction`)
      .set(unsafeHeaders(adminCookie))
      .send({ prompt: "combined" });
    expect(started.status).toBe(400);
  });

  it("allows users to view extraction status but only admins to start it", async () => {
    const readerStart = await request(app.server)
      .post(`/api/v1/catalogs/${catalogId}/extraction`)
      .set(unsafeHeaders(readerCookie))
      .send({ prompt: "supplier" });
    expect(readerStart.status).toBe(403);

    const view = await request(app.server)
      .get(`/api/v1/catalogs/${catalogId}/extraction`)
      .set("Cookie", readerCookie);
    expect(view.status).toBe(200);
  });

  it("creates and applies exact supplier and tag review suggestions", async () => {
    const supplierJob = await db.catalogExtractionJob.create({
      data: {
        catalogId,
        prompt: "supplier",
        status: "processed",
        stage: "completed",
        progress: 100,
        totalPages: 1,
        results: {
          supplier: {
            name: { value: "Review Supplier", pageNumber: 1, excerpt: "Review Supplier" },
            street: null,
            city: null,
            stateRegion: null,
            postalCode: null,
            country: null,
            email: null,
            phone: null,
            contacts: [],
          },
        },
      },
    });
    const tag = await db.tag.create({
      data: { nameEn: "Chair", nameFr: "Fauteuil", nameKey: "chair" },
    });
    const tagJob = await db.catalogExtractionJob.create({
      data: {
        catalogId,
        prompt: "tags",
        status: "processed",
        stage: "completed",
        progress: 100,
        totalPages: 1,
        results: {
          catalogTags: [{ en: "Chair", fr: "Fauteuil", confidence: 0.99, evidence: [{ pageNumber: 1, excerpt: "Chair" }] }],
          products: [{ name: "Office Chair", evidence: [{ pageNumber: 1, excerpt: "Office Chair" }], tags: [{ en: "Chair", fr: "Fauteuil", confidence: 0.99, evidence: [{ pageNumber: 1, excerpt: "Chair" }] }] }],
        },
      },
    });

    const supplierReview = await request(app.server)
      .get(`/api/v1/catalogs/${catalogId}/extraction/${supplierJob.id}/supplier-review`)
      .set("Cookie", adminCookie);
    expect(supplierReview.status).toBe(200);
    expect(supplierReview.body.supplier.name.value).toBe("Review Supplier");

    const appliedSupplier = await request(app.server)
      .post(`/api/v1/catalogs/${catalogId}/extraction/supplier-review`)
      .set(unsafeHeaders(adminCookie))
      .send({
        jobId: supplierJob.id,
        action: "create",
        name: "Review Supplier",
        address: { street: null, city: null, stateRegion: null, postalCode: null, country: null },
        contacts: [],
      });
    expect(appliedSupplier.status).toBe(200);

    const tagReview = await request(app.server)
      .get(`/api/v1/catalogs/${catalogId}/extraction/${tagJob.id}/tag-review`)
      .set("Cookie", adminCookie);
    expect(tagReview.status).toBe(200);
    expect(tagReview.body.catalogTags[0].existing.id).toBe(tag.id);

    const appliedTags = await request(app.server)
      .post(`/api/v1/catalogs/${catalogId}/extraction/tag-review`)
      .set(unsafeHeaders(adminCookie))
      .send({
        jobId: tagJob.id,
        catalogTagIds: [tag.id],
        newCatalogTags: [],
        productTagIds: [],
      });
    expect(appliedTags.status).toBe(200);
  });
});

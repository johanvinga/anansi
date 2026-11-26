import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: () => ({
    promise: Promise.resolve({ numPages: 1 }),
    destroy: async () => undefined,
  }),
}));

import type { Database } from "../db.js";
import type { AssetStorage } from "../lib/asset-storage.js";
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
} from "../test/helpers.js";

const PDF = Buffer.from("%PDF-1.4 status catalog\n%%EOF\n");

interface RecentCatalog {
  id: string;
  name: string;
  supplierName: string | null;
  analysisStatus: string;
  viewedAt: string;
}

describe("catalog analysis status and recent views", () => {
  let db: Database;
  let app: FastifyInstance;
  let uploadDir: string;
  let adminCookie: string;
  let readerCookie: string;

  beforeAll(async () => {
    db = createTestDatabase();
    uploadDir = await mkdtemp(path.join(tmpdir(), "catalog-status-"));
    app = await createTestApp(db, { uploadDir });
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
  });

  async function uploadCatalog(name: string): Promise<string> {
    const res = await request(app.server)
      .post("/api/v1/catalogs")
      .set(unsafeHeaders(adminCookie))
      .field("name", name)
      .attach("file", PDF, { filename: `${name}.pdf`, contentType: "application/pdf" });
    expect(res.status).toBe(201);
    return (res.body as { catalog: { id: string } }).catalog.id;
  }

  async function runAnalysis(catalogId: string, prompt: "supplier" | "tags"): Promise<void> {
    const job = await db.catalogExtractionJob.create({ data: { catalogId, prompt } });
    const storage = {
      openRead: async function* () {
        yield PDF;
      },
    } as unknown as AssetStorage;
    await processGeminiCatalogExtraction(
      job.id,
      { db, storage, maxPages: 10 },
      async () => ({ supplier: null, products: [] }),
      prompt,
    );
  }

  async function statusOf(catalogId: string): Promise<string | undefined> {
    return (await db.catalog.findUnique({ where: { id: catalogId } }))?.analysisStatus;
  }

  async function recent(cookie: string): Promise<RecentCatalog[]> {
    const res = await request(app.server).get("/api/v1/catalogs/recent").set("Cookie", cookie);
    expect(res.status).toBe(200);
    return (res.body as { items: RecentCatalog[] }).items;
  }

  it("marks a catalog metadata_only after only the supplier analysis completes", async () => {
    const catalogId = await uploadCatalog("Metadata only");
    await runAnalysis(catalogId, "supplier");
    expect(await statusOf(catalogId)).toBe("metadata_only");
  });

  it("marks a catalog processed once the category analysis completes", async () => {
    const catalogId = await uploadCatalog("Fully analyzed");
    await runAnalysis(catalogId, "supplier");
    await runAnalysis(catalogId, "tags");
    expect(await statusOf(catalogId)).toBe("processed");
  });

  it("keeps a catalog processed when the supplier analysis is rerun after categories", async () => {
    const catalogId = await uploadCatalog("Rerun");
    await runAnalysis(catalogId, "tags");
    await runAnalysis(catalogId, "supplier");
    expect(await statusOf(catalogId)).toBe("processed");
  });

  it("lists the catalogs the current user viewed, newest first", async () => {
    const first = await uploadCatalog("First viewed");
    const second = await uploadCatalog("Second viewed");
    await uploadCatalog("Never viewed");
    for (const id of [first, second, first]) {
      const res = await request(app.server).get(`/api/v1/catalogs/${id}`).set("Cookie", readerCookie);
      expect(res.status).toBe(200);
    }

    expect((await recent(readerCookie)).map((item) => item.name)).toEqual(["First viewed", "Second viewed"]);
    expect(await recent(adminCookie)).toEqual([]);
  });

  it("skips deleted catalogs", async () => {
    const kept = await uploadCatalog("Kept");
    const removed = await uploadCatalog("Removed");
    for (const id of [kept, removed]) {
      await request(app.server).get(`/api/v1/catalogs/${id}`).set("Cookie", readerCookie);
    }
    const deleted = await request(app.server).delete(`/api/v1/catalogs/${removed}`).set(unsafeHeaders(adminCookie));
    expect(deleted.status).toBe(204);

    expect((await recent(readerCookie)).map((item) => item.name)).toEqual(["Kept"]);
  });

  it("requires authentication", async () => {
    const res = await request(app.server).get("/api/v1/catalogs/recent");
    expect(res.status).toBe(401);
  });
});

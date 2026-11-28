import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { Database } from "../db.js";
import {
  ADMIN,
  createTestDatabase,
  loginCookie,
  resetDatabase,
  seedUser,
  testConfig,
  TEST_DATABASE_URL,
  unsafeHeaders,
} from "../test/helpers.js";
import { CATALOG_EXTRACTION_QUEUE, createCatalogExtractionQueue, createRedisConnection } from "./catalog-extraction.queue.js";
import { resetCatalogExtractionJobs } from "./catalog-extraction-reset.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const redisUrl = process.env.RESET_TEST_REDIS_URL;

describe("resetting catalog extraction", () => {
  let db: Database;

  beforeAll(() => { db = createTestDatabase(); });
  beforeEach(async () => { await resetDatabase(db); });
  afterAll(async () => { await db.$disconnect(); });

  async function catalog(analysisStatus: "queued" | "processing" | "failed") {
    return db.catalog.create({
      data: {
        name: "Reset test",
        originalFileName: "test.pdf",
        storageKey: `${randomUUID()}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 10,
        analysisStatus,
      },
    });
  }

  it("removes pending jobs and restores prior analysis without losing results", async () => {
    const metadata = await catalog("queued");
    const complete = await catalog("processing");
    const stuck = await catalog("queued");
    const failed = await catalog("failed");
    const supplier = await db.catalogExtractionJob.create({
      data: { catalogId: metadata.id, status: "processed", prompt: "supplier", results: { supplier: "retained" }, createdAt: new Date("2020-01-01") },
    });
    await db.catalogExtractionJob.create({
      data: { catalogId: complete.id, status: "processed", prompt: "tags", createdAt: new Date("2020-01-01") },
    });
    await db.catalogExtractionJob.create({
      data: { catalogId: complete.id, status: "processed", prompt: "supplier", createdAt: new Date("2020-01-02") },
    });
    const queued = await db.catalogExtractionJob.create({ data: { catalogId: metadata.id } });
    await db.catalogExtractionJob.create({ data: { catalogId: complete.id, status: "processing" } });
    const failure = await db.catalogExtractionJob.create({ data: { catalogId: failed.id, status: "failed" } });
    const imageKey = `images/${randomUUID()}`;
    await db.catalogImageCandidate.create({
      data: { jobId: queued.id, storageKey: imageKey, pageNumber: 1, mimeType: "image/png", sizeBytes: 10 },
    });

    expect(await resetCatalogExtractionJobs(db, false)).toBe(3);
    expect((await db.catalog.findUniqueOrThrow({ where: { id: metadata.id } })).analysisStatus).toBe("metadata_only");
    expect((await db.catalog.findUniqueOrThrow({ where: { id: complete.id } })).analysisStatus).toBe("processed");
    expect((await db.catalog.findUniqueOrThrow({ where: { id: stuck.id } })).analysisStatus).toBe("not_processed");
    expect((await db.catalog.findUniqueOrThrow({ where: { id: failed.id } })).analysisStatus).toBe("failed");
    expect((await db.catalogExtractionJob.findUniqueOrThrow({ where: { id: supplier.id } })).results).toEqual({ supplier: "retained" });
    expect(await db.catalogExtractionJob.findUnique({ where: { id: queued.id } })).toBeNull();
    expect(await db.catalogExtractionJob.findUnique({ where: { id: failure.id } })).not.toBeNull();
    expect(await db.storedFileCleanup.findUnique({ where: { storageKey: imageKey } })).not.toBeNull();
    const audits = await db.auditLog.findMany({ where: { action: "CATALOG_ANALYSIS_RESET" } });
    expect(audits).toHaveLength(3);
    expect(audits.find((audit) => audit.entityId === metadata.id)?.changes).toEqual({
      analysisStatus: { before: "queued", after: "metadata_only" },
    });
    expect(await resetCatalogExtractionJobs(db, false)).toBe(0);
  });

  it("includes failed jobs only when requested", async () => {
    const item = await catalog("failed");
    await db.catalogExtractionJob.create({ data: { catalogId: item.id, status: "failed" } });
    expect(await resetCatalogExtractionJobs(db, false)).toBe(0);
    expect(await resetCatalogExtractionJobs(db, true)).toBe(1);
    expect((await db.catalog.findUniqueOrThrow({ where: { id: item.id } })).analysisStatus).toBe("not_processed");
    expect(await db.catalogExtractionJob.count({ where: { catalogId: item.id } })).toBe(0);
  });

  it.skipIf(!redisUrl)("runs the command against Redis and permits a manual extraction", async () => {
    if (!redisUrl) throw new Error("RESET_TEST_REDIS_URL must point to a dedicated disposable Redis instance");
    const item = await catalog("queued");
    const oldJob = await db.catalogExtractionJob.create({ data: { catalogId: item.id, prompt: "supplier" } });
    const connection = createRedisConnection(redisUrl);
    const queue = new Queue(CATALOG_EXTRACTION_QUEUE, { connection });
    const extractionQueue = createCatalogExtractionQueue(redisUrl);
    const app = await buildApp(testConfig(), { db, logger: false, catalogExtractionQueue: extractionQueue });
    const runCommand = async (...args: string[]) => {
      await execFileAsync(process.execPath, [require.resolve("tsx/cli"), "src/scripts/reset-extraction-queue.ts", ...args], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: TEST_DATABASE_URL,
          REDIS_URL: redisUrl,
          SESSION_SECRET: "test-session-secret-that-is-long-enough",
          CATALOG_EXTRACTION_ENABLED: "false",
          STORAGE_BACKEND: "local",
        },
        timeout: 30_000,
      });
    };
    try {
      await queue.add("analyze-catalog", { extractionJobId: oldJob.id, prompt: "supplier" }, { jobId: oldJob.id });
      await runCommand();
      expect(await queue.getJob(oldJob.id)).toBeUndefined();
      expect(await db.catalogExtractionJob.findUnique({ where: { id: oldJob.id } })).toBeNull();
      expect((await db.catalog.findUniqueOrThrow({ where: { id: item.id } })).analysisStatus).toBe("not_processed");

      await app.ready();
      await seedUser(db, ADMIN, "admin");
      const cookie = await loginCookie(app, ADMIN);
      const response = await request(app.server)
        .post(`/api/v1/catalogs/${item.id}/extraction`)
        .set(unsafeHeaders(cookie))
        .send({ prompt: "supplier" });
      expect(response.status).toBe(202);
      const newJobId = (response.body as { job: { jobId: string } }).job.jobId;
      expect(newJobId).not.toBe(oldJob.id);
      expect(await queue.getJob(newJobId)).toBeDefined();
      expect((await db.catalog.findUniqueOrThrow({ where: { id: item.id } })).analysisStatus).toBe("queued");

      const failedCatalog = await catalog("failed");
      const failedJob = await db.catalogExtractionJob.create({ data: { catalogId: failedCatalog.id, status: "failed" } });
      await runCommand("--include-failed");
      expect(await queue.getJob(newJobId)).toBeUndefined();
      expect(await db.catalogExtractionJob.findUnique({ where: { id: failedJob.id } })).toBeNull();
      expect((await db.catalog.findUniqueOrThrow({ where: { id: failedCatalog.id } })).analysisStatus).toBe("not_processed");
    } finally {
      await queue.close();
      connection.disconnect();
      await app.close();
    }
  }, 60_000);
});

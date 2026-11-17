import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import type { Database } from "../db.js";
import { createLocalAssetStorage } from "../lib/asset-storage.js";
import { hashPassword } from "../lib/password.js";
import {
  ADMIN,
  READER,
  TEST_ORIGIN,
  createTestApp,
  createTestDatabase,
  loginCookie,
  resetDatabase,
  seedUser,
  testConfig,
  unsafeHeaders,
} from "../test/helpers.js";

const PDF = Buffer.from("%PDF-1.4\n%%EOF\n");
const endpoint = "/api/v1/public/catalogs";

describe("public catalog upload", () => {
  let db: Database;
  let app: FastifyInstance;
  let uploadDir: string;

  beforeAll(async () => {
    db = createTestDatabase();
    uploadDir = await mkdtemp(path.join(tmpdir(), "public-catalog-tests-"));
    app = await createTestApp(db, { uploadDir, maxUploadMb: 1, publicCatalogMaxUploadMb: 1 });
  });

  afterAll(async () => {
    await app.close();
    await rm(uploadDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await seedUser(db, ADMIN, "admin");
    await seedUser(db, READER, "standard");
    await rm(uploadDir, { recursive: true, force: true });
  });

  function upload(account = ADMIN, filename = "spring prices.PDF", data = PDF, contentType = "application/pdf") {
    return request(app.server).post(endpoint)
      .set("X-Catalog-Upload", "1")
      .auth(account.email, account.password)
      .attach("file", data, { filename, contentType });
  }

  it("creates an unassigned catalog with a derived name and transactional upload audit, without a session or analysis", async () => {
    const res = await upload();
    expect(res.status).toBe(201);
    const user = await db.user.findUniqueOrThrow({ where: { email: ADMIN.email } });
    expect(res.body.catalog).toEqual(expect.objectContaining({
      name: "spring prices",
      originalFileName: "spring prices.PDF",
      supplierId: null,
      version: null,
      categories: [],
      uploadedById: user.id,
      sizeBytes: PDF.length,
      analysisStatus: "not_processed",
    }));
    expect(await db.session.count()).toBe(0);
    expect(await db.catalogExtractionJob.count()).toBe(0);
    expect(await db.product.count()).toBe(0);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "CATALOG_UPLOAD" } });
    expect(audit.actorUserId).toBe(user.id);
    expect(audit.entityId).toBe(res.body.catalog.id);
    expect(audit.requestId).toBe(res.headers["x-request-id"]);
    expect(await db.auditLog.count({ where: { action: "LOGIN_SUCCESS", actorUserId: user.id } })).toBe(1);
    expect(await readdir(path.join(uploadDir, "catalogs"))).toHaveLength(1);
  });

  it("handles provided names and safe generated filename fallbacks", async () => {
    const named = await upload().field("name", "  My catalog  ");
    expect(named.status).toBe(201);
    expect(named.body.catalog.name).toBe("My catalog");
    const fallback = await upload(ADMIN, ".pdf");
    expect(fallback.status).toBe(201);
    expect(fallback.body.catalog.name).toBe("Catalog");
    const long = await upload(ADMIN, `${"a".repeat(220)}.pdf`);
    expect(long.status).toBe(201);
    expect(long.body.catalog.name).toBe("a".repeat(200));
    const unicode = await upload(ADMIN, "catalogue-é.pdf");
    expect(unicode.status).toBe(201);
    expect(unicode.body.catalog.name).toBe("catalogue-é");
    const surrogate = await upload(ADMIN, `${"a".repeat(199)}😀.pdf`);
    expect(surrogate.status).toBe(201);
    expect(surrogate.body.catalog.name).toBe("a".repeat(199));
  });

  it("rejects invalid metadata, unsupported fields and multiple files", async () => {
    const blank = await upload().field("name", "   ");
    const long = await upload().field("name", "a".repeat(201));
    const duplicate = await upload().field("name", "first").field("name", "second");
    const extra = await upload().field("supplierId", "anything");
    const multiple = await upload().attach("file", PDF, { filename: "second.pdf", contentType: "application/pdf" });
    const missing = await request(app.server).post(endpoint).set("X-Catalog-Upload", "1")
      .auth(ADMIN.email, ADMIN.password).field("name", "No file");
    const malformed = await request(app.server).post(endpoint).set("X-Catalog-Upload", "1")
      .auth(ADMIN.email, ADMIN.password)
      .set("Content-Type", "multipart/form-data; boundary=invalid")
      .send("invalid multipart body");
    const truncated = await request(app.server).post(endpoint).set("X-Catalog-Upload", "1")
      .auth(ADMIN.email, ADMIN.password)
      .set("Content-Type", "multipart/form-data; boundary=example")
      .send('--example\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4');
    for (const res of [blank, long, duplicate, extra, multiple, missing, malformed, truncated]) {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(await db.catalog.count()).toBe(0);
  });

  it("rejects non-PDF content and oversized uploads without storing a catalog", async () => {
    const mime = await upload(ADMIN, "document.pdf", PDF, "text/plain");
    const signature = await upload(ADMIN, "document.pdf", Buffer.from("not pdf"));
    const large = Buffer.alloc(1024 * 1024 + 1);
    PDF.copy(large);
    const oversized = await upload(ADMIN, "document.pdf", large);
    expect([mime.status, signature.status, oversized.status]).toEqual([415, 415, 413]);
    expect(await db.catalog.count()).toBe(0);
    const atLimit = large.subarray(0, 1024 * 1024);
    expect((await upload(ADMIN, "document.pdf", atLimit)).status).toBe(201);
  });

  it("accepts exactly 100 MiB only on the public endpoint and rejects larger files", async () => {
    const publicApp = await createTestApp(db, { uploadDir, maxUploadMb: 1 });
    try {
      const bytes = Buffer.alloc(100 * 1024 * 1024 + 1);
      PDF.copy(bytes);
      const sendPublic = (data: Buffer) => request(publicApp.server).post(endpoint)
        .set("X-Catalog-Upload", "1").auth(ADMIN.email, ADMIN.password)
        .attach("file", data, { filename: "large.pdf", contentType: "application/pdf" });
      const accepted = await sendPublic(bytes.subarray(0, 100 * 1024 * 1024));
      expect(accepted.status).toBe(201);
      expect(accepted.body.catalog.sizeBytes).toBe(100 * 1024 * 1024);
      const rejected = await sendPublic(bytes);
      expect(rejected.status).toBe(413);
      const cookie = await loginCookie(publicApp, ADMIN);
      const browserUpload = await request(publicApp.server).post("/api/v1/catalogs")
        .set(unsafeHeaders(cookie)).field("name", "Browser catalog")
        .attach("file", bytes.subarray(0, 1024 * 1024 + 1), { filename: "large.pdf", contentType: "application/pdf" });
      expect(browserUpload.status).toBe(413);
      expect(await db.catalog.count()).toBe(1);
    } finally {
      await publicApp.close();
    }
  });

  it("authenticates only active admins and rechecks account state for each request", async () => {
    const wrong = await upload({ ...ADMIN, password: "wrong-password" });
    const unknown = await upload({ email: "missing@test.local", password: "wrong-password" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    expect(wrong.headers["www-authenticate"]).toContain("Basic");
    const standard = await upload(READER);
    expect(standard.status).toBe(403);
    await db.user.update({ where: { email: ADMIN.email }, data: { mustChangePassword: true } });
    expect((await upload()).status).toBe(403);
    await db.user.update({ where: { email: ADMIN.email }, data: { isActive: false } });
    expect((await upload()).status).toBe(401);
    const attempts = await db.auditLog.findMany({ where: { action: "LOGIN_FAILED" } });
    expect(attempts.map((entry) => entry.actorEmail)).toContain(ADMIN.email);
    expect(JSON.stringify(attempts)).not.toContain("wrong-password");
  });

  it("uses changed passwords and roles on the next request", async () => {
    const newPassword = "ChangedPassword123!";
    await db.user.update({
      where: { email: ADMIN.email },
      data: { passwordHash: await hashPassword(newPassword) },
    });
    expect((await upload()).status).toBe(401);
    expect((await upload({ ...ADMIN, password: newPassword })).status).toBe(201);
    await db.user.update({ where: { email: ADMIN.email }, data: { role: "standard" } });
    expect((await upload({ ...ADMIN, password: newPassword })).status).toBe(403);
  });

  it("surfaces storage failures and removes the stored file if the catalog transaction fails", async () => {
    const localStorage = createLocalAssetStorage(uploadDir);
    let failStorage = false;
    const storage = {
      ...localStorage,
      async save(key: string, data: Buffer, mimeType?: string) {
        if (failStorage) throw new Error("Simulated storage failure");
        await localStorage.save(key, data, mimeType);
        vi.spyOn(db, "$transaction").mockImplementationOnce(() => {
          throw new Error("Simulated catalog transaction failure");
        });
      },
    };
    const failing = await buildApp(testConfig({ uploadDir, catalogExtractionEnabled: false }), {
      db, storage, logger: false,
    });
    await failing.ready();
    try {
      const res = await request(failing.server).post(endpoint).set("X-Catalog-Upload", "1")
        .auth(ADMIN.email, ADMIN.password)
        .attach("file", PDF, { filename: "a.pdf", contentType: "application/pdf" });
      expect(res.status).toBe(500);
      expect(await readdir(path.join(uploadDir, "catalogs"))).toEqual([]);
      expect(await db.catalog.count()).toBe(0);
      expect(await db.auditLog.count({ where: { action: "CATALOG_UPLOAD" } })).toBe(0);
      failStorage = true;
      const storageError = await request(failing.server).post(endpoint).set("X-Catalog-Upload", "1")
        .auth(ADMIN.email, ADMIN.password)
        .attach("file", PDF, { filename: "a.pdf", contentType: "application/pdf" });
      expect(storageError.status).toBe(500);
      expect(await readdir(path.join(uploadDir, "catalogs"))).toEqual([]);
      expect(await db.catalog.count()).toBe(0);
    } finally {
      vi.restoreAllMocks();
      await failing.close();
    }
  });

  it("does not accept browser requests or a session cookie as Basic authentication", async () => {
    const cookie = await loginCookie(app, ADMIN);
    const sessionOnly = await request(app.server).post(endpoint)
      .set("X-Catalog-Upload", "1").set("Cookie", cookie)
      .attach("file", PDF, { filename: "a.pdf", contentType: "application/pdf" });
    const noHeader = await request(app.server).post(endpoint)
      .auth(ADMIN.email, ADMIN.password)
      .attach("file", PDF, { filename: "a.pdf", contentType: "application/pdf" });
    const origin = await upload().set("Origin", TEST_ORIGIN);
    const fetch = await upload().set("Sec-Fetch-Site", "same-origin");
    const preflight = await request(app.server).options(endpoint)
      .set("Origin", TEST_ORIGIN).set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,x-catalog-upload");
    expect(sessionOnly.status).toBe(401);
    expect([noHeader.status, origin.status, fetch.status]).toEqual([403, 403, 403]);
    expect(preflight.status).toBe(403);
    const oldRoute = await request(app.server).post("/api/v1/catalogs").set("Cookie", cookie)
      .attach("file", PDF, { filename: "a.pdf", contentType: "application/pdf" });
    expect(oldRoute.status).toBe(403);
    const oldWithoutName = await request(app.server).post("/api/v1/catalogs").set(unsafeHeaders(cookie))
      .attach("file", PDF, { filename: "a.pdf", contentType: "application/pdf" });
    expect(oldWithoutName.status).toBe(400);
  });

  it("shares account throttling with login, limits failures by IP, and does not limit successes", async () => {
    const limited = await createTestApp(db, { uploadDir, loginRateLimit: 2 });
    try {
      const call = (email: string, password: string) => request(limited.server).post(endpoint)
        .set("X-Catalog-Upload", "1").auth(email, password)
        .attach("file", PDF, { filename: "a.pdf", contentType: "application/pdf" });
      expect((await call(ADMIN.email, ADMIN.password)).status).toBe(201);
      expect((await call(ADMIN.email, ADMIN.password)).status).toBe(201);
      expect((await call(ADMIN.email, "wrong")).status).toBe(401);
      expect((await call(ADMIN.email, "wrong")).status).toBe(401);
      const blocked = await call(ADMIN.email, ADMIN.password);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      const login = await request(limited.server).post("/api/v1/auth/login")
        .set("Origin", TEST_ORIGIN).send(ADMIN);
      expect(login.status).toBe(429);
      const other = await call(READER.email, READER.password);
      expect(other.status).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it("bounds concurrent authentication attempts", async () => {
    const limited = await createTestApp(db, { uploadDir, loginRateLimit: 2 });
    try {
      const attempts = await Promise.all(Array.from({ length: 8 }, () =>
        request(limited.server).post(endpoint).set("X-Catalog-Upload", "1")
          .auth(ADMIN.email, "wrong")
          .attach("file", PDF, { filename: "a.pdf", contentType: "application/pdf" }),
      ));
      expect(attempts.filter((res) => res.status === 401)).toHaveLength(2);
      expect(attempts.filter((res) => res.status === 429)).toHaveLength(6);
      expect(attempts.filter((res) => res.status === 429).every((res) => Number(res.headers["retry-after"]) > 0)).toBe(true);
    } finally {
      await limited.close();
    }
  });

  it("requires HTTPS in production and trusts forwarded headers only from loopback", async () => {
    const production = await createTestApp(db, { uploadDir, nodeEnv: "production" });
    try {
      const base = { method: "POST" as const, url: endpoint, headers: { "x-catalog-upload": "1" } };
      const plaintext = await production.inject({ ...base, remoteAddress: "127.0.0.1" });
      expect(plaintext.statusCode).toBe(403);
      const forged = await production.inject({
        ...base,
        remoteAddress: "203.0.113.10",
        headers: { ...base.headers, "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.20" },
      });
      expect(forged.statusCode).toBe(403);
      const proxied = await production.inject({
        ...base,
        remoteAddress: "127.0.0.1",
        headers: { ...base.headers, "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.20" },
      });
      expect(proxied.statusCode).toBe(401);
      const audit = await db.auditLog.findFirstOrThrow({ where: { action: "LOGIN_FAILED", requestId: proxied.headers["x-request-id"] } });
      expect(audit.ipAddress).toBe("203.0.113.20");
    } finally {
      await production.close();
    }
  });
});

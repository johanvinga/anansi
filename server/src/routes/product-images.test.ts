import { createCanvas } from "@napi-rs/canvas";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db.js";
import { createLocalAssetStorage } from "../lib/asset-storage.js";
import { processStoredFileCleanup } from "../services/stored-file-cleanup.js";
import { ADMIN, READER, createTestApp, createTestDatabase, loginCookie, resetDatabase, seedUser, unsafeHeaders } from "../test/helpers.js";

describe("product images", () => {
  let db: Database;
  let app: FastifyInstance;
  let directory: string;
  let admin: string;
  let reader: string;
  let productId: string;

  beforeAll(async () => {
    db = createTestDatabase();
    directory = await mkdtemp(path.join(tmpdir(), "product-image-tests-"));
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
    const supplier = await request(app.server).post("/api/v1/suppliers").set(unsafeHeaders(admin)).send({ name: "Images Inc" });
    const product = await request(app.server).post(`/api/v1/suppliers/${supplier.body.supplier.id}/products`)
      .set(unsafeHeaders(admin)).send({ name: { en: "Chair" }, supplierSku: "CHAIR", cost: "1", currency: "USD", minQuantity: 1 });
    productId = product.body.product.id;
  });

  function image(mime: "image/png" | "image/jpeg" | "image/webp") {
    const canvas = createCanvas(8, 8);
    canvas.getContext("2d").fillRect(0, 0, 8, 8);
    return mime === "image/png" ? canvas.toBuffer(mime) : canvas.toBuffer(mime, 85);
  }
  function upload(cookie: string, buffer: Buffer, mime: string) {
    return request(app.server).put(`/api/v1/products/${productId}/image`)
      .set(unsafeHeaders(cookie)).attach("file", buffer, { filename: "image", contentType: mime });
  }

  it.each(["image/png", "image/jpeg", "image/webp"] as const)("uploads and serves validated %s privately", async (mime) => {
    expect((await upload(reader, image(mime), mime)).status).toBe(403);
    const response = await upload(admin, image(mime), mime);
    expect(response.status).toBe(200);
    expect(response.body.image).toMatchObject({ mimeType: mime });
    expect((await request(app.server).get(`/api/v1/products/${productId}/image`)).status).toBe(401);
    const read = await request(app.server).get(`/api/v1/products/${productId}/image`).set("Cookie", reader);
    expect(read.status).toBe(200);
    expect(read.headers["content-type"]).toBe(mime);
    const detail = await request(app.server).get(`/api/v1/products/${productId}`).set("Cookie", reader);
    expect(detail.body.product.image).toEqual(response.body.image);
    expect(JSON.stringify(detail.body)).not.toContain("storageKey");
    expect(await db.auditLog.count({ where: { entityId: productId, action: "PRODUCT_IMAGE_VIEW" } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: productId, action: "PRODUCT_IMAGE_UPDATE" } })).toBe(1);
  });

  it("preserves the current image when replacement is invalid and queues removed files for cleanup", async () => {
    expect((await upload(admin, image("image/png"), "image/png")).status).toBe(200);
    const previous = await db.productImage.findUniqueOrThrow({ where: { productId } });
    expect((await upload(admin, image("image/png"), "image/jpeg")).status).toBe(400);
    expect((await upload(admin, Buffer.from("not an image"), "image/png")).status).toBe(400);
    expect((await upload(admin, Buffer.alloc(5 * 1024 * 1024 + 1), "image/png")).status).toBe(413);
    expect((await db.productImage.findUniqueOrThrow({ where: { productId } })).storageKey).toBe(previous.storageKey);
    expect((await request(app.server).delete(`/api/v1/products/${productId}/image`).set(unsafeHeaders(reader))).status).toBe(403);
    const removed = await request(app.server).delete(`/api/v1/products/${productId}/image`).set(unsafeHeaders(admin));
    expect(removed.status).toBe(204);
    expect(removed.headers["x-storage-cleanup"]).toBe("pending");
    expect(await db.storedFileCleanup.findUnique({ where: { storageKey: previous.storageKey } })).not.toBeNull();
    const storage = createLocalAssetStorage(directory);
    await processStoredFileCleanup(db, storage, app.log);
    expect(await storage.exists(previous.storageKey)).toBe(false);
    expect((await request(app.server).get(`/api/v1/products/${productId}/image`).set("Cookie", reader)).status).toBe(404);
  });

  it("retries failed cleanup without losing its durable record", async () => {
    expect((await upload(admin, image("image/png"), "image/png")).status).toBe(200);
    const previous = await db.productImage.findUniqueOrThrow({ where: { productId } });
    const replaced = await upload(admin, image("image/jpeg"), "image/jpeg");
    expect(replaced.status).toBe(200);
    expect(replaced.headers["x-storage-cleanup"]).toBe("pending");
    const storage = createLocalAssetStorage(directory);
    const broken = { ...storage, remove: vi.fn().mockRejectedValue(new Error("storage unavailable")) };
    await processStoredFileCleanup(db, broken, app.log);
    expect(await db.storedFileCleanup.findUnique({ where: { storageKey: previous.storageKey } })).not.toBeNull();
    expect(await storage.exists(previous.storageKey)).toBe(true);
    await db.storedFileCleanup.update({ where: { storageKey: previous.storageKey }, data: { availableAt: new Date(0) } });
    await processStoredFileCleanup(db, storage, app.log);
    expect(await db.storedFileCleanup.findUnique({ where: { storageKey: previous.storageKey } })).toBeNull();
    expect(await storage.exists(previous.storageKey)).toBe(false);
    const current = await db.productImage.findUniqueOrThrow({ where: { productId } });
    expect((await request(app.server).delete(`/api/v1/products/${productId}`).set(unsafeHeaders(admin))).status).toBe(204);
    expect(await db.storedFileCleanup.findUnique({ where: { storageKey: current.storageKey } })).not.toBeNull();
  });
});

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

describe("audit log", () => {
  let db: Database;
  let app: FastifyInstance;
  let adminCookie: string;
  let readerCookie: string;
  let adminId: string;

  beforeAll(async () => {
    db = createTestDatabase();
    app = await createTestApp(db);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    adminId = (await seedUser(db, ADMIN, "admin")).id;
    await seedUser(db, READER, "standard");
    adminCookie = await loginCookie(app, ADMIN);
    readerCookie = await loginCookie(app, READER);
  });

  describe("FR-AUD-06 access control", () => {
    it("returns 401 to anonymous callers", async () => {
      expect((await request(app.server).get("/api/v1/audit-log")).status).toBe(401);
    });

    it("returns 403 to standard users for list and detail", async () => {
      const list = await request(app.server).get("/api/v1/audit-log").set("Cookie", readerCookie);
      expect(list.status).toBe(403);
      const entry = await db.auditLog.findFirstOrThrow();
      const detail = await request(app.server)
        .get(`/api/v1/audit-log/${entry.id}`)
        .set("Cookie", readerCookie);
      expect(detail.status).toBe(403);
    });
  });

  describe("FR-AUD-01/02 entries carry actor, action, outcome, and request id", () => {
    it("lists entries newest first with the expected fields", async () => {
      await request(app.server)
        .patch(`/api/v1/users/${adminId}`)
        .set(unsafeHeaders(adminCookie))
        .send({ displayName: "Root Admin" });

      const res = await request(app.server).get("/api/v1/audit-log?pageSize=5").set("Cookie", adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      const first = res.body.items[0];
      expect(first).toEqual(
        expect.objectContaining({
          actorEmail: expect.any(String),
          action: expect.any(String),
          outcome: "success",
          occurredAt: expect.any(String),
          requestId: expect.any(String),
        }),
      );
      expect(res.body).toHaveProperty("total");
    });

    it("filters by action and entity type", async () => {
      const res = await request(app.server)
        .get("/api/v1/audit-log?action=LOGIN_SUCCESS&entityType=User")
        .set("Cookie", adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.items.every((i: { action: string }) => i.action === "LOGIN_SUCCESS")).toBe(true);
    });

    it("filters by actor user id", async () => {
      const res = await request(app.server)
        .get(`/api/v1/audit-log?userId=${adminId}`)
        .set("Cookie", adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.items.every((i: { actorUserId: string }) => i.actorUserId === adminId)).toBe(true);
    });

    it("filters by date range", async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const res = await request(app.server)
        .get(`/api/v1/audit-log?from=${encodeURIComponent(future)}`)
        .set("Cookie", adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    });

    it("rejects an invalid date filter", async () => {
      const res = await request(app.server)
        .get("/api/v1/audit-log?from=not-a-date")
        .set("Cookie", adminCookie);
      expect(res.status).toBe(400);
    });
  });

  describe("FR-AUD-03/04 changes and failures", () => {
    it("returns before and after values in the detail view", async () => {
      await request(app.server)
        .patch(`/api/v1/users/${adminId}`)
        .set(unsafeHeaders(adminCookie))
        .send({ displayName: "Renamed Admin" });

      const entry = await db.auditLog.findFirstOrThrow({ where: { action: "USER_UPDATE" } });
      const res = await request(app.server)
        .get(`/api/v1/audit-log/${entry.id}`)
        .set("Cookie", adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.entry.changes.displayName).toEqual({ before: null, after: "Renamed Admin" });
    });

    it("records failed login attempts without the password", async () => {
      await request(app.server)
        .post("/api/v1/auth/login")
        .set("Origin", "http://localhost:5173")
        .send({ email: ADMIN.email, password: "a-wrong-password-here" });

      const res = await request(app.server)
        .get("/api/v1/audit-log?action=LOGIN_FAILED")
        .set("Cookie", adminCookie);
      expect(res.body.items[0].outcome).toBe("failure");
      expect(JSON.stringify(res.body)).not.toContain("a-wrong-password-here");
    });

    it("returns 404 for an unknown audit entry", async () => {
      const res = await request(app.server)
        .get("/api/v1/audit-log/9f1c2a4e-1111-4222-8333-444455556666")
        .set("Cookie", adminCookie);
      expect(res.status).toBe(404);
    });
  });

  describe("FR-AUD-05 append-only storage", () => {
    it("prevents updates and deletes at the database level", async () => {
      const entry = await db.auditLog.findFirstOrThrow();
      await expect(
        db.auditLog.update({ where: { id: entry.id }, data: { action: "TAMPERED" } }),
      ).rejects.toThrow(/append-only/);
      await expect(db.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
    });
  });
});

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

const NEW_PASSWORD = "BrandNewPassword99";

describe("user management", () => {
  let db: Database;
  let app: FastifyInstance;
  let adminCookie: string;
  let readerCookie: string;
  let adminId: string;
  let readerId: string;

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
    readerId = (await seedUser(db, READER, "standard")).id;
    adminCookie = await loginCookie(app, ADMIN);
    readerCookie = await loginCookie(app, READER);
  });

  describe("FR-ROL-04/05 admin-only endpoints", () => {
    it("returns 401 to anonymous callers", async () => {
      const res = await request(app.server).get("/api/v1/users");
      expect(res.status).toBe(401);
    });

    it("returns 403 to standard users on every admin endpoint", async () => {
      const checks = [
        request(app.server).get("/api/v1/users").set("Cookie", readerCookie),
        request(app.server)
          .post("/api/v1/users")
          .set(unsafeHeaders(readerCookie))
          .send({ email: "x@test.local", role: "standard", password: NEW_PASSWORD }),
        request(app.server).get(`/api/v1/users/${adminId}`).set("Cookie", readerCookie),
        request(app.server)
          .patch(`/api/v1/users/${readerId}`)
          .set(unsafeHeaders(readerCookie))
          .send({ displayName: "Hacked" }),
        request(app.server)
          .post(`/api/v1/users/${readerId}/reset-password`)
          .set(unsafeHeaders(readerCookie))
          .send({ temporaryPassword: NEW_PASSWORD }),
        request(app.server).get("/api/v1/audit-log").set("Cookie", readerCookie),
      ];
      for (const res of await Promise.all(checks)) {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("FORBIDDEN");
      }
    });
  });

  describe("FR-USR-01 create user", () => {
    it("creates a user, hides the hash, and audits the creation", async () => {
      const res = await request(app.server)
        .post("/api/v1/users")
        .set(unsafeHeaders(adminCookie))
        .send({ email: "New.User@Test.Local", displayName: "New User", role: "standard", password: NEW_PASSWORD });

      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe("new.user@test.local");
      expect(res.body.user).not.toHaveProperty("passwordHash");

      const audit = await db.auditLog.findFirst({ where: { action: "USER_CREATE", entityId: res.body.user.id } });
      expect(audit?.actorUserId).toBe(adminId);
      expect(JSON.stringify(audit?.changes)).not.toContain(NEW_PASSWORD);
    });

    it("returns 409 for a duplicate email (case-insensitive)", async () => {
      const res = await request(app.server)
        .post("/api/v1/users")
        .set(unsafeHeaders(adminCookie))
        .send({ email: READER.email.toUpperCase(), role: "standard", password: NEW_PASSWORD });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CONFLICT");
    });

    it("validates the password length (minimum 12 characters)", async () => {
      const res = await request(app.server)
        .post("/api/v1/users")
        .set(unsafeHeaders(adminCookie))
        .send({ email: "short@test.local", role: "standard", password: "short" });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe("password");
    });
  });

  describe("FR-USR-02 update user and FR-USR-06 last admin rule", () => {
    it("changes display name and role and audits before/after values", async () => {
      const res = await request(app.server)
        .patch(`/api/v1/users/${readerId}`)
        .set(unsafeHeaders(adminCookie))
        .send({ displayName: "Reader Two", role: "admin" });

      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe("admin");
      const audit = await db.auditLog.findFirst({ where: { action: "USER_UPDATE", entityId: readerId } });
      expect(audit?.changes).toMatchObject({ role: { before: "standard", after: "admin" } });
    });

    it("refuses to demote the last active admin", async () => {
      const res = await request(app.server)
        .patch(`/api/v1/users/${adminId}`)
        .set(unsafeHeaders(adminCookie))
        .send({ role: "standard" });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain("last active admin");
    });

    it("refuses to deactivate the last active admin", async () => {
      const res = await request(app.server)
        .patch(`/api/v1/users/${adminId}`)
        .set(unsafeHeaders(adminCookie))
        .send({ isActive: false });
      expect(res.status).toBe(409);
    });

    it("allows demoting an admin when another active admin exists", async () => {
      await db.user.update({ where: { id: readerId }, data: { role: "admin" } });
      const res = await request(app.server)
        .patch(`/api/v1/users/${adminId}`)
        .set(unsafeHeaders(adminCookie))
        .send({ role: "standard" });
      expect(res.status).toBe(200);
    });

    it("rejects an empty update body", async () => {
      const res = await request(app.server)
        .patch(`/api/v1/users/${readerId}`)
        .set(unsafeHeaders(adminCookie))
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe("FR-USR-04 deactivation revokes sessions", () => {
    it("deactivates a user and revokes their active sessions", async () => {
      const res = await request(app.server)
        .patch(`/api/v1/users/${readerId}`)
        .set(unsafeHeaders(adminCookie))
        .send({ isActive: false });
      expect(res.status).toBe(200);

      const me = await request(app.server).get("/api/v1/auth/me").set("Cookie", readerCookie);
      expect(me.status).toBe(401);
      const relogin = await request(app.server)
        .post("/api/v1/auth/login")
        .set("Origin", "http://localhost:5173")
        .send({ email: READER.email, password: READER.password });
      expect(relogin.status).toBe(401);
    });
  });

  describe("FR-USR-03 admin password reset", () => {
    it("resets the password, revokes sessions, and forces a change at next login", async () => {
      const res = await request(app.server)
        .post(`/api/v1/users/${readerId}/reset-password`)
        .set(unsafeHeaders(adminCookie))
        .send({ temporaryPassword: NEW_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.user.mustChangePassword).toBe(true);

      const oldSession = await request(app.server).get("/api/v1/auth/me").set("Cookie", readerCookie);
      expect(oldSession.status).toBe(401);

      const cookie = await loginCookie(app, { email: READER.email, password: NEW_PASSWORD });
      const blocked = await request(app.server).get("/api/v1/users").set("Cookie", cookie);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.message).toContain("change your password");

      const me = await request(app.server).get("/api/v1/auth/me").set("Cookie", cookie);
      expect(me.status).toBe(200);
      expect(me.body.user.mustChangePassword).toBe(true);
    });

    it("audits the reset without recording the password", async () => {
      await request(app.server)
        .post(`/api/v1/users/${readerId}/reset-password`)
        .set(unsafeHeaders(adminCookie))
        .send({ temporaryPassword: NEW_PASSWORD });
      const audit = await db.auditLog.findFirst({ where: { action: "USER_PASSWORD_RESET" } });
      expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
    });
  });

  describe("FR-USR-05 change own password", () => {
    it("changes the password, clears the forced-change flag, and keeps the current session", async () => {
      await db.user.update({ where: { id: readerId }, data: { mustChangePassword: true } });
      const res = await request(app.server)
        .post("/api/v1/users/me/password")
        .set(unsafeHeaders(readerCookie))
        .send({ currentPassword: READER.password, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(204);

      const me = await request(app.server).get("/api/v1/auth/me").set("Cookie", readerCookie);
      expect(me.status).toBe(200);
      expect(me.body.user.mustChangePassword).toBe(false);

      const login = await request(app.server)
        .post("/api/v1/auth/login")
        .set("Origin", "http://localhost:5173")
        .send({ email: READER.email, password: NEW_PASSWORD });
      expect(login.status).toBe(200);
    });

    it("rejects an incorrect current password", async () => {
      const res = await request(app.server)
        .post("/api/v1/users/me/password")
        .set(unsafeHeaders(readerCookie))
        .send({ currentPassword: "wrong-current-pw", newPassword: NEW_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe("currentPassword");
    });

    it("signs out other sessions but keeps the current one", async () => {
      const other = await loginCookie(app, READER);
      await request(app.server)
        .post("/api/v1/users/me/password")
        .set(unsafeHeaders(readerCookie))
        .send({ currentPassword: READER.password, newPassword: NEW_PASSWORD });

      expect((await request(app.server).get("/api/v1/auth/me").set("Cookie", other)).status).toBe(401);
      expect((await request(app.server).get("/api/v1/auth/me").set("Cookie", readerCookie)).status).toBe(200);
    });
  });

  describe("FR-USR-07 and admin user listing", () => {
    it("lists users for an admin with pagination and search", async () => {
      const res = await request(app.server)
        .get("/api/v1/users?page=1&pageSize=1&q=reader")
        .set("Cookie", adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items[0].email).toBe(READER.email);
      expect(await db.auditLog.count({ where: { action: "USER_LIST" } })).toBe(1);
    });

    it("returns 404 for an unknown user id", async () => {
      const res = await request(app.server)
        .get("/api/v1/users/9f1c2a4e-1111-4222-8333-444455556666")
        .set("Cookie", adminCookie);
      expect(res.status).toBe(404);
    });

    it("returns 400 for a malformed user id", async () => {
      const res = await request(app.server).get("/api/v1/users/not-a-uuid").set("Cookie", adminCookie);
      expect(res.status).toBe(400);
    });
  });
});

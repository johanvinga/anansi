import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db.js";
import {
  ADMIN,
  TEST_ORIGIN,
  createTestApp,
  createTestDatabase,
  loginCookie,
  resetDatabase,
  seedUser,
  unsafeHeaders,
} from "../test/helpers.js";

describe("auth routes", () => {
  let db: Database;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = createTestDatabase();
    app = await createTestApp(db);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await seedUser(db, ADMIN, "admin");
  });

  describe("FR-AUTH-01/03 login", () => {
    it("logs in with valid credentials and sets an httpOnly, SameSite=Lax session cookie", async () => {
      const res = await request(app.server)
        .post("/api/v1/auth/login")
        .set("Origin", TEST_ORIGIN)
        .send({ email: ADMIN.email, password: ADMIN.password });

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(ADMIN.email);
      expect(res.body.user).not.toHaveProperty("passwordHash");
      const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("sid="));
      expect(cookie).toBeDefined();
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).not.toContain("Secure");
    });

    it("normalizes the email before lookup", async () => {
      const res = await request(app.server)
        .post("/api/v1/auth/login")
        .set("Origin", TEST_ORIGIN)
        .send({ email: "  ADMIN@Test.Local ", password: ADMIN.password });
      expect(res.status).toBe(200);
    });

    it("records LOGIN_SUCCESS in the audit log", async () => {
      await request(app.server)
        .post("/api/v1/auth/login")
        .set("Origin", TEST_ORIGIN)
        .send({ email: ADMIN.email, password: ADMIN.password });

      const entry = await db.auditLog.findFirst({ where: { action: "LOGIN_SUCCESS" } });
      expect(entry?.outcome).toBe("success");
      expect(entry?.actorEmail).toBe(ADMIN.email);
    });
  });

  describe("FR-AUTH-07 generic failures and FR-AUD-04", () => {
    it("returns the same generic error for a wrong password and an unknown email", async () => {
      const wrongPassword = await request(app.server)
        .post("/api/v1/auth/login")
        .set("Origin", TEST_ORIGIN)
        .send({ email: ADMIN.email, password: "not-the-password-123" });
      const unknownEmail = await request(app.server)
        .post("/api/v1/auth/login")
        .set("Origin", TEST_ORIGIN)
        .send({ email: "nobody@test.local", password: "not-the-password-123" });

      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.body.error.code).toBe("UNAUTHENTICATED");
      expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
    });

    it("records LOGIN_FAILED with the attempted email and never the password", async () => {
      await request(app.server)
        .post("/api/v1/auth/login")
        .set("Origin", TEST_ORIGIN)
        .send({ email: "typo@test.local", password: "SecretGuess-123456" });

      const entry = await db.auditLog.findFirst({ where: { action: "LOGIN_FAILED" } });
      expect(entry?.outcome).toBe("failure");
      expect(entry?.actorEmail).toBe("typo@test.local");
      expect(JSON.stringify(entry)).not.toContain("SecretGuess");
    });

    it("rejects inactive accounts with the generic error", async () => {
      await seedUser(db, { email: "off@test.local", password: "InactivePassword1" }, "standard", {
        isActive: false,
      });
      const res = await request(app.server)
        .post("/api/v1/auth/login")
        .set("Origin", TEST_ORIGIN)
        .send({ email: "off@test.local", password: "InactivePassword1" });
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe("Invalid email or password.");
    });

    it("validates the login body", async () => {
      const res = await request(app.server)
        .post("/api/v1/auth/login")
        .set("Origin", TEST_ORIGIN)
        .send({ email: "not-an-email", password: "" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.details.length).toBeGreaterThan(0);
    });
  });

  describe("FR-AUTH-06 rate limiting", () => {
    it("blocks an account after repeated failures and returns RATE_LIMITED", async () => {
      const limited = await createTestApp(db, { loginRateLimit: 3 });
      try {
        for (let i = 0; i < 3; i++) {
          await request(limited.server)
            .post("/api/v1/auth/login")
            .set("Origin", TEST_ORIGIN)
            .send({ email: ADMIN.email, password: "wrong-password-xyz" });
        }
        const res = await request(limited.server)
          .post("/api/v1/auth/login")
          .set("Origin", TEST_ORIGIN)
          .send({ email: ADMIN.email, password: ADMIN.password });
        expect(res.status).toBe(429);
        expect(res.body.error.code).toBe("RATE_LIMITED");
      } finally {
        await limited.close();
      }
    });
  });

  describe("FR-AUTH-04 logout and FR-AUTH-05 protected routes", () => {
    it("rejects requests without a session", async () => {
      const res = await request(app.server).get("/api/v1/auth/me");
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    });

    it("rejects a forged session cookie", async () => {
      const res = await request(app.server)
        .get("/api/v1/auth/me")
        .set("Cookie", "sid=00000000-0000-4000-8000-000000000000.bogus");
      expect(res.status).toBe(401);
    });

    it("returns the current user for a valid session", async () => {
      const cookie = await loginCookie(app, ADMIN);
      const res = await request(app.server).get("/api/v1/auth/me").set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe("admin");
    });

    it("invalidates the session on logout and audits the action", async () => {
      const cookie = await loginCookie(app, ADMIN);
      const out = await request(app.server)
        .post("/api/v1/auth/logout")
        .set(unsafeHeaders(cookie));
      expect(out.status).toBe(204);

      const after = await request(app.server).get("/api/v1/auth/me").set("Cookie", cookie);
      expect(after.status).toBe(401);
      expect(await db.auditLog.count({ where: { action: "LOGOUT" } })).toBe(1);
    });

    it("expires sessions after the idle timeout", async () => {
      const cookie = await loginCookie(app, ADMIN);
      const sessionId = cookie.slice("sid=".length).split(".")[0] ?? "";
      await db.session.update({
        where: { id: sessionId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await request(app.server).get("/api/v1/auth/me").set("Cookie", cookie);
      expect(res.status).toBe(401);
    });
  });

  describe("NFR-03 CSRF protection", () => {
    it("rejects state-changing requests from a foreign origin", async () => {
      const res = await request(app.server)
        .post("/api/v1/auth/login")
        .set("Origin", "https://evil.example")
        .send({ email: ADMIN.email, password: ADMIN.password });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("rejects state-changing requests without an Origin header", async () => {
      const cookie = await loginCookie(app, ADMIN);
      const res = await request(app.server).post("/api/v1/auth/logout").set("Cookie", cookie);
      expect(res.status).toBe(403);
    });
  });

  describe("NFR-04 security headers", () => {
    it("sets helmet headers and an x-request-id", async () => {
      const res = await request(app.server).get("/api/v1/health");
      expect(res.status).toBe(200);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-request-id"]).toBeTruthy();
    });
  });
});

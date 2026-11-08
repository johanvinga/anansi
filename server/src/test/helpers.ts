import type { FastifyInstance } from "fastify";
import request from "supertest";
import { buildApp } from "../app.js";
import { loadConfig, type AppConfig } from "../config.js";
import { createDatabase, type Database } from "../db.js";
import type { UserRole } from "../generated/prisma/client.js";
import { createUser } from "../services/user.service.js";

export const TEST_DATABASE_URL = "postgresql://app:app@localhost:5432/supplier_app_test";
export const TEST_ORIGIN = "http://localhost:5173";

export const ADMIN = { email: "admin@test.local", password: "AdminPassword123!" } as const;
export const READER = { email: "reader@test.local", password: "ReaderPassword123!" } as const;

const SYSTEM_ACTOR = { userId: null, email: "system:test" };

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    SESSION_SECRET: "test-session-secret-that-is-long-enough",
    APP_ORIGIN: TEST_ORIGIN,
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    LOGIN_RATE_LIMIT: "1000",
  });
  return { ...base, ...overrides };
}

export function createTestDatabase(): Database {
  if (!TEST_DATABASE_URL.endsWith("_test")) {
    throw new Error("Refusing to run tests against a non-test database.");
  }
  return createDatabase(TEST_DATABASE_URL);
}

export async function createTestApp(
  db: Database,
  overrides: Partial<AppConfig> = {},
): Promise<FastifyInstance> {
  const app = await buildApp(testConfig(overrides), { db, logger: false });
  await app.ready();
  return app;
}

/** Clears all tables. The audit trigger is disabled only for this test database. */
export async function resetDatabase(db: Database): Promise<void> {
  await db.$executeRawUnsafe("ALTER TABLE audit_logs DISABLE TRIGGER USER");
  await db.$executeRawUnsafe(
    "TRUNCATE audit_logs, sessions, product_attribute_values, products, attribute_options, attribute_fields, attribute_sets, catalogs, supplier_assets, supplier_categories, suppliers, categories, users CASCADE",
  );
  await db.$executeRawUnsafe("ALTER TABLE audit_logs ENABLE TRIGGER USER");
}

export async function seedUser(
  db: Database,
  account: { email: string; password: string },
  role: UserRole,
  options: { mustChangePassword?: boolean; isActive?: boolean } = {},
) {
  const user = await createUser(
    db,
    { requestId: "test-seed", ipAddress: null, actor: SYSTEM_ACTOR },
    { email: account.email, role, password: account.password },
  );
  if (options.mustChangePassword !== undefined || options.isActive !== undefined) {
    await db.user.update({
      where: { id: user.id },
      data: {
        mustChangePassword: options.mustChangePassword,
        isActive: options.isActive,
      },
    });
  }
  return user;
}

/** Logs in and returns the Cookie header value for subsequent requests. */
export async function loginCookie(
  app: FastifyInstance,
  account: { email: string; password: string },
): Promise<string> {
  const res = await request(app.server)
    .post("/api/v1/auth/login")
    .set("Origin", TEST_ORIGIN)
    .send({ email: account.email, password: account.password });
  if (res.status !== 200) {
    throw new Error(`Login failed in test helper with status ${res.status}`);
  }
  const setCookie = res.headers["set-cookie"] as unknown as string[];
  const sid = setCookie.find((c) => c.startsWith("sid="));
  if (!sid) {
    throw new Error("Missing session cookie");
  }
  return sid.split(";")[0] ?? "";
}

/** Headers for a state-changing request made by the app's own frontend. */
export function unsafeHeaders(cookie?: string): Record<string, string> {
  return cookie ? { Origin: TEST_ORIGIN, Cookie: cookie } : { Origin: TEST_ORIGIN };
}

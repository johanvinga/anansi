import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const required = {
  DATABASE_URL: "postgresql://app:app@localhost:5432/supplier_app",
  SESSION_SECRET: "a-session-secret-that-is-at-least-32-chars",
};

describe("loadConfig (SPEC §11)", () => {
  it("applies the documented defaults", () => {
    const config = loadConfig(required);
    expect(config.sessionIdleMinutes).toBe(480);
    expect(config.maxUploadMb).toBe(25);
    expect(config.defaultCurrency).toBe("USD");
    expect(config.loginRateLimit).toBe(10);
    expect(config.appOrigin).toBe("http://localhost:5173");
    expect(config.uploadDir).toBe("./storage/assets");
  });

  it("requires SESSION_SECRET", () => {
    expect(() => loadConfig({ DATABASE_URL: required.DATABASE_URL })).toThrow(/SESSION_SECRET/);
  });

  it("rejects a short SESSION_SECRET", () => {
    expect(() => loadConfig({ ...required, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });
});

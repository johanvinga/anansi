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
    expect(config.catalogExtractionEnabled).toBe(false);
  });

  it("accepts only explicit true or false for catalog analysis", () => {
    expect(loadConfig({ ...required, CATALOG_EXTRACTION_ENABLED: "true" }).catalogExtractionEnabled).toBe(true);
    expect(loadConfig({ ...required, CATALOG_EXTRACTION_ENABLED: "false" }).catalogExtractionEnabled).toBe(false);
    expect(() => loadConfig({ ...required, CATALOG_EXTRACTION_ENABLED: "yes" })).toThrow(/CATALOG_EXTRACTION_ENABLED/);
  });

  it("requires SESSION_SECRET", () => {
    expect(() => loadConfig({ DATABASE_URL: required.DATABASE_URL })).toThrow(/SESSION_SECRET/);
  });

  it("rejects a short SESSION_SECRET", () => {
    expect(() => loadConfig({ ...required, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });

  describe("STORAGE_BACKEND (FR-AST-09)", () => {
    it("defaults to local storage", () => {
      const config = loadConfig(required);
      expect(config.storageBackend).toBe("local");
    });

    it("rejects an unknown backend", () => {
      expect(() => loadConfig({ ...required, STORAGE_BACKEND: "s3" })).toThrow(/STORAGE_BACKEND/);
    });

    it("lists the missing R2 variables when r2 is selected", () => {
      expect(() => loadConfig({ ...required, STORAGE_BACKEND: "r2" })).toThrow(
        /R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET/,
      );
      expect(() =>
        loadConfig({
          ...required,
          STORAGE_BACKEND: "r2",
          R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
          R2_ACCESS_KEY_ID: "key",
        }),
      ).toThrow(/R2_SECRET_ACCESS_KEY, R2_BUCKET/);
    });

    it("accepts r2 when every variable is set", () => {
      const config = loadConfig({
        ...required,
        STORAGE_BACKEND: "r2",
        R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        R2_BUCKET: "assets",
      });
      expect(config.storageBackend).toBe("r2");
      expect(config.r2Bucket).toBe("assets");
    });
  });
});

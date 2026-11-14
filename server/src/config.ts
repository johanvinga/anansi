import { z } from "zod";
import { isCurrencyCode } from "./lib/currency.js";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.url().default("redis://127.0.0.1:6379"),
  CATALOG_EXTRACTION_ENABLED: z.enum(["true", "false"]).default("false"),
  CATALOG_OCR_LANGUAGES: z.string().min(1).default("eng+fra"),
  CATALOG_EXTRACTION_MAX_PAGES: z.coerce
    .number()
    .int()
    .positive()
    .max(500)
    .default(200),
  CATALOG_EXTRACTION_CONCURRENCY: z.coerce
    .number()
    .int()
    .positive()
    .max(2)
    .default(1),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters"),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(480),
  UPLOAD_DIR: z.string().min(1).default("./storage/assets"),
  STORAGE_BACKEND: z.enum(["local", "r2"]).default("local"),
  R2_ENDPOINT: z.string().min(1).default(""),
  R2_ACCESS_KEY_ID: z.string().min(1).default(""),
  R2_SECRET_ACCESS_KEY: z.string().min(1).default(""),
  R2_BUCKET: z.string().min(1).default(""),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(25),
  DEFAULT_CURRENCY: z
    .string()
    .refine(isCurrencyCode, "DEFAULT_CURRENCY must be an ISO 4217 code")
    .default("USD"),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  APP_ORIGIN: z.url().default("http://localhost:5173"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export interface AppConfig {
  databaseUrl: string;
  redisUrl: string;
  catalogExtractionEnabled: boolean;
  catalogOcrLanguages: string;
  catalogExtractionMaxPages: number;
  catalogExtractionConcurrency: number;
  sessionSecret: string;
  sessionIdleMinutes: number;
  uploadDir: string;
  storageBackend: "local" | "r2";
  r2Endpoint: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2Bucket: string;
  maxUploadMb: number;
  defaultCurrency: string;
  loginRateLimit: number;
  appOrigin: string;
  port: number;
  nodeEnv: "development" | "test" | "production";
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  if (e.STORAGE_BACKEND === "r2") {
    const missing = [
      ["R2_ENDPOINT", e.R2_ENDPOINT],
      ["R2_ACCESS_KEY_ID", e.R2_ACCESS_KEY_ID],
      ["R2_SECRET_ACCESS_KEY", e.R2_SECRET_ACCESS_KEY],
      ["R2_BUCKET", e.R2_BUCKET],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `Invalid configuration: STORAGE_BACKEND=r2 requires ${missing.join(", ")}`,
      );
    }
  }
  return {
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    catalogExtractionEnabled: e.CATALOG_EXTRACTION_ENABLED === "true",
    catalogOcrLanguages: e.CATALOG_OCR_LANGUAGES,
    catalogExtractionMaxPages: e.CATALOG_EXTRACTION_MAX_PAGES,
    catalogExtractionConcurrency: e.CATALOG_EXTRACTION_CONCURRENCY,
    sessionSecret: e.SESSION_SECRET,
    sessionIdleMinutes: e.SESSION_IDLE_MINUTES,
    uploadDir: e.UPLOAD_DIR,
    storageBackend: e.STORAGE_BACKEND,
    r2Endpoint: e.R2_ENDPOINT,
    r2AccessKeyId: e.R2_ACCESS_KEY_ID,
    r2SecretAccessKey: e.R2_SECRET_ACCESS_KEY,
    r2Bucket: e.R2_BUCKET,
    maxUploadMb: e.MAX_UPLOAD_MB,
    defaultCurrency: e.DEFAULT_CURRENCY,
    loginRateLimit: e.LOGIN_RATE_LIMIT,
    appOrigin: e.APP_ORIGIN,
    port: e.PORT,
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
  };
}

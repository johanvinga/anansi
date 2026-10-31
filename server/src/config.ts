import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(480),
  UPLOAD_DIR: z.string().min(1).default("./storage/assets"),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(25),
  DEFAULT_CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("USD"),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  APP_ORIGIN: z.url().default("http://localhost:5173"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface AppConfig {
  databaseUrl: string;
  sessionSecret: string;
  sessionIdleMinutes: number;
  uploadDir: string;
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
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    sessionSecret: e.SESSION_SECRET,
    sessionIdleMinutes: e.SESSION_IDLE_MINUTES,
    uploadDir: e.UPLOAD_DIR,
    maxUploadMb: e.MAX_UPLOAD_MB,
    defaultCurrency: e.DEFAULT_CURRENCY,
    loginRateLimit: e.LOGIN_RATE_LIMIT,
    appOrigin: e.APP_ORIGIN,
    port: e.PORT,
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
  };
}

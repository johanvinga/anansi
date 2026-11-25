import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { createDatabase, type Database } from "./db.js";
import { AppError, errors } from "./errors.js";
import { createLocalAssetStorage, type AssetStorage } from "./lib/asset-storage.js";
import { createR2AssetStorage } from "./lib/r2-asset-storage.js";
import { createGuards } from "./lib/auth-guards.js";
import { LoginLimiter } from "./lib/login-limiter.js";
import { registerAssetRoutes } from "./routes/asset.routes.js";
import { registerAttributeSetRoutes } from "./routes/attribute-set.routes.js";
import { registerIndependentAttributeRoutes } from "./routes/independent-attribute.routes.js";
import { registerCatalogRoutes } from "./routes/catalog.routes.js";
import { registerProductRoutes } from "./routes/product.routes.js";
import { registerPublicCatalogRoutes } from "./routes/public-catalog.routes.js";
import { registerSettingsRoutes } from "./routes/settings.routes.js";
import { registerAuditRoutes } from "./routes/audit.routes.js";
import { registerAuthRoutes } from "./routes/auth.routes.js";
import { registerSupplierRoutes } from "./routes/supplier.routes.js";
import { registerTagRoutes } from "./routes/tag.routes.js";
import { registerUserRoutes } from "./routes/user.routes.js";
import { registerPinShareRoutes } from "./routes/pin-share.routes.js";
import {
  createCatalogExtractionRuntime,
  type CatalogExtractionRuntime,
} from "./services/catalog-extraction.runtime.js";
import type { CatalogExtractionQueue } from "./services/catalog-extraction.queue.js";
import { processStoredFileCleanup } from "./services/stored-file-cleanup.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const BYTES_PER_MB = 1024 * 1024;

export interface BuildAppOptions {
  db?: Database;
  storage?: AssetStorage;
  catalogExtractionQueue?: CatalogExtractionQueue;
  logger?: boolean;
}

export async function buildApp(config: AppConfig, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const db = options.db ?? createDatabase(config.databaseUrl);
  // FR-AST-09: the backend is chosen by configuration; tests can inject their own.
  const storage =
    options.storage ??
    (config.storageBackend === "r2"
      ? createR2AssetStorage({
          endpoint: config.r2Endpoint,
          accessKeyId: config.r2AccessKeyId,
          secretAccessKey: config.r2SecretAccessKey,
          bucket: config.r2Bucket,
        })
      : createLocalAssetStorage(config.uploadDir));

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: [
              "req.headers.cookie",
              "req.headers.authorization",
              "req.body.password",
              "req.body.currentPassword",
              "req.body.newPassword",
              "req.body.temporaryPassword",
            ],
          },
    genReqId: () => randomUUID(),
    trustProxy: config.nodeEnv === "production" ? ["127.0.0.1", "::1"] : false,
  });
  const extractionRuntime: CatalogExtractionRuntime | undefined = !config.catalogExtractionEnabled || options.catalogExtractionQueue
    ? undefined
    : createCatalogExtractionRuntime(db, storage, config, app.log);
  const extractionQueue = config.catalogExtractionEnabled
    ? options.catalogExtractionQueue ?? extractionRuntime?.queue
    : undefined;
  if (config.catalogExtractionEnabled && !extractionQueue) throw new Error("Catalog extraction queue was not initialized.");

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  // CSRF: cookie-authenticated state changes must originate from the app origin (NFR-03).
  app.addHook("onRequest", async (request) => {
    const publicCatalogPath = request.url.split("?")[0] === "/api/v1/public/catalogs";
    if (publicCatalogPath && request.method === "OPTIONS") {
      throw errors.forbidden("This endpoint only accepts machine-to-machine requests.");
    }
    if (request.method === "POST" && publicCatalogPath) {
      if (config.nodeEnv === "production" && request.protocol !== "https") {
        throw errors.forbidden("HTTPS is required.");
      }
      if (
        request.headers.origin !== undefined ||
        Object.keys(request.headers).some((name) => name.startsWith("sec-fetch-")) ||
        request.headers["x-catalog-upload"] !== "1"
      ) {
        throw errors.forbidden("This endpoint only accepts machine-to-machine requests.");
      }
      return;
    }
    if (!SAFE_METHODS.has(request.method) && request.headers.origin !== config.appOrigin) {
      throw errors.forbidden("Request origin is not allowed.");
    }
  });

  await app.register(helmet);
  await app.register(cors, { origin: config.appOrigin, credentials: true });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, { global: false, timeWindow: LOGIN_WINDOW_MS });
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadMb * BYTES_PER_MB,
      files: 1,
      fields: 10,
      parts: 20,
    },
  });

  app.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }

    const statusCode = (error as FastifyError).statusCode;
    if (statusCode === 429) {
      return reply.status(429).send({
        error: { code: "RATE_LIMITED", message: "Too many attempts. Try again later.", details: [] },
      });
    }
    if (statusCode === 413) {
      return reply.status(413).send({
        error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large.", details: [] },
      });
    }
    if (statusCode === 415) {
      return reply.status(415).send({
        error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Unsupported media type.", details: [] },
      });
    }
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Malformed request.", details: [] },
      });
    }

    request.log.error({ err: { name: error.name, message: error.message, stack: error.stack } }, "Unhandled error");
    return reply.status(500).send({
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred.", details: [] },
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({
      error: { code: "NOT_FOUND", message: "Route not found.", details: [] },
    }),
  );

  const limiter = new LoginLimiter(config.loginRateLimit, LOGIN_WINDOW_MS);
  const ipLimiter = new LoginLimiter(config.loginRateLimit, LOGIN_WINDOW_MS);
  const deps = { db, config, limiter, ipLimiter };
  const guards = createGuards(deps);

  await app.register(
    async (v1) => {
      v1.get("/health", async () => ({ status: "ok" }));
      registerAuthRoutes(v1, deps, guards);
      registerUserRoutes(v1, deps, guards);
      registerPinShareRoutes(v1, db, guards);
      registerAuditRoutes(v1, db, guards);
      registerTagRoutes(v1, db, guards);
      registerSupplierRoutes(v1, { db, config, storage, log: app.log }, guards);
      registerAssetRoutes(v1, { db, storage, log: app.log }, guards);
      registerCatalogRoutes(v1, { db, storage, log: app.log, extractionQueue }, guards);
      registerPublicCatalogRoutes(v1, deps, { db, storage, log: app.log });
      registerAttributeSetRoutes(v1, db, guards);
      registerIndependentAttributeRoutes(v1, db, guards);
      registerProductRoutes(v1, { db, storage, log: app.log }, guards);
      registerSettingsRoutes(v1, config, guards);
    },
    { prefix: "/api/v1" },
  );

  let cleanupRunning: Promise<void> | undefined;
  const cleanup = () => {
    if (cleanupRunning) return;
    cleanupRunning = processStoredFileCleanup(db, storage, app.log).catch((error: unknown) => {
      app.log.error({ errorType: error instanceof Error ? error.name : "Unknown" }, "Stored image cleanup worker failed");
    }).finally(() => {
      cleanupRunning = undefined;
    });
  };
  const cleanupTimer = setInterval(cleanup, 60_000);
  cleanupTimer.unref();
  cleanup();
  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer);
    if (extractionRuntime) {
      await extractionRuntime.close();
    } else if (extractionQueue) {
      await extractionQueue.close();
    }
    await cleanupRunning;
    await db.$disconnect();
  });

  return app;
}

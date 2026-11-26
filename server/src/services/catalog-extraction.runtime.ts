import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import type { Database } from "../db.js";
import type { AssetStorage } from "../lib/asset-storage.js";
import { createGeminiCatalogAnalyzer, processGeminiCatalogExtraction } from "./catalog-gemini-extraction.js";
import { createGeminiRequestLimiter, createLimitedGeminiFetch } from "./gemini-request-limiter.js";
import {
  CATALOG_EXTRACTION_QUEUE,
  createCatalogExtractionQueue,
  createRedisConnection,
  type CatalogExtractionQueue,
} from "./catalog-extraction.queue.js";

interface ExtractionPayload {
  extractionJobId: string;
  prompt: "supplier" | "tags";
}

export interface CatalogExtractionRuntime {
  queue: CatalogExtractionQueue;
  close(): Promise<void>;
}

async function setJobFailure(
  db: Database,
  job: Job<ExtractionPayload>,
  error: Error,
): Promise<void> {
  const shouldRetry = job.attemptsMade + 1 < (job.opts.attempts ?? 1);
  const jobRecord = await db.catalogExtractionJob.findUnique({
    where: { id: job.data.extractionJobId },
    select: { catalogId: true },
  });
  if (!jobRecord) return;

  const status = shouldRetry ? "queued" : "failed";
  await db.$transaction([
    db.catalogExtractionJob.update({
      where: { id: job.data.extractionJobId },
      data: {
        status,
        stage: shouldRetry ? "queued" : "failed",
        processingError: error.message.slice(0, 2_000),
        completedAt: shouldRetry ? null : new Date(),
      },
    }),
    db.catalog.update({
      where: { id: jobRecord.catalogId },
      data: { analysisStatus: status },
    }),
  ]);
}

export function createCatalogExtractionRuntime(
  db: Database,
  storage: AssetStorage,
  config: AppConfig,
  log: FastifyBaseLogger,
): CatalogExtractionRuntime {
  const queue = createCatalogExtractionQueue(config.redisUrl);
  const limiterRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
  limiterRedis.on("error", (error) => {
    log.error({ errorType: error.name }, "Gemini request limiter Redis error");
  });
  const limiter = createGeminiRequestLimiter(limiterRedis, config.geminiApiKey);
  const analyzeCatalog = createGeminiCatalogAnalyzer(config.geminiApiKey, config.geminiModel, createLimitedGeminiFetch(limiter));
  const worker = new Worker<ExtractionPayload>(
    CATALOG_EXTRACTION_QUEUE,
    async (job) => {
      try {
        await processGeminiCatalogExtraction(
          job.data.extractionJobId,
          {
            db,
            storage,
            maxPages: config.catalogExtractionMaxPages,
            maxBytes: Math.floor(config.catalogExtractionMaxMb * 1024 * 1024),
          },
          analyzeCatalog,
          job.data.prompt,
        );
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("Catalog extraction failed.");
        await setJobFailure(db, job, failure);
        throw failure;
      }
    },
    {
      connection: createRedisConnection(config.redisUrl),
      concurrency: config.catalogExtractionConcurrency,
    },
  );
  worker.on("error", (error) => {
    log.error({ err: { name: error.name, message: error.message } }, "Catalog extraction worker error");
  });

  return {
    queue,
    async close() {
      await worker.close();
      await queue.close();
      limiterRedis.disconnect();
    },
  };
}

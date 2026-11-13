import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const CATALOG_EXTRACTION_QUEUE = "catalog-extraction";

export interface CatalogExtractionQueue {
  enqueue(extractionJobId: string): Promise<void>;
  close(): Promise<void>;
}

interface ExtractionPayload {
  extractionJobId: string;
}

export function createCatalogExtractionQueue(redisUrl: string): CatalogExtractionQueue {
  const queue = new Queue<ExtractionPayload>(CATALOG_EXTRACTION_QUEUE, {
    connection: createRedisConnection(redisUrl),
  });

  return {
    async enqueue(extractionJobId) {
      await queue.add(
        "analyze-catalog",
        { extractionJobId },
        {
          jobId: extractionJobId,
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: { count: 500 },
          removeOnFail: { count: 500 },
        },
      );
    },
    close: () => queue.close(),
  };
}

export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

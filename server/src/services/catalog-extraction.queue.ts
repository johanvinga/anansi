import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const CATALOG_EXTRACTION_QUEUE = "catalog-extraction-gemini";

export interface CatalogExtractionQueue {
  enqueue(extractionJobId: string, prompt: "supplier" | "tags"): Promise<void>;
  close(): Promise<void>;
}

interface ExtractionPayload {
  extractionJobId: string;
  prompt: "supplier" | "tags";
}

export function createCatalogExtractionQueue(redisUrl: string): CatalogExtractionQueue {
  const connection = createRedisConnection(redisUrl);
  const queue = new Queue<ExtractionPayload>(CATALOG_EXTRACTION_QUEUE, { connection });

  return {
    async enqueue(extractionJobId, prompt) {
      await queue.add(
        "analyze-catalog",
        { extractionJobId, prompt },
        {
          jobId: extractionJobId,
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: { count: 500 },
          removeOnFail: { count: 500 },
        },
      );
    },
    async close() {
      await queue.close();
      // BullMQ leaves a connection it was handed open, which would keep scripts from exiting.
      connection.disconnect();
    },
  };
}

export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

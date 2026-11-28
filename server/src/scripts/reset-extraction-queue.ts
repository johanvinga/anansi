import "dotenv/config";
import { Queue } from "bullmq";
import { loadConfig } from "../config.js";
import { createDatabase } from "../db.js";
import { CATALOG_EXTRACTION_QUEUE, createRedisConnection } from "../services/catalog-extraction.queue.js";
import { resetCatalogExtractionJobs } from "../services/catalog-extraction-reset.js";

/**
 * Resets catalog analysis so extraction can be triggered manually again.
 * Usage: npm run reset:extraction-queue [-- --include-failed]
 * Empties the BullMQ queue, deletes queued/processing extraction jobs (failed ones with
 * --include-failed), and restores each affected catalog to the status of its latest remaining job,
 * or "not_processed" if it has none. Stop the API/worker first so no job is running.
 */
async function main(): Promise<void> {
  const includeFailed = process.argv.slice(2).includes("--include-failed");
  const statuses = includeFailed ? (["queued", "processing", "failed"] as const) : (["queued", "processing"] as const);

  const config = loadConfig();
  const db = createDatabase(config.databaseUrl);
  const connection = createRedisConnection(config.redisUrl);
  const queue = new Queue(CATALOG_EXTRACTION_QUEUE, { connection });
  try {
    await queue.obliterate({ force: true });
    const resetCatalogs = await resetCatalogExtractionJobs(db, includeFailed);

    console.log(`Emptied the "${CATALOG_EXTRACTION_QUEUE}" queue and reset ${resetCatalogs} catalog(s) (${statuses.join(", ")}).`);
    console.log("Trigger extraction again from the catalog page.");
  } finally {
    try {
      await queue.close();
    } finally {
      connection.disconnect();
      await db.$disconnect();
    }
  }
}

await main();

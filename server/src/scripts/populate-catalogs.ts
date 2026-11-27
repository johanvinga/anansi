import "dotenv/config";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDatabase } from "../db.js";
import { populateAllMissingCatalogs } from "../services/catalog-auto-populate.service.js";
import { createCatalogExtractionQueue } from "../services/catalog-extraction.queue.js";

/**
 * Queues the supplier and/or tags analysis for every catalog that has no supplier or no tags.
 * Jobs are processed (and results applied) by the running API server; this script only queues them.
 * Usage: npm run populate:catalogs -- [--dry-run] [--limit N]
 */
function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive whole number.");
  return limit;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { "dry-run": { type: "boolean", default: false }, limit: { type: "string" } },
  });
  const dryRun = values["dry-run"] === true;
  const limit = parseLimit(values.limit);

  const config = loadConfig();
  if (!config.catalogExtractionEnabled) {
    throw new Error("Catalog analysis is disabled. Set CATALOG_EXTRACTION_ENABLED=true (and GEMINI_API_KEY).");
  }

  const db = createDatabase(config.databaseUrl);
  const queue = createCatalogExtractionQueue(config.redisUrl);
  try {
    const results = await populateAllMissingCatalogs(
      { db, log: { error: (details, message) => console.error(message, details) } },
      {
        requestId: `populate-${randomUUID()}`,
        ipAddress: null,
        actor: { userId: null, email: "system:populate-catalogs" },
      },
      queue,
      { dryRun, limit },
    );

    for (const result of results) {
      console.log(`${result.outcome.padEnd(11)} ${result.catalogId}  ${result.name}  [missing: ${result.missing.join(", ")}]`);
    }
    const count = (outcome: string) => results.filter((result) => result.outcome === outcome).length;
    console.log(
      `${dryRun ? "Dry run: " : ""}${results.length} catalog(s) lack a supplier or tags: ` +
        `${count(dryRun ? "would-queue" : "queued")} ${dryRun ? "would be queued" : "queued"}, ` +
        `${count("running")} already running, ${count("failed")} failed.`,
    );
    if (!dryRun && count("queued") > 0) console.log("The API server processes the queued jobs; keep it running until they finish.");
    if (count("failed") > 0) process.exitCode = 1;
  } finally {
    await queue.close();
    await db.$disconnect();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

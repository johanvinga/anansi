import "dotenv/config";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDatabase } from "../db.js";
import { createCatalogExtractionQueue } from "../services/catalog-extraction.queue.js";
import { findQuotaFailures, retryQuotaFailure } from "../services/catalog-quota-retry.service.js";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
  const config = loadConfig();
  if (!config.catalogExtractionEnabled) {
    throw new Error("Catalog analysis is disabled. Set CATALOG_EXTRACTION_ENABLED=true (and GEMINI_API_KEY).");
  }

  const db = createDatabase(config.databaseUrl);
  const queue = values.apply ? createCatalogExtractionQueue(config.redisUrl) : undefined;
  try {
    const failures = await findQuotaFailures(db);
    const request = {
      requestId: `retry-quota-${randomUUID()}`,
      ipAddress: null,
      actor: { userId: null, email: "system:retry-quota-catalogs" },
    };
    const deps = { db, log: { error: (details: object, message: string) => console.error(message, details) } };
    let failed = 0;
    for (const failure of failures) {
      if (!queue) {
        console.log(`would-queue ${failure.catalogId}  ${failure.name}  [${failure.prompt}]`);
        continue;
      }
      try {
        const outcome = await retryQuotaFailure(deps, request, queue, failure);
        console.log(`${outcome.padEnd(11)} ${failure.catalogId}  ${failure.name}  [${failure.prompt}]`);
      } catch (error) {
        failed++;
        console.error(`failed      ${failure.catalogId}  ${failure.name}  [${failure.prompt}]:`, error);
      }
    }
    console.log(`${failures.length} latest quota-failed analysis job(s) found.${queue ? "" : " Dry run; use --apply to queue."}`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    if (queue) await queue.close();
    await db.$disconnect();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDatabase } from "../db.js";
import { createLocalAssetStorage } from "../lib/asset-storage.js";
import { createR2AssetStorage } from "../lib/r2-asset-storage.js";
import { dedupeCatalogs } from "../services/catalog-dedupe.service.js";

/**
 * Finds catalogs whose PDF files are byte-for-byte identical (SHA-256), keeps the copy with the most data,
 * merges the others' tags, supplier, products, pins and shares into it, and deletes them.
 * Dry run by default. Usage: npm run dedupe:catalogs -- [--apply] [--limit N]
 */
function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive whole number.");
  return limit;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { apply: { type: "boolean", default: false }, limit: { type: "string" } },
  });
  const apply = values.apply === true;
  const limit = parseLimit(values.limit);

  const config = loadConfig();
  const storage = config.storageBackend === "r2"
    ? createR2AssetStorage({
        endpoint: config.r2Endpoint,
        accessKeyId: config.r2AccessKeyId,
        secretAccessKey: config.r2SecretAccessKey,
        bucket: config.r2Bucket,
      })
    : createLocalAssetStorage(config.uploadDir);

  const db = createDatabase(config.databaseUrl);
  try {
    const report = await dedupeCatalogs(
      { db, storage, log: { warn: (details, message) => console.warn(message, details) } },
      {
        requestId: `dedupe-${randomUUID()}`,
        ipAddress: null,
        actor: { userId: null, email: "system:dedupe-catalogs" },
      },
      { apply, limit },
    );

    for (const group of report.groups) {
      console.log(`sha256 ${group.sha256.slice(0, 12)}  keep ${group.keep.id}  ${group.keep.name}`);
      for (const duplicate of group.duplicates) {
        console.log(`  ${duplicate.outcome.padEnd(12)} ${duplicate.id}  ${duplicate.name}`);
      }
    }
    for (const catalog of report.unreadable) {
      console.log(`unreadable file, skipped: ${catalog.id}  ${catalog.name}`);
    }
    const duplicates = report.groups.flatMap((group) => group.duplicates);
    const count = (outcome: string) => duplicates.filter((duplicate) => duplicate.outcome === outcome).length;
    console.log(
      `${apply ? "" : "Dry run: "}${report.groups.length} duplicate group(s), ${duplicates.length} duplicate catalog(s): ` +
        `${apply ? `${count("deleted")} deleted, ${count("failed")} failed` : "none deleted (use --apply to delete)"}, ` +
        `${report.unreadable.length} unreadable.`,
    );
    if (count("failed") > 0) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

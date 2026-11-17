import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { AssetStorage } from "../lib/asset-storage.js";

const STAGING_LEASE_MS = 24 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;

export async function stageImage(db: Database, storage: AssetStorage, buffer: Buffer, mimeType: string): Promise<string> {
  const key = `images/${randomUUID()}`;
  await db.storedFileCleanup.create({
    data: { storageKey: key, availableAt: new Date(Date.now() + STAGING_LEASE_MS) },
  });
  try {
    await storage.save(key, buffer, mimeType);
  } catch {
    await db.storedFileCleanup.update({ where: { storageKey: key }, data: { availableAt: new Date() } });
    throw new Error("Could not save the image to private storage.");
  }
  return key;
}

export async function discardStagedImage(db: Database, key: string): Promise<void> {
  await db.storedFileCleanup.update({ where: { storageKey: key }, data: { availableAt: new Date() } });
}

export async function commitStagedImage(tx: Prisma.TransactionClient, key: string): Promise<void> {
  await tx.storedFileCleanup.delete({ where: { storageKey: key } });
}

export async function queueStoredFileRemoval(tx: Prisma.TransactionClient, key: string): Promise<void> {
  await tx.storedFileCleanup.upsert({
    where: { storageKey: key },
    create: { storageKey: key, availableAt: new Date() },
    update: { availableAt: new Date() },
  });
}

export async function processStoredFileCleanup(db: Database, storage: AssetStorage, log: FastifyBaseLogger): Promise<void> {
  for (let count = 0; count < 50; count++) {
    const found = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ storage_key: string }[]>`
        SELECT storage_key FROM stored_file_cleanup
        WHERE available_at <= NOW()
        ORDER BY available_at
        FOR UPDATE SKIP LOCKED LIMIT 1`;
      const row = rows[0];
      if (!row) return false;
      try {
        await storage.remove(row.storage_key);
        await tx.storedFileCleanup.delete({ where: { storageKey: row.storage_key } });
      } catch (error) {
        log.error({ errorType: error instanceof Error ? error.name : "Unknown" }, "Stored image cleanup failed; retry scheduled");
        await tx.storedFileCleanup.update({
          where: { storageKey: row.storage_key },
          data: { availableAt: new Date(Date.now() + RETRY_DELAY_MS) },
        });
      }
      return true;
    });
    if (!found) break;
  }
}

import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

/** Storage backend for supplier assets (FR-AST-09). Swap the implementation to move to S3 or Azure Blob. */
export interface AssetStorage {
  save(key: string, data: Buffer, mimeType?: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  openRead(key: string): Readable;
  remove(key: string): Promise<void>;
}

const STORAGE_KEY_PATTERN = /^(?:(?:assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|(?:(?:catalogs\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf))$/;

export function assertValidStorageKey(key: string): void {
  if (!STORAGE_KEY_PATTERN.test(key)) throw new Error("Invalid storage key");
}

export function createLocalAssetStorage(directory: string): AssetStorage {
  const root = path.resolve(directory);

  function pathFor(key: string): string {
    assertValidStorageKey(key);
    return path.join(root, key);
  }

  return {
    async save(key, data) {
      const filePath = pathFor(key);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, data, { flag: "wx" });
    },
    async exists(key) {
      const filePath = pathFor(key);
      try {
        await stat(filePath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    openRead(key) {
      return createReadStream(pathFor(key));
    },
    async remove(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}

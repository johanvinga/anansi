import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

/** Storage backend for supplier assets (FR-AST-09). Swap the implementation to move to S3 or Azure Blob. */
export interface AssetStorage {
  save(key: string, data: Buffer): Promise<void>;
  exists(key: string): Promise<boolean>;
  openRead(key: string): Readable;
  remove(key: string): Promise<void>;
}

/** Generated keys only: `<uuid>.pdf`. Anything else is rejected, which blocks path traversal. */
const STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;

export function createLocalAssetStorage(directory: string): AssetStorage {
  const root = path.resolve(directory);

  function pathFor(key: string): string {
    if (!STORAGE_KEY_PATTERN.test(key)) {
      throw new Error("Invalid storage key");
    }
    return path.join(root, key);
  }

  return {
    async save(key, data) {
      await mkdir(root, { recursive: true });
      await writeFile(pathFor(key), data, { flag: "wx" });
    },
    async exists(key) {
      const filePath = pathFor(key);
      try {
        await stat(filePath);
        return true;
      } catch {
        return false;
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

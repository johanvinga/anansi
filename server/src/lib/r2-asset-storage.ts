import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AssetStorage } from "./asset-storage.js";

/** Generated keys only: `<uuid>.pdf`. Anything else is rejected, which blocks path traversal. */
const STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;

export interface R2StorageConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/**
 * Minimal S3 client shape the storage needs; tests inject a double instead of constructing a
 * real S3Client (whose constructor requires credentials and network access).
 * Only GetObject's Body is consumed; the other commands discard their responses, so a test
 * double can return a minimal object for them.
 */
export type R2CommandSender = Pick<S3Client, "send">;

function assertValidKey(key: string): void {
  if (!STORAGE_KEY_PATTERN.test(key)) {
    throw new Error("Invalid storage key");
  }
}

/**
 * Cloudflare R2 storage backend (FR-AST-09). Speaks the S3 API through the AWS SDK.
 * The bucket stays private: files are only served through authenticated, audited API downloads.
 */
export function createR2AssetStorage(
  config: R2StorageConfig,
  client: R2CommandSender = new S3Client({
    endpoint: config.endpoint,
    region: "auto",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  }),
): AssetStorage {
  const bucket = config.bucket;

  return {
    async save(key, data) {
      assertValidKey(key);
      // Fail instead of silently overwriting an existing object, mirroring the local
      // backend's wx flag. R2 supports the S3 condition and returns 412 PreconditionFailed.
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: data,
          ContentType: "application/pdf",
          IfNoneMatch: '"*"',
        }),
      );
    },

    async exists(key) {
      assertValidKey(key);
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error) {
        // The SDK types HeadObject failures as S3ServiceException with name "NotFound" (404),
        // or "NoSuchKey" depending on backend; treat both as absent.
        const name = (error as { name?: string }).name;
        if (name === "NotFound" || name === "NoSuchKey") return false;
        throw error;
      }
    },

    openRead(key) {
      assertValidKey(key);
      // GetObjectCommand is async, but openRead's contract is synchronous: expose a
      // PassThrough that the body pipelines into once the request resolves. The promise is
      // intentionally not awaited so the stream can be returned immediately; S3 errors then
      // surface on the stream instead, and downloads behave like the local backend.
      const output = new PassThrough();
      void client
        .send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        .then(async (result) => {
          const body = result.Body;
          if (!(body instanceof Readable)) {
            output.destroy(new Error("R2 object body is not a readable stream"));
            return;
          }
          try {
            await pipeline(body, output);
          } catch {
            // pipeline has already destroyed both streams; nothing more to do.
          }
        })
        .catch((error: unknown) => {
          output.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      return output;
    },

    async remove(key) {
      assertValidKey(key);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

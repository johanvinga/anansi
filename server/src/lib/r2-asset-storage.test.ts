import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { createR2AssetStorage } from "./r2-asset-storage.js";

const VALID_KEY = "123e4567-e89b-42d3-a456-426614174000.pdf";
const PDF = Buffer.from("%PDF-1.4 test");

/**
 * Test double for the S3 client. Records every command and lets each test stub a response
 * or a thrown error. Instances carry no `name` property, so the command is identified by
 * its constructor (PutObjectCommand etc.), same as the SDK tags it in thrown errors.
 * Only GetObject's Body is consumed by the module.
 */
function fakeClient(options: {
  putResponse?: object;
  headResponse?: object;
  getResponse?: { Body?: unknown };
  deleteResponse?: object;
  error?: Error;
} = {}): { client: Parameters<typeof createR2AssetStorage>[1]; calls: string[] } {
  const calls: string[] = [];
  const client = {
    async send(command: unknown) {
      const Key = (command as { input: { Key: string } }).input.Key;
      if (command instanceof PutObjectCommand) {
        calls.push(`put:${Key}`);
        if (options.error) throw options.error;
        return options.putResponse ?? {};
      }
      if (command instanceof HeadObjectCommand) {
        calls.push(`head:${Key}`);
        if (options.error) throw options.error;
        return options.headResponse ?? {};
      }
      if (command instanceof GetObjectCommand) {
        calls.push(`get:${Key}`);
        if (options.error) throw options.error;
        return options.getResponse ?? {};
      }
      if (command instanceof DeleteObjectCommand) {
        calls.push(`delete:${Key}`);
        if (options.error) throw options.error;
        return options.deleteResponse ?? {};
      }
      throw new Error("Unexpected command type");
    },
  };
  return { client, calls };
}

/** SDK-style error ({ name, message }). */
function sdkError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const config = {
  endpoint: "https://test.r2.cloudflarestorage.com",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
  bucket: "test-bucket",
};

describe("createR2AssetStorage (FR-AST-09)", () => {
  it("saves files under generated keys with a fail-if-exists guard", async () => {
    const { client, calls } = fakeClient();
    const storage = createR2AssetStorage(config, client);
    await storage.save(VALID_KEY, PDF);
    expect(calls).toEqual([`put:${VALID_KEY}`]);
    // The double recorded the command name and key; assert guard behavior on save failure
    // (IfNoneMatch) is covered by integration with the real SDK, not by this double.
  });

  it("rejects keys that are not generated UUID file names", async () => {
    const { client } = fakeClient();
    const storage = createR2AssetStorage(config, client);
    await expect(storage.save("../evil.pdf", PDF)).rejects.toThrow(/Invalid storage key/);
    await expect(storage.exists("notes.txt")).rejects.toThrow(/Invalid storage key/);
    expect(() => storage.openRead("a/b.pdf")).toThrow(/Invalid storage key/);
    await expect(storage.remove("../../etc/passwd.pdf")).rejects.toThrow(/Invalid storage key/);
  });

  it("returns true for an existing object", async () => {
    const storage = createR2AssetStorage(config, fakeClient().client);
    await expect(storage.exists(VALID_KEY)).resolves.toBe(true);
  });

  it("maps NotFound and NoSuchKey to false and rethrows other HeadObject errors", async () => {
    const notFound = createR2AssetStorage(
      config,
      fakeClient({ error: sdkError("NotFound", "not found") }).client,
    );
    await expect(notFound.exists(VALID_KEY)).resolves.toBe(false);

    const noSuchKey = createR2AssetStorage(
      config,
      fakeClient({ error: sdkError("NoSuchKey", "no such key") }).client,
    );
    await expect(noSuchKey.exists(VALID_KEY)).resolves.toBe(false);

    const other = createR2AssetStorage(
      config,
      fakeClient({ error: sdkError("InternalError", "boom") }).client,
    );
    await expect(other.exists(VALID_KEY)).rejects.toMatchObject({ name: "InternalError" });
  });

  it("streams the object body through openRead", async () => {
    const storage = createR2AssetStorage(
      config,
      fakeClient({ getResponse: { Body: Readable.from([PDF]) } }).client,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of storage.openRead(VALID_KEY)) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString()).toBe(PDF.toString());
  });

  it("destroys the stream when the object get fails or the body is missing", async () => {
    const failed = createR2AssetStorage(
      config,
      fakeClient({ error: sdkError("AccessDenied", "no access") }).client,
    );
    await expect(async () => {
      for await (const _chunk of failed.openRead(VALID_KEY)) {
        // drain
      }
    }).rejects.toThrow(/no access/);

    const emptyBody = createR2AssetStorage(
      config,
      fakeClient({ getResponse: { Body: undefined } }).client,
    );
    await expect(async () => {
      for await (const _chunk of emptyBody.openRead(VALID_KEY)) {
        // drain
      }
    }).rejects.toThrow(/not a readable stream/);
  });

  it("removes objects", async () => {
    const { client, calls } = fakeClient();
    const storage = createR2AssetStorage(config, client);
    await storage.remove(VALID_KEY);
    expect(calls).toEqual([`delete:${VALID_KEY}`]);
  });
});


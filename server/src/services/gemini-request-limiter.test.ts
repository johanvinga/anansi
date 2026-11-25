import { createHash, randomUUID } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createGeminiCatalogAnalyzer } from "./catalog-gemini-extraction.js";
import {
  createGeminiRequestLimiter,
  createLimitedGeminiFetch,
  GeminiRateLimitError,
} from "./gemini-request-limiter.js";

describe("Gemini request limiter", () => {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: 1 });
  const otherRedis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: 1 });
  const credential = `test-${randomUUID()}`;
  const key = `gemini:requests:${createHash("sha256").update(credential).digest("hex")}`;
  const otherCredential = `test-${randomUUID()}`;
  const otherKey = `gemini:requests:${createHash("sha256").update(otherCredential).digest("hex")}`;

  afterAll(async () => {
    await redis.del(key, otherKey);
    await Promise.all([redis.quit(), otherRedis.quit()]);
  });

  it("shares eight permits atomically, waits for expiry, and separates credentials", async () => {
    const first = createGeminiRequestLimiter(redis, credential);
    const second = createGeminiRequestLimiter(otherRedis, credential);
    await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second)()));
    expect(await redis.zcard(key)).toBe(8);

    const controller = new AbortController();
    const ninth = second(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await redis.zcard(key)).toBe(8);
    controller.abort();
    await expect(ninth).rejects.toThrow();

    await createGeminiRequestLimiter(otherRedis, otherCredential)();
    expect(await redis.zcard(otherKey)).toBe(1);

    const [seconds, microseconds] = await redis.time();
    const now = Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
    const oldest = await redis.zrange(key, 0, 0);
    await redis.zadd(key, now - 60_000, oldest[0]!);
    await second();
    expect(await redis.zcard(key)).toBe(8);
  });

  it("fails closed and sanitizes Redis errors", async () => {
    const broken = new Redis("redis://127.0.0.1:1", {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    broken.on("error", () => {});
    const send = vi.fn<typeof fetch>();
    const limitedFetch = createLimitedGeminiFetch(createGeminiRequestLimiter(broken, credential), send);
    await expect(limitedFetch("https://example.test")).rejects.toThrow(GeminiRateLimitError);
    expect(send).not.toHaveBeenCalled();
    broken.disconnect();
  });

  it("limits both upload requests, polling, generation, and deletion through the SDK", async () => {
    const acquire = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn<typeof fetch>(async (_input, init) => {
      const uploadCommand = new Headers(init?.headers).get("x-goog-upload-command");
      if (uploadCommand === "start") {
        return new Response("{}", { headers: { "x-goog-upload-url": "https://example.test/upload" } });
      }
      if (uploadCommand?.includes("upload")) {
        return new Response(JSON.stringify({ file: { name: "files/test", state: "PROCESSING" } }), {
          headers: { "x-goog-upload-status": "final" },
        });
      }
      if (init?.method === "GET") {
        return Response.json({ name: "files/test", state: "ACTIVE", uri: "https://example.test/file" });
      }
      if (init?.method === "DELETE") return Response.json({});
      return Response.json({ candidates: [{ content: { parts: [{ text: '{"products":[]}' }] }, finishReason: "STOP" }] });
    });
    const client = new GoogleGenAI({
      apiKey: "test",
      httpOptions: { fetch: createLimitedGeminiFetch(acquire, send), retryOptions: { attempts: 1 } },
    });
    await client.files.upload({ file: new Blob(["pdf"], { type: "application/pdf" }), config: { mimeType: "application/pdf" } });
    await client.files.get({ name: "files/test" });
    await client.models.generateContent({ model: "test", contents: "test", config: { httpOptions: { timeout: 5000 } } });
    await client.files.delete({ name: "files/test" });
    expect(send).toHaveBeenCalledTimes(5);
    expect(acquire).toHaveBeenCalledTimes(5);
  });

  it("preserves limiter failures through the real SDK without sending data", async () => {
    const send = vi.fn<typeof fetch>();
    const fetch = createLimitedGeminiFetch(async () => { throw new GeminiRateLimitError(); }, send);
    const analyzer = createGeminiCatalogAnalyzer("test", "test", fetch);
    await expect(analyzer(Buffer.from("pdf"), 1, [], "tags")).rejects.toThrow("Gemini request limiter is unavailable");
    expect(send).not.toHaveBeenCalled();
  });
});

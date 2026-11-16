import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Redis } from "ioredis";

const WINDOW_MS = 60_000;
export const GEMINI_REQUESTS_PER_MINUTE = 8;

const acquireScript = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
if redis.call('ZCARD', KEYS[1]) < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  return 0
end
local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return math.max(1, tonumber(first[2]) + window - now)
`;

export class GeminiRateLimitError extends Error {
  constructor() {
    super("Gemini request limiter is unavailable. Check the Redis connection and retry.");
  }
}

export function createGeminiRequestLimiter(redis: Redis, apiKey: string) {
  const key = `gemini:requests:${createHash("sha256").update(apiKey).digest("hex")}`;
  return async (signal?: AbortSignal | null): Promise<void> => {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      let wait: unknown;
      try {
        wait = await redis.eval(acquireScript, 1, key, WINDOW_MS, GEMINI_REQUESTS_PER_MINUTE, randomUUID());
      } catch {
        throw new GeminiRateLimitError();
      }
      if (typeof wait !== "number" || !Number.isSafeInteger(wait) || wait < 0 || wait > WINDOW_MS) {
        throw new GeminiRateLimitError();
      }
      if (wait === 0) return;
      await delay(wait, undefined, { signal: signal ?? undefined });
    }
  };
}

export function createLimitedGeminiFetch(
  acquire: (signal?: AbortSignal | null) => Promise<void>,
  fetchRequest: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    await acquire(signal);
    return fetchRequest(input, init);
  };
}

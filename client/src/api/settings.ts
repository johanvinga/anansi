import { apiRequest } from "./client";
import type { AppSettings } from "./types";

let cached: Promise<AppSettings> | null = null;

/** Loads server settings once per page load. A failed request is retried on the next call. */
export function loadSettings(): Promise<AppSettings> {
  cached ??= apiRequest<AppSettings>("GET", "/settings").catch((error: unknown) => {
    cached = null;
    throw error;
  });
  return cached;
}

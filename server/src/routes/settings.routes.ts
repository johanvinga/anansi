import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { CURRENCY_CODES } from "../lib/currency.js";
import type { Guards } from "./route-helpers.js";

/** Client-facing settings so forms can pre-select DEFAULT_CURRENCY and enforce the upload limit. */
export function registerSettingsRoutes(app: FastifyInstance, config: AppConfig, guards: Guards): void {
  app.get("/settings", { preHandler: guards.requireUser }, async () => ({
    defaultCurrency: config.defaultCurrency,
    maxUploadMb: config.maxUploadMb,
    currencies: CURRENCY_CODES,
  }));
}

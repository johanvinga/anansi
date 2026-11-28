import type { Database } from "../db.js";
import type { AuditRequestContext } from "./audit.service.js";
import type { CatalogExtractionQueue } from "./catalog-extraction.queue.js";
import { startCatalogExtraction, type ExtractionDeps } from "./catalog.service.js";

const QUOTA_ERROR = "Gemini quota or rate limit exceeded. Try again later.";

interface QuotaFailure {
  id: string;
  catalogId: string;
  name: string;
  prompt: "supplier" | "tags";
}

export async function findQuotaFailures(db: Database): Promise<QuotaFailure[]> {
  return db.$queryRaw<QuotaFailure[]>`
    SELECT latest.id, latest.catalog_id AS "catalogId", c.name, latest.prompt
    FROM (
      SELECT DISTINCT ON (catalog_id, prompt)
        id, catalog_id, prompt, status, processing_error, created_at
      FROM catalog_extraction_jobs
      ORDER BY catalog_id, prompt, created_at DESC, id DESC
    ) latest
    JOIN catalogs c ON c.id = latest.catalog_id
    WHERE latest.status = 'failed' AND latest.processing_error = ${QUOTA_ERROR}
    ORDER BY latest.created_at, latest.id
  `;
}

export async function retryQuotaFailure(
  deps: ExtractionDeps,
  request: AuditRequestContext,
  queue: CatalogExtractionQueue,
  failure: QuotaFailure,
): Promise<"queued" | "skipped"> {
  const latest = await deps.db.catalogExtractionJob.findFirst({
    where: { catalogId: failure.catalogId, prompt: failure.prompt },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, status: true, processingError: true },
  });
  if (latest?.id !== failure.id || latest.status !== "failed" || latest.processingError !== QUOTA_ERROR) {
    return "skipped";
  }
  const job = await startCatalogExtraction(deps, request, failure.catalogId, queue, failure.prompt, {
    id: failure.id,
    processingError: QUOTA_ERROR,
  });
  if (job.status === "failed") throw new Error(job.error ?? "Could not queue catalog analysis.");
  return "queued";
}

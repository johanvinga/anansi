import { randomUUID } from "node:crypto";
import type { Database } from "../db.js";
import { AuditAction, recordAudit } from "./audit.service.js";
import { queueStoredFileRemoval } from "./stored-file-cleanup.js";

export async function resetCatalogExtractionJobs(db: Database, includeFailed: boolean): Promise<number> {
  const statuses = includeFailed ? (["queued", "processing", "failed"] as const) : (["queued", "processing"] as const);
  const context = {
    requestId: `reset-${randomUUID()}`,
    ipAddress: null,
    actor: { userId: null, email: "system:reset-extraction-queue" },
  };

  return db.$transaction(async (tx) => {
    const jobs = await tx.catalogExtractionJob.findMany({
      where: { status: { in: [...statuses] } },
      select: { id: true, catalogId: true, images: { select: { storageKey: true } } },
    });
    const catalogIds = [...new Set(jobs.map((job) => job.catalogId))];
    for (const job of jobs) {
      for (const image of job.images) await queueStoredFileRemoval(tx, image.storageKey);
    }
    await tx.catalogExtractionJob.deleteMany({ where: { id: { in: jobs.map((job) => job.id) } } });

    const stuck = await tx.catalog.findMany({
      where: { analysisStatus: { in: [...statuses] }, id: { notIn: catalogIds } },
      select: { id: true },
    });
    catalogIds.push(...stuck.map((catalog) => catalog.id));

    for (const catalogId of catalogIds) {
      const [catalog, latest, processedTags] = await Promise.all([
        tx.catalog.findUniqueOrThrow({ where: { id: catalogId }, select: { analysisStatus: true } }),
        tx.catalogExtractionJob.findFirst({
          where: { catalogId },
          orderBy: { createdAt: "desc" },
          select: { status: true },
        }),
        tx.catalogExtractionJob.count({ where: { catalogId, prompt: "tags", status: "processed" } }),
      ]);
      const analysisStatus = latest?.status === "processed"
        ? processedTags > 0 ? "processed" : "metadata_only"
        : latest?.status ?? "not_processed";
      await tx.catalog.update({ where: { id: catalogId }, data: { analysisStatus } });
      await recordAudit(tx, context, {
        action: AuditAction.CATALOG_ANALYSIS_RESET,
        outcome: "success",
        entityType: "Catalog",
        entityId: catalogId,
        changes: { analysisStatus: { before: catalog.analysisStatus, after: analysisStatus } },
      });
    }
    return catalogIds.length;
  }, { timeout: 120_000 });
}

import { randomUUID } from "node:crypto";
import type { Catalog, Prisma } from "../generated/prisma/client.js";
import { catalogNameFromFileName } from "./catalog.service.js";
import { AuditAction, diffFields, recordAudit, type AuditRequestContext } from "./audit.service.js";

interface CatalogAnalysisMetadata {
  name: string | null;
  categoryPath?: { en: string; fr: string }[] | null;
  categoryPaths?: { en: string; fr: string }[][];
}

const systemRequest = (): AuditRequestContext => ({
  requestId: randomUUID(),
  ipAddress: null,
  actor: { userId: null, email: "system:catalog-analysis" },
});

export async function applyCatalogAnalysisMetadata(
  tx: Prisma.TransactionClient,
  catalog: Catalog,
  metadata: CatalogAnalysisMetadata | null,
  products: { categories: string[] }[] = [],
): Promise<void> {
  if (!metadata && products.length === 0) return;
  const existing = await tx.catalog.findUniqueOrThrow({
    where: { id: catalog.id },
    include: { tags: true },
  });
  const inferredName = metadata?.name?.trim() || null;
  const shouldApplyName =
    inferredName !== null &&
    existing.name === catalogNameFromFileName(existing.originalFileName);
  const existingTagIds = new Set(existing.tags.map((link) => link.tagId));
  if (!shouldApplyName) return;
  const name = shouldApplyName ? inferredName : existing.name;
  if (shouldApplyName) {
    await tx.catalog.update({ where: { id: catalog.id }, data: { name } });
  }

  await recordAudit(tx, systemRequest(), {
    action: AuditAction.CATALOG_UPDATE,
    outcome: "success",
    entityType: "Catalog",
    entityId: catalog.id,
    changes: diffFields(
      {
        name: existing.name,
        tags: [...existingTagIds].sort(),
      },
      { name, tags: [...existingTagIds].sort() },
    ),
  });

}

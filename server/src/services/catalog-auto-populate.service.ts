import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { CatalogExtractionJob, Prisma } from "../generated/prisma/client.js";
import type { Database } from "../db.js";
import { nameKeyOf, PRISMA_UNIQUE_VIOLATION } from "../lib/text.js";
import { AuditAction, diffFields, recordAudit, type AuditRequestContext } from "./audit.service.js";
import type { CatalogExtractionQueue } from "./catalog-extraction.queue.js";
import { startCatalogExtraction, type CatalogDeps, type ExtractionDeps } from "./catalog.service.js";
import { syncSupplierTags } from "./tag.service.js";

interface SupplierEvidence {
  value: string;
}

interface AnalyzedTag {
  en: string;
  fr: string;
}

interface AnalyzedSupplier {
  name?: SupplierEvidence | null;
  street?: SupplierEvidence | null;
  city?: SupplierEvidence | null;
  stateRegion?: SupplierEvidence | null;
  postalCode?: SupplierEvidence | null;
  country?: SupplierEvidence | null;
  website?: SupplierEvidence | null;
  contacts?: { name?: SupplierEvidence | null }[];
}

export type PopulateOutcome = "queued" | "complete" | "running";

type AnalysisPrompt = "supplier" | "tags";

export interface PopulateCatalogResult {
  catalogId: string;
  outcome: PopulateOutcome;
}

const systemRequest = (): AuditRequestContext => ({
  requestId: randomUUID(),
  ipAddress: null,
  actor: { userId: null, email: "system:catalog-analysis" },
});

function clip(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function evidenceValue(value: SupplierEvidence | null | undefined, max: number): string | null {
  return clip(typeof value?.value === "string" ? value.value : null, max);
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === PRISMA_UNIQUE_VIOLATION;
}

function asRecord(value: Prisma.JsonValue | null | undefined): Prisma.JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Returns true when a newer job for the same prompt exists, so this job's results are stale. */
async function isSuperseded(tx: Prisma.TransactionClient, job: CatalogExtractionJob): Promise<boolean> {
  const newer = await tx.catalogExtractionJob.findFirst({
    where: { catalogId: job.catalogId, prompt: job.prompt, createdAt: { gt: job.createdAt } },
    select: { id: true },
  });
  return newer !== null;
}

async function autoApplySupplier(db: Database, job: CatalogExtractionJob): Promise<void> {
  const request = systemRequest();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM catalogs WHERE id = ${job.catalogId}::uuid FOR UPDATE`;
    const catalog = await tx.catalog.findUnique({ where: { id: job.catalogId } });
    // Never overwrite a supplier that was assigned manually.
    if (!catalog || catalog.supplierId || await isSuperseded(tx, job)) return;

    const supplier = asRecord(job.results)?.supplier as AnalyzedSupplier | null | undefined;
    const name = evidenceValue(supplier?.name, 200);
    if (!supplier || !name) return;
    const fields = {
      street: evidenceValue(supplier.street, 200),
      city: evidenceValue(supplier.city, 100),
      stateRegion: evidenceValue(supplier.stateRegion, 100),
      postalCode: evidenceValue(supplier.postalCode, 20),
      country: evidenceValue(supplier.country, 100),
      website: evidenceValue(supplier.website, 500),
    };

    let supplierId: string;
    const existing = await tx.supplier.findUnique({ where: { nameKey: nameKeyOf(name) } });
    if (existing) {
      supplierId = existing.id;
      const filled = Object.fromEntries(
        Object.entries(fields).filter(([key, value]) => value !== null && existing[key as keyof typeof fields] === null),
      );
      if (Object.keys(filled).length > 0) {
        await tx.supplier.update({ where: { id: existing.id }, data: filled });
        await recordAudit(tx, request, {
          action: AuditAction.SUPPLIER_UPDATE,
          outcome: "success",
          entityType: "Supplier",
          entityId: existing.id,
          changes: diffFields(
            Object.fromEntries(Object.keys(filled).map((key) => [key, null])),
            filled,
          ),
        });
      }
    } else {
      const created = await tx.supplier.create({
        data: { name, nameKey: nameKeyOf(name), ...fields },
      });
      supplierId = created.id;
      await recordAudit(tx, request, {
        action: AuditAction.SUPPLIER_CREATE,
        outcome: "success",
        entityType: "Supplier",
        entityId: created.id,
        changes: diffFields({}, { name, ...fields, tags: [] }),
      });
    }

    const knownContacts = new Set(
      (await tx.supplierContact.findMany({ where: { supplierId }, select: { firstName: true } }))
        .map((contact) => contact.firstName?.trim().toLowerCase()),
    );
    for (const contact of supplier.contacts ?? []) {
      const firstName = evidenceValue(contact.name, 100);
      if (!firstName || knownContacts.has(firstName.toLowerCase())) continue;
      knownContacts.add(firstName.toLowerCase());
      const created = await tx.supplierContact.create({ data: { supplierId, firstName } });
      await recordAudit(tx, request, {
        action: AuditAction.SUPPLIER_CONTACT_CREATE,
        outcome: "success",
        entityType: "SupplierContact",
        entityId: created.id,
        changes: diffFields({}, { supplierId, firstName }),
      });
    }

    await tx.catalog.update({ where: { id: catalog.id }, data: { supplierId } });
    await recordAudit(tx, request, {
      action: AuditAction.CATALOG_UPDATE,
      outcome: "success",
      entityType: "Catalog",
      entityId: catalog.id,
      changes: diffFields({ supplierId: null }, { supplierId }),
    });
  }, { timeout: 60_000 });
}

function collectTags(raw: unknown): AnalyzedTag[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): AnalyzedTag[] => {
    const tag = item as { en?: unknown; fr?: unknown } | null;
    const en = typeof tag?.en === "string" ? clip(tag.en, 100) : null;
    if (!en) return [];
    return [{ en, fr: (typeof tag?.fr === "string" ? clip(tag.fr, 100) : null) ?? en }];
  });
}

async function autoApplyTags(db: Database, job: CatalogExtractionJob): Promise<void> {
  const request = systemRequest();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM catalogs WHERE id = ${job.catalogId}::uuid FOR UPDATE`;
    const catalog = await tx.catalog.findUnique({
      where: { id: job.catalogId },
      include: { tags: true },
    });
    if (!catalog || await isSuperseded(tx, job)) return;

    const results = asRecord(job.results);
    const analyzedProducts = (Array.isArray(results?.products) ? results.products : []) as {
      name?: unknown;
      tags?: unknown;
    }[];
    const productTags = analyzedProducts.map((product) => ({
      name: typeof product?.name === "string" ? product.name.trim() : "",
      tags: collectTags(product?.tags),
    }));
    const catalogTags = new Map<string, AnalyzedTag>();
    for (const tag of [...collectTags(results?.catalogTags), ...productTags.flatMap((product) => product.tags)]) {
      catalogTags.set(nameKeyOf(tag.en), tag);
    }
    if (catalogTags.size === 0) return;

    // Archived tags were retired on purpose, so analysis results never reattach them.
    const tagIdByKey = new Map<string, string | null>();
    const resolveTag = async (tag: AnalyzedTag): Promise<string | null> => {
      const key = nameKeyOf(tag.en);
      if (tagIdByKey.has(key)) return tagIdByKey.get(key)!;
      let row = await tx.tag.findUnique({ where: { nameKey: key } });
      if (!row && tag.fr) row = await tx.tag.findUnique({ where: { nameKey: nameKeyOf(tag.fr) } });
      if (!row) {
        row = await tx.tag.create({ data: { nameEn: tag.en, nameFr: tag.fr, nameKey: key } });
        await recordAudit(tx, request, {
          action: AuditAction.CATEGORY_CREATE,
          outcome: "success",
          entityType: "Tag",
          entityId: row.id,
          changes: diffFields({}, { "name.en": row.nameEn, "name.fr": row.nameFr }),
        });
      }
      const id = row.isArchived ? null : row.id;
      tagIdByKey.set(key, id);
      return id;
    };

    const before = catalog.tags.map((link) => link.tagId);
    const after = new Set(before);
    for (const tag of catalogTags.values()) {
      const id = await resolveTag(tag);
      if (id) after.add(id);
    }
    if (after.size > before.length) {
      await tx.catalogTag.createMany({
        data: [...after].map((tagId) => ({ catalogId: catalog.id, tagId })),
        skipDuplicates: true,
      });
      await recordAudit(tx, request, {
        action: AuditAction.CATALOG_UPDATE,
        outcome: "success",
        entityType: "Catalog",
        entityId: catalog.id,
        changes: diffFields({ tags: [...before].sort() }, { tags: [...after].sort() }),
      });
    }

    if (!catalog.supplierId) return;
    for (const analyzed of productTags) {
      if (!analyzed.name || analyzed.tags.length === 0) continue;
      const product = await tx.product.findFirst({
        where: {
          supplierId: catalog.supplierId,
          OR: [
            { nameEn: { equals: analyzed.name, mode: "insensitive" } },
            { nameFr: { equals: analyzed.name, mode: "insensitive" } },
          ],
        },
        include: { tags: true },
      });
      if (!product) continue;
      const productBefore = product.tags.map((link) => link.tagId);
      const productAfter = new Set(productBefore);
      for (const tag of analyzed.tags) {
        const id = await resolveTag(tag);
        if (id) productAfter.add(id);
      }
      if (productAfter.size === productBefore.length) continue;
      await tx.productTag.createMany({
        data: [...productAfter].map((tagId) => ({ productId: product.id, tagId })),
        skipDuplicates: true,
      });
      await syncSupplierTags(tx, catalog.supplierId);
      await recordAudit(tx, request, {
        action: AuditAction.PRODUCT_UPDATE,
        outcome: "success",
        entityType: "Product",
        entityId: product.id,
        changes: diffFields({ tags: [...productBefore].sort() }, { tags: [...productAfter].sort() }),
      });
    }
  }, { timeout: 60_000 });
}

/**
 * Applies a processed analysis job to its catalog without any confirmation step.
 * Supplier results only fill a catalog that has no supplier; tag results only add tags.
 * Failures are logged and never fail the analysis job itself.
 */
export async function autoApplyCatalogAnalysis(
  db: Database,
  extractionJobId: string,
  log?: Pick<FastifyBaseLogger, "error">,
): Promise<void> {
  try {
    const job = await db.catalogExtractionJob.findUnique({ where: { id: extractionJobId } });
    if (!job || job.status !== "processed") return;
    const apply = job.prompt === "supplier" ? autoApplySupplier : autoApplyTags;
    try {
      await apply(db, job);
    } catch (error) {
      // A concurrent job may have created the same supplier or tag first; the second attempt reuses it.
      if (!isUniqueViolation(error)) throw error;
      await apply(db, job);
    }
  } catch (error) {
    log?.error(
      { extractionJobId, errorName: error instanceof Error ? error.name : "UnknownError" },
      "Could not apply catalog analysis results",
    );
  }
}

/**
 * Starts the supplier and/or tag analysis a catalog is still missing. The results are applied
 * automatically when each job completes.
 */
export async function populateCatalog(
  deps: ExtractionDeps,
  request: AuditRequestContext,
  catalogId: string,
  queue: CatalogExtractionQueue,
): Promise<PopulateOutcome> {
  const plan = await planPopulate(deps.db, catalogId);
  if (!plan || plan.missing.length === 0) return "complete";
  if (plan.startable.length === 0) return "running";
  for (const prompt of plan.startable) {
    await startCatalogExtraction(deps, request, catalogId, queue, prompt);
  }
  return "queued";
}

/** Splits what a catalog lacks into the analyses that can start now and those already processing. */
async function planPopulate(
  db: Database,
  catalogId: string,
): Promise<{ missing: AnalysisPrompt[]; startable: AnalysisPrompt[] } | null> {
  const catalog = await db.catalog.findUnique({
    where: { id: catalogId },
    select: { supplierId: true, _count: { select: { tags: true } } },
  });
  if (!catalog) return null;
  const missing: AnalysisPrompt[] = [];
  if (!catalog.supplierId) missing.push("supplier");
  if (catalog._count.tags === 0) missing.push("tags");

  const startable: AnalysisPrompt[] = [];
  for (const prompt of missing) {
    const running = await db.catalogExtractionJob.findFirst({
      where: { catalogId, prompt, status: "processing" },
      select: { id: true },
    });
    if (!running) startable.push(prompt);
  }
  return { missing, startable };
}

/** Scans a freshly uploaded catalog; a queueing problem must never fail the upload itself. */
export async function populateUploadedCatalog(
  deps: CatalogDeps,
  request: AuditRequestContext,
  catalogId: string,
  queue: CatalogExtractionQueue | undefined,
): Promise<void> {
  if (!queue) return;
  try {
    await populateCatalog(deps, request, catalogId, queue);
  } catch (error) {
    deps.log.error(
      { catalogId, errorName: error instanceof Error ? error.name : "UnknownError" },
      "Could not start automatic catalog analysis",
    );
  }
}

export async function populateCatalogs(
  deps: CatalogDeps,
  request: AuditRequestContext,
  catalogIds: string[],
  queue: CatalogExtractionQueue,
): Promise<PopulateCatalogResult[]> {
  const results: PopulateCatalogResult[] = [];
  for (const catalogId of new Set(catalogIds)) {
    results.push({ catalogId, outcome: await populateCatalog(deps, request, catalogId, queue) });
  }
  return results;
}

export type BulkPopulateOutcome = PopulateOutcome | "would-queue" | "failed";

export interface BulkPopulateResult {
  catalogId: string;
  name: string;
  /** The analyses the catalog still lacks (no supplier, no tags). */
  missing: AnalysisPrompt[];
  outcome: BulkPopulateOutcome;
}

export interface PopulateAllOptions {
  dryRun?: boolean;
  /** Caps how many catalogs that lack a supplier or tags are handled, oldest first. */
  limit?: number | undefined;
}

/**
 * Handles every catalog that has no supplier or no tags, using the same rule as populateCatalog.
 * A dry run reports what would be queued and changes nothing. One failing catalog never stops the run.
 */
export async function populateAllMissingCatalogs(
  deps: ExtractionDeps,
  request: AuditRequestContext,
  queue: CatalogExtractionQueue,
  options: PopulateAllOptions = {},
): Promise<BulkPopulateResult[]> {
  const catalogs = await deps.db.catalog.findMany({
    where: { OR: [{ supplierId: null }, { tags: { none: {} } }] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    ...(options.limit === undefined ? {} : { take: options.limit }),
    select: { id: true, name: true },
  });

  const results: BulkPopulateResult[] = [];
  for (const catalog of catalogs) {
    const plan = await planPopulate(deps.db, catalog.id);
    if (!plan || plan.missing.length === 0) continue;
    const base = { catalogId: catalog.id, name: catalog.name, missing: plan.missing };
    try {
      const outcome: BulkPopulateOutcome = options.dryRun
        ? plan.startable.length > 0 ? "would-queue" : "running"
        : await populateCatalog(deps, request, catalog.id, queue);
      results.push({ ...base, outcome });
    } catch (error) {
      deps.log.error(
        { catalogId: catalog.id, errorName: error instanceof Error ? error.name : "UnknownError" },
        "Could not start catalog analysis",
      );
      results.push({ ...base, outcome: "failed" });
    }
  }
  return results;
}

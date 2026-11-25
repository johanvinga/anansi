import type { Prisma } from "../generated/prisma/client.js";
import type { Database } from "../db.js";
import { errors } from "../errors.js";
import { nameKeyOf } from "../lib/text.js";
import { AuditAction, diffFields, recordAudit, type AuditRequestContext } from "./audit.service.js";
import { syncSupplierTags } from "./tag.service.js";

interface Evidence {
  pageNumber: number;
  excerpt: string;
}

interface TaggedName {
  en: string;
  fr: string;
  confidence: number;
  evidence: Evidence[];
}

interface SupplierEvidence {
  value: string;
  pageNumber: number;
  excerpt: string;
}

export interface TagReviewInput {
  jobId: string;
  catalogTagIds: string[];
  newCatalogTags: { en: string; fr: string }[];
  productTagIds: { productId: string; tagIds: string[]; newTags: { en: string; fr: string }[] }[];
}

export interface SupplierReviewInput {
  jobId: string;
  action: "reuse" | "create";
  supplierId?: string;
  name: string;
  address: {
    street: string | null;
    city: string | null;
    stateRegion: string | null;
    postalCode: string | null;
    country: string | null;
  };
  website?: string | null;
  contacts: { name: string; role: string | null }[];
}

export async function reviewCatalogTagAnalysis(
  db: Database,
  request: AuditRequestContext,
  catalogId: string,
  jobId: string,
) {
  const catalog = await db.catalog.findUnique({
    where: { id: catalogId },
    include: { tags: { include: { tag: true } }, extractionJobs: { orderBy: { createdAt: "desc" } } },
  });
  if (!catalog) throw errors.notFound("Catalog");
  const job = catalog.extractionJobs.find((item) => item.prompt === "tags");
  if (!job || job.id !== jobId || job.status !== "processed" || job.prompt !== "tags") {
    throw errors.conflict("The selected tag analysis is no longer the latest completed tag analysis.");
  }
  const results = job.results as Prisma.JsonObject | null;
  const products = Array.isArray(results?.products)
    ? results.products as unknown as { name: string; tags: TaggedName[]; evidence: Evidence[] }[]
    : [];
  const catalogTags = Array.isArray(results?.catalogTags)
    ? results.catalogTags as unknown as TaggedName[]
    : [];
  const existingTags = await db.tag.findMany({
    where: { isArchived: false },
    select: { id: true, nameEn: true, nameFr: true, nameKey: true },
  });
  const matchTag = (tag: TaggedName) => existingTags.find((existing) =>
    existing.nameKey === nameKeyOf(tag.en) ||
    (tag.fr.trim() && existing.nameKey === nameKeyOf(tag.fr)),
  ) ?? null;
  const toReviewTag = (tag: TaggedName) => ({
    name: { en: tag.en, fr: tag.fr },
    confidence: tag.confidence,
    evidence: tag.evidence,
    existing: matchTag(tag),
  });
  await recordAudit(db, request, {
    action: AuditAction.CATALOG_ANALYSIS_VIEW,
    outcome: "success",
    entityType: "Catalog",
    entityId: catalogId,
  });
  return {
    jobId,
    catalogTags: catalogTags.map(toReviewTag),
    products: await Promise.all(products.map(async (product) => {
      const existingProduct = catalog.supplierId
        ? await db.product.findFirst({
          where: {
            supplierId: catalog.supplierId,
            OR: [
              { nameEn: { equals: product.name, mode: "insensitive" } },
              { nameFr: { equals: product.name, mode: "insensitive" } },
            ],
          },
          select: { id: true, nameEn: true, nameFr: true },
        })
        : null;
      return {
        name: product.name,
        evidence: product.evidence,
        existingProduct,
        tags: product.tags.map(toReviewTag),
      };
    })),
  };
}

export async function applyCatalogTagReview(
  db: Database,
  request: AuditRequestContext,
  catalogId: string,
  input: TagReviewInput,
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM catalogs WHERE id = ${catalogId}::uuid FOR UPDATE`;
    const catalog = await tx.catalog.findUnique({
      where: { id: catalogId },
      include: { extractionJobs: { orderBy: { createdAt: "desc" } } },
    });
    if (!catalog) throw errors.notFound("Catalog");
    const job = catalog.extractionJobs.find((item) => item.prompt === "tags");
    if (!job || job.id !== input.jobId || job.status !== "processed" || job.prompt !== "tags") {
      throw errors.conflict("The selected tag analysis is no longer valid.");
    }

    const ensureTag = async (tag: { en: string; fr: string }): Promise<string> => {
      const nameKey = nameKeyOf(tag.en);
      const existing = await tx.tag.findUnique({ where: { nameKey } });
      if (existing) return existing.id;
      const created = await tx.tag.create({
        data: { nameEn: tag.en.trim(), nameFr: tag.fr.trim() || tag.en.trim(), nameKey },
      });
      await recordAudit(tx, request, {
        action: AuditAction.CATEGORY_CREATE,
        outcome: "success",
        entityType: "Tag",
        entityId: created.id,
        changes: diffFields({}, { "name.en": created.nameEn, "name.fr": created.nameFr }),
      });
      return created.id;
    };

    const catalogTagIds = new Set(input.catalogTagIds);
    for (const tag of input.newCatalogTags) catalogTagIds.add(await ensureTag(tag));
    await tx.catalogTag.deleteMany({ where: { catalogId } });
    await tx.catalogTag.createMany({
      data: [...catalogTagIds].map((tagId) => ({ catalogId, tagId })),
      skipDuplicates: true,
    });

    for (const assignment of input.productTagIds) {
      const product = await tx.product.findUnique({ where: { id: assignment.productId }, select: { id: true, supplierId: true } });
      if (!product) throw errors.validation([{ field: "productTagIds", message: "A selected product no longer exists." }]);
      const tagIds = new Set(assignment.tagIds);
      for (const tag of assignment.newTags) tagIds.add(await ensureTag(tag));
      await tx.productTag.deleteMany({ where: { productId: product.id } });
      await tx.productTag.createMany({
        data: [...tagIds].map((tagId) => ({ productId: product.id, tagId })),
        skipDuplicates: true,
      });
      await syncSupplierTags(tx, product.supplierId);
    }

    await recordAudit(tx, request, {
      action: AuditAction.CATALOG_UPDATE,
      outcome: "success",
      entityType: "Catalog",
      entityId: catalogId,
      changes: diffFields({ tags: [] }, { tags: [...catalogTagIds].sort() }),
    });
    return { catalogTagIds: [...catalogTagIds], productAssignments: input.productTagIds.length };
  });
}

export async function reviewCatalogSupplierAnalysis(
  db: Database,
  request: AuditRequestContext,
  catalogId: string,
  jobId: string,
) {
  const catalog = await db.catalog.findUnique({
    where: { id: catalogId },
    include: { extractionJobs: { orderBy: { createdAt: "desc" } } },
  });
  if (!catalog) throw errors.notFound("Catalog");
  const job = catalog.extractionJobs.find((item) => item.prompt === "supplier");
  if (!job || job.id !== jobId || job.status !== "processed" || job.prompt !== "supplier") {
    throw errors.conflict("The selected supplier analysis is no longer the latest completed supplier analysis.");
  }
  const results = job.results as Prisma.JsonObject | null;
  const rawSupplier = results?.supplier as {
    name: SupplierEvidence | null;
    street: SupplierEvidence | null;
    city: SupplierEvidence | null;
    stateRegion: SupplierEvidence | null;
    postalCode: SupplierEvidence | null;
    country: SupplierEvidence | null;
    website: SupplierEvidence | null;
    email: SupplierEvidence | null;
    phone: SupplierEvidence | null;
    contacts: { name: SupplierEvidence; role: SupplierEvidence | null }[];
  } | null;
  const supplier = rawSupplier
    ? {
        ...rawSupplier,
        contacts: Array.isArray(rawSupplier.contacts) ? rawSupplier.contacts : [],
      }
    : null;
  const name = supplier?.name?.value ?? null;
  const exactMatch = name
    ? await db.supplier.findUnique({ where: { nameKey: nameKeyOf(name) }, select: { id: true, name: true } })
    : null;
  await recordAudit(db, request, {
    action: AuditAction.CATALOG_ANALYSIS_VIEW,
    outcome: "success",
    entityType: "Catalog",
    entityId: catalogId,
  });
  return {
    jobId,
    supplier: supplier ? {
      name: supplier.name,
      address: {
        street: supplier.street,
        city: supplier.city,
        stateRegion: supplier.stateRegion,
        postalCode: supplier.postalCode,
        country: supplier.country,
      },
      website: supplier.website,
      email: supplier.email,
      phone: supplier.phone,
      contacts: supplier.contacts,
    } : null,
    exactMatch,
  };
}

export async function applyCatalogSupplierReview(
  db: Database,
  request: AuditRequestContext,
  catalogId: string,
  input: SupplierReviewInput,
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM catalogs WHERE id = ${catalogId}::uuid FOR UPDATE`;
    const catalog = await tx.catalog.findUnique({
      where: { id: catalogId },
      include: { extractionJobs: { orderBy: { createdAt: "desc" } } },
    });
    if (!catalog) throw errors.notFound("Catalog");
    const job = catalog.extractionJobs.find((item) => item.prompt === "supplier");
    if (!job || job.id !== input.jobId || job.status !== "processed" || job.prompt !== "supplier") {
      throw errors.conflict("The selected supplier analysis is no longer valid.");
    }
    let supplierId: string;
    if (input.action === "reuse") {
      if (!input.supplierId) throw errors.validation([{ field: "supplierId", message: "Select an existing supplier." }]);
      const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId } });
      if (!supplier) throw errors.notFound("Supplier");
      if (nameKeyOf(supplier.name) !== nameKeyOf(input.name)) {
        throw errors.validation([{ field: "supplierId", message: "The selected supplier name does not exactly match the suggestion." }]);
      }
      supplierId = supplier.id;
      await tx.supplier.update({
        where: { id: supplierId },
        data: {
          street: supplier.street ?? input.address.street,
          city: supplier.city ?? input.address.city,
          stateRegion: supplier.stateRegion ?? input.address.stateRegion,
          postalCode: supplier.postalCode ?? input.address.postalCode,
          country: supplier.country ?? input.address.country,
          website: supplier.website ?? input.website,
        },
      });
    } else {
      const existing = await tx.supplier.findUnique({ where: { nameKey: nameKeyOf(input.name) } });
      if (existing) throw errors.conflict("A supplier with this exact name already exists.");
      const supplier = await tx.supplier.create({
        data: {
          name: input.name.trim(),
          nameKey: nameKeyOf(input.name),
          street: input.address.street,
          city: input.address.city,
          stateRegion: input.address.stateRegion,
          postalCode: input.address.postalCode,
          country: input.address.country,
          website: input.website,
        },
      });
      supplierId = supplier.id;
    }
    for (const contact of input.contacts) {
      await tx.supplierContact.create({
        data: {
          supplierId,
          firstName: contact.name,
          lastName: null,
          email: null,
          phoneNumber: null,
          weChatId: null,
        },
      });
    }
    await tx.catalog.update({ where: { id: catalogId }, data: { supplierId } });
    await recordAudit(tx, request, {
      action: AuditAction.CATALOG_UPDATE,
      outcome: "success",
      entityType: "Catalog",
      entityId: catalogId,
      changes: diffFields({ supplierId: catalog.supplierId }, { supplierId }),
    });
    return { supplierId };
  });
}

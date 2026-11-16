import type { Prisma } from "../generated/prisma/client.js";
import { errors } from "../errors.js";
import { normalizeAttributeName } from "./catalog-attribute-matching.js";

export async function assertUniqueIndependentName(tx: Prisma.TransactionClient, name: string, exceptId?: string) {
  const key = normalizeAttributeName(name);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"independent-attribute:" + key}, 0))`;
  const fields = await tx.attributeField.findMany({
    where: { attributeSetId: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { nameEn: true },
  });
  if (fields.some((field) => normalizeAttributeName(field.nameEn) === key)) {
    throw errors.conflict("An independent attribute with this name already exists.");
  }
}

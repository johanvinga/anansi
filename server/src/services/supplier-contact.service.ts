import type { Prisma } from "../generated/prisma/client.js";
import type { Database } from "../db.js";
import { errors } from "../errors.js";
import { AuditAction, diffFields, recordAudit, type AuditRequestContext } from "./audit.service.js";

export interface SupplierContactInput {
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
  email?: string | null | undefined;
  phoneNumber?: string | null | undefined;
  weChatId?: string | null | undefined;
}

type SupplierContactRow = Prisma.SupplierContactGetPayload<Record<string, never>>;

export interface SupplierContactDto {
  id: string;
  supplierId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phoneNumber: string | null;
  weChatId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toDto(row: SupplierContactRow): SupplierContactDto {
  return {
    id: row.id,
    supplierId: row.supplierId,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phoneNumber: row.phoneNumber,
    weChatId: row.weChatId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function snapshotOf(row: SupplierContactRow): Record<string, unknown> {
  return {
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phoneNumber: row.phoneNumber,
    weChatId: row.weChatId,
  };
}

function normalize(input: SupplierContactInput) {
  return {
    firstName: input.firstName?.trim() || null,
    lastName: input.lastName?.trim() || null,
    email: input.email?.trim() || null,
    phoneNumber: input.phoneNumber?.trim() || null,
    weChatId: input.weChatId?.trim() || null,
  };
}

async function assertSupplier(
  db: Database | Prisma.TransactionClient,
  supplierId: string,
): Promise<void> {
  const supplier = await db.supplier.findUnique({ where: { id: supplierId }, select: { id: true } });
  if (!supplier) throw errors.notFound("Supplier");
}

export async function listSupplierContacts(
  db: Database,
  request: AuditRequestContext,
  supplierId: string,
): Promise<SupplierContactDto[]> {
  await assertSupplier(db, supplierId);
  const rows = await db.supplierContact.findMany({
    where: { supplierId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  await recordAudit(db, request, {
    action: AuditAction.SUPPLIER_CONTACT_LIST,
    outcome: "success",
    entityType: "Supplier",
    entityId: supplierId,
  });
  return rows.map(toDto);
}

export async function createSupplierContact(
  db: Database,
  request: AuditRequestContext,
  supplierId: string,
  input: SupplierContactInput,
): Promise<SupplierContactDto> {
  return db.$transaction(async (tx) => {
    await assertSupplier(tx, supplierId);
    const row = await tx.supplierContact.create({
      data: { supplierId, ...normalize(input) },
    });
    await recordAudit(tx, request, {
      action: AuditAction.SUPPLIER_CONTACT_CREATE,
      outcome: "success",
      entityType: "SupplierContact",
      entityId: row.id,
      changes: diffFields({}, snapshotOf(row)),
    });
    return toDto(row);
  });
}

export async function updateSupplierContact(
  db: Database,
  request: AuditRequestContext,
  supplierId: string,
  contactId: string,
  input: SupplierContactInput,
): Promise<SupplierContactDto> {
  return db.$transaction(async (tx) => {
    await assertSupplier(tx, supplierId);
    const existing = await tx.supplierContact.findFirst({
      where: { id: contactId, supplierId },
    });
    if (!existing) throw errors.notFound("Supplier contact");

    const row = await tx.supplierContact.update({
      where: { id: existing.id },
      data: normalize(input),
    });
    await recordAudit(tx, request, {
      action: AuditAction.SUPPLIER_CONTACT_UPDATE,
      outcome: "success",
      entityType: "SupplierContact",
      entityId: row.id,
      changes: diffFields(snapshotOf(existing), snapshotOf(row)),
    });
    return toDto(row);
  });
}

export async function deleteSupplierContact(
  db: Database,
  request: AuditRequestContext,
  supplierId: string,
  contactId: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await assertSupplier(tx, supplierId);
    const existing = await tx.supplierContact.findFirst({
      where: { id: contactId, supplierId },
    });
    if (!existing) throw errors.notFound("Supplier contact");

    await tx.supplierContact.delete({ where: { id: existing.id } });
    await recordAudit(tx, request, {
      action: AuditAction.SUPPLIER_CONTACT_DELETE,
      outcome: "success",
      entityType: "SupplierContact",
      entityId: existing.id,
      changes: diffFields(snapshotOf(existing), {}),
    });
  });
}

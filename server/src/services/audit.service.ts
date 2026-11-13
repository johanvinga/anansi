import type { Prisma } from "../generated/prisma/client.js";
import type { Database } from "../db.js";
import { errors } from "../errors.js";

export const AuditAction = {
  LOGIN_SUCCESS: "LOGIN_SUCCESS",
  LOGIN_FAILED: "LOGIN_FAILED",
  LOGOUT: "LOGOUT",
  PASSWORD_CHANGE: "PASSWORD_CHANGE",
  USER_CREATE: "USER_CREATE",
  USER_UPDATE: "USER_UPDATE",
  USER_PASSWORD_RESET: "USER_PASSWORD_RESET",
  USER_VIEW: "USER_VIEW",
  USER_LIST: "USER_LIST",
  AUDIT_LOG_VIEW: "AUDIT_LOG_VIEW",
  AUDIT_LOG_LIST: "AUDIT_LOG_LIST",
  SUPPLIER_CREATE: "SUPPLIER_CREATE",
  SUPPLIER_UPDATE: "SUPPLIER_UPDATE",
  SUPPLIER_DELETE: "SUPPLIER_DELETE",
  SUPPLIER_VIEW: "SUPPLIER_VIEW",
  SUPPLIER_LIST: "SUPPLIER_LIST",
  CATEGORY_CREATE: "CATEGORY_CREATE",
  CATEGORY_UPDATE: "CATEGORY_UPDATE",
  CATEGORY_DELETE: "CATEGORY_DELETE",
  CATEGORY_LIST: "CATEGORY_LIST",
  ASSET_UPLOAD: "ASSET_UPLOAD",
  ASSET_UPDATE: "ASSET_UPDATE",
  ASSET_DELETE: "ASSET_DELETE",
  ASSET_LIST: "ASSET_LIST",
  ASSET_DOWNLOAD: "ASSET_DOWNLOAD",
  CATALOG_UPLOAD: "CATALOG_UPLOAD",
  CATALOG_ANALYSIS_START: "CATALOG_ANALYSIS_START",
  CATALOG_ANALYSIS_VIEW: "CATALOG_ANALYSIS_VIEW",
  CATALOG_UPDATE: "CATALOG_UPDATE",
  CATALOG_DELETE: "CATALOG_DELETE",
  CATALOG_LIST: "CATALOG_LIST",
  CATALOG_DOWNLOAD: "CATALOG_DOWNLOAD",
  ATTRIBUTE_SET_CREATE: "ATTRIBUTE_SET_CREATE",
  ATTRIBUTE_SET_UPDATE: "ATTRIBUTE_SET_UPDATE",
  ATTRIBUTE_SET_DELETE: "ATTRIBUTE_SET_DELETE",
  ATTRIBUTE_SET_VIEW: "ATTRIBUTE_SET_VIEW",
  ATTRIBUTE_SET_LIST: "ATTRIBUTE_SET_LIST",
  ATTRIBUTE_FIELD_CREATE: "ATTRIBUTE_FIELD_CREATE",
  ATTRIBUTE_FIELD_UPDATE: "ATTRIBUTE_FIELD_UPDATE",
  ATTRIBUTE_FIELD_REORDER: "ATTRIBUTE_FIELD_REORDER",
  ATTRIBUTE_FIELD_ARCHIVE: "ATTRIBUTE_FIELD_ARCHIVE",
  ATTRIBUTE_FIELD_DELETE: "ATTRIBUTE_FIELD_DELETE",
  PRODUCT_CREATE: "PRODUCT_CREATE",
  PRODUCT_UPDATE: "PRODUCT_UPDATE",
  PRODUCT_DELETE: "PRODUCT_DELETE",
  PRODUCT_VIEW: "PRODUCT_VIEW",
  PRODUCT_LIST: "PRODUCT_LIST",
} as const;

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

export interface FieldChange {
  before: unknown;
  after: unknown;
}

/** Shape stored in `audit_logs.changes`: `{ field: { before, after } }`. */
export type FieldChanges = Record<string, FieldChange>;

export interface AuditActor {
  userId: string | null;
  email: string;
}

export interface RequestInfo {
  requestId: string;
  ipAddress: string | null;
}

export interface AuditRequestContext extends RequestInfo {
  actor: AuditActor;
}

export function contextFor(request: RequestInfo, actor: AuditActor): AuditRequestContext {
  return { ...request, actor };
}

export interface AuditEntryInput {
  action: AuditActionName;
  outcome: "success" | "failure";
  entityType?: string;
  entityId?: string;
  changes?: FieldChanges;
}

/**
 * Compares two snapshots and returns only the fields that differ.
 * Returns undefined when nothing changed.
 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldChanges | undefined {
  const changes: FieldChanges = {};
  // Union of keys so fields removed in `after` (for example, cleared attributes) are recorded too.
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const previous = before[field] ?? null;
    const next = after[field] ?? null;
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      changes[field] = { before: previous, after: next };
    }
  }
  return Object.keys(changes).length > 0 ? changes : undefined;
}

/**
 * Appends an audit entry. Pass the transaction client for changes so the entry
 * commits or rolls back together with the change (FR-AUD-09, NFR-17).
 */
export async function recordAudit(
  db: Prisma.TransactionClient | Database,
  context: AuditRequestContext,
  input: AuditEntryInput,
): Promise<void> {
  const changes = input.changes
    ? (JSON.parse(JSON.stringify(input.changes)) as Prisma.InputJsonObject)
    : undefined;

  await db.auditLog.create({
    data: {
      actorUserId: context.actor.userId,
      actorEmail: context.actor.email,
      action: input.action,
      outcome: input.outcome,
      entityType: input.entityType,
      entityId: input.entityId,
      changes,
      ipAddress: context.ipAddress,
      requestId: context.requestId,
    },
  });
}

export interface AuditLogFilters {
  userId?: string;
  action?: string;
  entityType?: string;
  from?: Date;
  to?: Date;
}

export async function listAuditLogs(
  db: Database,
  filters: AuditLogFilters,
  page: number,
  pageSize: number,
) {
  const where: Prisma.AuditLogWhereInput = {
    actorUserId: filters.userId,
    action: filters.action,
    entityType: filters.entityType,
    occurredAt: {
      gte: filters.from,
      lte: filters.to,
    },
  };

  const [total, rows] = await db.$transaction([
    db.auditLog.count({ where }),
    db.auditLog.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { items: rows.map(toAuditLogSummary), total, page, pageSize };
}

export async function getAuditLog(db: Database, id: string) {
  const row = await db.auditLog.findUnique({ where: { id } });
  if (!row) {
    throw errors.notFound("Audit entry");
  }
  return toAuditLogDetail(row);
}

type AuditLogRow = Prisma.AuditLogGetPayload<Record<string, never>>;

function toAuditLogSummary(row: AuditLogRow) {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    actorUserId: row.actorUserId,
    actorEmail: row.actorEmail,
    action: row.action,
    outcome: row.outcome,
    entityType: row.entityType,
    entityId: row.entityId,
    ipAddress: row.ipAddress,
    requestId: row.requestId,
  };
}

function toAuditLogDetail(row: AuditLogRow) {
  return { ...toAuditLogSummary(row), changes: row.changes ?? null };
}

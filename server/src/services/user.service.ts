import { Prisma, type User, type UserRole } from "../generated/prisma/client.js";
import type { Database } from "../db.js";
import { errors } from "../errors.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import {
  AuditAction,
  diffFields,
  recordAudit,
  type AuditRequestContext,
} from "./audit.service.js";
import { toSessionUser, type SessionUser } from "./auth.service.js";

export type UserDto = SessionUser;

export interface CreateUserInput {
  email: string;
  displayName?: string | undefined;
  role: UserRole;
  password: string;
}

export interface UpdateUserInput {
  displayName?: string | null | undefined;
  role?: UserRole | undefined;
  isActive?: boolean | undefined;
}

export interface ListUsersFilters {
  q?: string | undefined;
  page: number;
  pageSize: number;
}

const UNIQUE_VIOLATION = "P2002";

function toDto(user: User): UserDto {
  return toSessionUser(user);
}

/** Snapshot of the auditable user fields. Password data is deliberately excluded. */
function auditSnapshot(user: User): Record<string, unknown> {
  return {
    displayName: user.displayName,
    role: user.role,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION;
}

export async function listUsers(
  db: Database,
  request: AuditRequestContext,
  filters: ListUsersFilters,
) {
  const where: Prisma.UserWhereInput = filters.q
    ? {
        OR: [
          { email: { contains: filters.q.toLowerCase(), mode: "insensitive" } },
          { displayName: { contains: filters.q, mode: "insensitive" } },
        ],
      }
    : {};

  const [total, rows] = await db.$transaction([
    db.user.count({ where }),
    db.user.findMany({
      where,
      orderBy: { email: "asc" },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
  ]);

  await recordAudit(db, request, { action: AuditAction.USER_LIST, outcome: "success" });
  return { items: rows.map(toDto), total, page: filters.page, pageSize: filters.pageSize };
}

export async function getUser(db: Database, request: AuditRequestContext, id: string) {
  const user = await db.user.findUnique({ where: { id } });
  if (!user) {
    throw errors.notFound("User");
  }
  await recordAudit(db, request, {
    action: AuditAction.USER_VIEW,
    outcome: "success",
    entityType: "User",
    entityId: id,
  });
  return toDto(user);
}

export async function createUser(
  db: Database,
  request: AuditRequestContext,
  input: CreateUserInput,
): Promise<UserDto> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          displayName: input.displayName ?? null,
          role: input.role,
          passwordHash,
        },
      });
      await recordAudit(tx, request, {
        action: AuditAction.USER_CREATE,
        outcome: "success",
        entityType: "User",
        entityId: user.id,
        changes: diffFields({}, auditSnapshot(user)),
      });
      return toDto(user);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw errors.conflict("A user with this email already exists.");
    }
    throw error;
  }
}

export async function updateUser(
  db: Database,
  request: AuditRequestContext,
  id: string,
  input: UpdateUserInput,
): Promise<UserDto> {
  return db.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { id } });
    if (!existing) {
      throw errors.notFound("User");
    }

    const demotes = input.role !== undefined && input.role !== "admin";
    const deactivates = input.isActive === false;
    if (existing.role === "admin" && existing.isActive && (demotes || deactivates)) {
      await assertAnotherActiveAdmin(tx, id);
    }

    const updated = await tx.user.update({
      where: { id },
      data: {
        displayName: input.displayName,
        role: input.role,
        isActive: input.isActive,
      },
    });

    if (deactivates) {
      await tx.session.deleteMany({ where: { userId: id } });
    }

    const changes = diffFields(auditSnapshot(existing), auditSnapshot(updated));
    if (changes) {
      await recordAudit(tx, request, {
        action: AuditAction.USER_UPDATE,
        outcome: "success",
        entityType: "User",
        entityId: id,
        changes,
      });
    }
    return toDto(updated);
  });
}

export async function resetPassword(
  db: Database,
  request: AuditRequestContext,
  id: string,
  temporaryPassword: string,
): Promise<UserDto> {
  const passwordHash = await hashPassword(temporaryPassword);
  return db.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { id } });
    if (!existing) {
      throw errors.notFound("User");
    }

    const updated = await tx.user.update({
      where: { id },
      data: { passwordHash, mustChangePassword: true },
    });
    await tx.session.deleteMany({ where: { userId: id } });

    await recordAudit(tx, request, {
      action: AuditAction.USER_PASSWORD_RESET,
      outcome: "success",
      entityType: "User",
      entityId: id,
      changes: diffFields(auditSnapshot(existing), auditSnapshot(updated)),
    });
    return toDto(updated);
  });
}

export async function changeOwnPassword(
  db: Database,
  request: AuditRequestContext,
  userId: string,
  currentSessionId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const existing = await db.user.findUnique({ where: { id: userId } });
  if (!existing || !(await verifyPassword(currentPassword, existing.passwordHash))) {
    throw errors.validation([{ field: "currentPassword", message: "Current password is incorrect." }]);
  }
  if (currentPassword === newPassword) {
    throw errors.validation([
      { field: "newPassword", message: "New password must differ from the current password." },
    ]);
  }

  const passwordHash = await hashPassword(newPassword);
  await db.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
    });
    // Sign out every other session; the current one stays active.
    await tx.session.deleteMany({ where: { userId, NOT: { id: currentSessionId } } });

    await recordAudit(tx, request, {
      action: AuditAction.PASSWORD_CHANGE,
      outcome: "success",
      entityType: "User",
      entityId: userId,
      changes: diffFields(auditSnapshot(existing), auditSnapshot(updated)),
    });
  });
}

/** Locks the active admin rows and fails if `excludedId` is the only one left. */
async function assertAnotherActiveAdmin(tx: Prisma.TransactionClient, excludedId: string) {
  const activeAdmins = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM users WHERE role = 'admin' AND is_active = true FOR UPDATE`;
  if (!activeAdmins.some((admin) => admin.id !== excludedId)) {
    throw errors.conflict("The last active admin cannot be deactivated or demoted.");
  }
}

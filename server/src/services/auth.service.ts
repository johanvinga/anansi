import type { Database } from "../db.js";
import { errors } from "../errors.js";
import { verifyAgainstDummyHash, verifyPassword } from "../lib/password.js";
import type { LoginLimiter } from "../lib/login-limiter.js";
import { AuditAction, contextFor, recordAudit, type RequestInfo } from "./audit.service.js";
import type { AppConfig } from "../config.js";
import type { User } from "../generated/prisma/client.js";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  role: User["role"];
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthenticatedSession {
  sessionId: string;
  user: SessionUser;
}

export interface AuthDeps {
  db: Database;
  config: AppConfig;
  limiter: LoginLimiter;
  ipLimiter: LoginLimiter;
}

async function verifyCredentials(
  db: Database,
  email: string | null,
  password: string,
): Promise<{ user: User | null; valid: boolean }> {
  const user = email ? await db.user.findUnique({ where: { email } }) : null;
  const passwordOk = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyAgainstDummyHash(password);
  return { user, valid: Boolean(user && user.isActive && passwordOk) };
}

export async function authenticateCatalogUpload(
  deps: AuthDeps,
  request: RequestInfo,
  email: string | null,
  password: string,
): Promise<SessionUser> {
  const { db, limiter, ipLimiter } = deps;
  const ipKey = request.ipAddress ?? "unknown";
  const actorEmail = email ?? "unknown";
  const failure = (userId: string | null) =>
    recordAudit(db, contextFor(request, { userId, email: actorEmail }), {
      action: AuditAction.LOGIN_FAILED,
      outcome: "failure",
      entityType: "User",
      entityId: userId ?? undefined,
    });

  const accountStarted = email ? limiter.beginAttempt(email) : true;
  const ipStarted = accountStarted && ipLimiter.beginAttempt(ipKey);
  if (!ipStarted) {
    if (email && accountStarted) limiter.finishAttempt(email);
    await failure(null);
    throw errors.rateLimited();
  }

  try {
    const { user, valid } = await verifyCredentials(db, email, password);
    if (!valid || !user || !email) {
      if (email) limiter.recordFailure(email);
      ipLimiter.recordFailure(ipKey);
      await failure(user?.id ?? null);
      throw errors.unauthenticated("Invalid email or password.");
    }

    limiter.reset(email);
    const updated = await db.$transaction(async (tx) => {
      const result = await tx.user.updateMany({
        where: { id: user.id, passwordHash: user.passwordHash, isActive: true },
        data: { lastLoginAt: new Date() },
      });
      if (result.count !== 1) return null;
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      await recordAudit(tx, contextFor(request, { userId: user.id, email: user.email }), {
        action: AuditAction.LOGIN_SUCCESS,
        outcome: "success",
        entityType: "User",
        entityId: user.id,
      });
      return current;
    });
    if (!updated) {
      ipLimiter.recordFailure(ipKey);
      limiter.recordFailure(email);
      await failure(null);
      throw errors.unauthenticated("Invalid email or password.");
    }
    if (updated.mustChangePassword) throw errors.forbidden("You must change your password before continuing.");
    if (updated.role !== "admin") throw errors.forbidden("Admin role required.");
    return toSessionUser(updated);
  } finally {
    if (email) limiter.finishAttempt(email);
    ipLimiter.finishAttempt(ipKey);
  }
}

function idleExpiry(config: AppConfig): Date {
  return new Date(Date.now() + config.sessionIdleMinutes * 60_000);
}

export async function login(
  deps: AuthDeps,
  request: RequestInfo,
  email: string,
  password: string,
): Promise<AuthenticatedSession & { expiresAt: Date }> {
  const { db, config, limiter } = deps;
  const failure = (userId: string | null) =>
    recordAudit(db, contextFor(request, { userId, email }), {
      action: AuditAction.LOGIN_FAILED,
      outcome: "failure",
      entityType: "User",
      entityId: userId ?? undefined,
    });

  if (limiter.isBlocked(email)) {
    await failure(null);
    throw errors.rateLimited();
  }

  const { user, valid } = await verifyCredentials(db, email, password);
  if (!valid || !user) {
    limiter.recordFailure(email);
    await failure(user?.id ?? null);
    throw errors.unauthenticated("Invalid email or password.");
  }

  const expiresAt = idleExpiry(config);
  const actor = { id: user.id, email: user.email };
  const session = await db.$transaction(async (tx) => {
    await tx.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const created = await tx.session.create({ data: { userId: user.id, expiresAt } });
    const updated = await tx.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await recordAudit(tx, contextFor(request, { userId: actor.id, email: actor.email }), {
      action: AuditAction.LOGIN_SUCCESS,
      outcome: "success",
      entityType: "User",
      entityId: user.id,
    });
    return { created, updated };
  });

  limiter.reset(email);
  return {
    sessionId: session.created.id,
    expiresAt,
    user: toSessionUser(session.updated),
  };
}

export async function logout(
  deps: AuthDeps,
  request: RequestInfo,
  auth: AuthenticatedSession,
): Promise<void> {
  const { db } = deps;
  await db.$transaction(async (tx) => {
    await tx.session.deleteMany({ where: { id: auth.sessionId } });
    await recordAudit(tx, contextFor(request, { userId: auth.user.id, email: auth.user.email }), {
      action: AuditAction.LOGOUT,
      outcome: "success",
      entityType: "User",
      entityId: auth.user.id,
    });
  });
}

/**
 * Looks up a session and slides its idle expiry forward.
 * Returns null when the session is unknown, expired, or its user is inactive.
 */
export async function resolveSession(
  deps: AuthDeps,
  sessionId: string,
): Promise<AuthenticatedSession | null> {
  const { db, config } = deps;
  const session = await db.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });
  if (!session || session.expiresAt <= new Date() || !session.user.isActive) {
    return null;
  }

  await db.session.update({
    where: { id: sessionId },
    data: { expiresAt: idleExpiry(config) },
  });
  return { sessionId, user: toSessionUser(session.user) };
}

export function toSessionUser(user: User): SessionUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

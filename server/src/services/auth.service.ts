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

  const user = await db.user.findUnique({ where: { email } });
  const passwordOk = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyAgainstDummyHash(password);

  if (!user || !user.isActive || !passwordOk) {
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

import type { FastifyReply, FastifyRequest } from "fastify";
import { errors } from "../errors.js";
import { resolveSession, type AuthDeps, type AuthenticatedSession } from "../services/auth.service.js";

export const SESSION_COOKIE = "sid";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthenticatedSession;
  }
  interface FastifyContextConfig {
    /** Routes that remain reachable while the user must change their password (SPEC §8.4). */
    allowDuringPasswordChange?: boolean;
  }
}

function readSessionId(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) {
    return null;
  }
  const { valid, value } = request.unsignCookie(raw);
  return valid && value ? value : null;
}

export function createGuards(deps: AuthDeps) {
  async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sessionId = readSessionId(request);
    const auth = sessionId ? await resolveSession(deps, sessionId) : null;
    if (!auth) {
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      throw errors.unauthenticated("Your session is missing or has expired. Please log in again.");
    }
    if (auth.user.mustChangePassword && !request.routeOptions.config.allowDuringPasswordChange) {
      throw errors.forbidden("You must change your password before continuing.");
    }
    request.auth = auth;
  }

  async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireUser(request, reply);
    if (request.auth?.user.role !== "admin") {
      throw errors.forbidden("Admin role required.");
    }
  }

  return { requireUser, requireAdmin };
}

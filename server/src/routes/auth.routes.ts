import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { SESSION_COOKIE } from "../lib/auth-guards.js";
import { emailSchema, parseInput } from "../lib/validation.js";
import type { RequestInfo } from "../services/audit.service.js";
import { login, logout, type AuthDeps } from "../services/auth.service.js";

const loginBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
});

interface Guards {
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const requestInfo = (request: FastifyRequest): RequestInfo => ({
  requestId: request.id,
  ipAddress: request.ip,
});

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps, guards: Guards): void {
  app.post(
    "/auth/login",
    {
      config: {
        rateLimit: { max: deps.config.loginRateLimit, timeWindow: "15 minutes" },
      },
    },
    async (request, reply) => {
      const body = parseInput(loginBodySchema, request.body);
      const result = await login(deps, requestInfo(request), body.email, body.password);

      reply.setCookie(SESSION_COOKIE, result.sessionId, {
        httpOnly: true,
        secure: deps.config.nodeEnv === "production",
        sameSite: "lax",
        path: "/",
        signed: true,
      });
      return { user: result.user };
    },
  );

  app.post("/auth/logout", { config: { allowDuringPasswordChange: true } }, async (request, reply) => {
    await guards.requireUser(request, reply);
    await logout(deps, requestInfo(request), request.auth!);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
  });

  app.get("/auth/me", { config: { allowDuringPasswordChange: true } }, async (request, reply) => {
    await guards.requireUser(request, reply);
    return { user: request.auth!.user };
  });
}

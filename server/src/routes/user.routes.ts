import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../db.js";
import { parseInput, emailSchema, paginationSchema, passwordSchema, uuidSchema } from "../lib/validation.js";
import type { AuditRequestContext } from "../services/audit.service.js";
import {
  changeOwnPassword,
  createUser,
  getUser,
  listUsers,
  resetPassword,
  updateUser,
} from "../services/user.service.js";

interface Guards {
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const roleSchema = z.enum(["admin", "standard"]);
const displayNameSchema = z.string().trim().min(1).max(100);

const createUserSchema = z.object({
  email: emailSchema,
  displayName: displayNameSchema.optional(),
  role: roleSchema,
  password: passwordSchema,
});

const updateUserSchema = z
  .object({
    displayName: displayNameSchema.nullable().optional(),
    role: roleSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "At least one field must be provided.",
  });

const idParamsSchema = z.object({ id: uuidSchema });

const listQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
});

const resetPasswordSchema = z.object({ temporaryPassword: passwordSchema });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

export function registerUserRoutes(
  app: FastifyInstance,
  deps: { db: Database; config: AppConfig },
  guards: Guards,
): void {
  const context = (request: FastifyRequest): AuditRequestContext => ({
    requestId: request.id,
    ipAddress: request.ip,
    actor: {
      userId: request.auth!.user.id,
      email: request.auth!.user.email,
    },
  });
  app.get("/users", { preHandler: guards.requireAdmin }, async (request) => {
    const query = parseInput(listQuerySchema, request.query);
    return listUsers(deps.db, context(request), query);
  });

  app.post("/users", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = parseInput(createUserSchema, request.body);
    const user = await createUser(deps.db, context(request), body);
    return reply.status(201).send({ user });
  });

  app.get("/users/:id", { preHandler: guards.requireAdmin }, async (request) => {
    const { id } = parseInput(idParamsSchema, request.params);
    return { user: await getUser(deps.db, context(request), id) };
  });

  app.patch("/users/:id", { preHandler: guards.requireAdmin }, async (request) => {
    const { id } = parseInput(idParamsSchema, request.params);
    const body = parseInput(updateUserSchema, request.body);
    const user = await updateUser(deps.db, context(request), id, body);
    return { user };
  });

  app.post("/users/:id/reset-password", { preHandler: guards.requireAdmin }, async (request) => {
    const { id } = parseInput(idParamsSchema, request.params);
    const body = parseInput(resetPasswordSchema, request.body);
    const user = await resetPassword(deps.db, context(request), id, body.temporaryPassword);
    return { user };
  });

  app.post(
    "/users/me/password",
    { config: { allowDuringPasswordChange: true }, preHandler: guards.requireUser },
    async (request, reply) => {
      const body = parseInput(changePasswordSchema, request.body);
      await changeOwnPassword(
        deps.db,
        context(request),
        request.auth!.user.id,
        request.auth!.sessionId,
        body.currentPassword,
        body.newPassword,
      );
      return reply.status(204).send();
    },
  );
}

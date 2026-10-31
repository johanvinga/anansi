import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../db.js";
import type { AssetStorage } from "../lib/asset-storage.js";
import { paginationSchema, parseInput, uuidSchema } from "../lib/validation.js";
import type { AuditRequestContext } from "../services/audit.service.js";
import {
  createSupplier,
  deleteSupplier,
  getSupplier,
  listSuppliers,
  updateSupplier,
} from "../services/supplier.service.js";

interface Guards {
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const optionalText = (max: number) => z.string().trim().max(max).nullish();

const categoryInputSchema = z.union([
  z.object({ id: uuidSchema }),
  z.object({ name: z.string().trim().min(1, "Category name is required.").max(100) }),
]);

const supplierBodySchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(200),
  street: optionalText(200),
  city: optionalText(100),
  stateRegion: optionalText(100),
  postalCode: optionalText(20),
  country: optionalText(100),
  categories: z.array(categoryInputSchema).max(50).optional(),
});

const listQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  // Accepts `category=<id>` once or repeated (`category=<id>&category=<id>`).
  category: z
    .preprocess(
      (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]),
      z.array(uuidSchema).max(20),
    )
    .default([]),
});

const idParamsSchema = z.object({ id: uuidSchema });

export function registerSupplierRoutes(
  app: FastifyInstance,
  deps: { db: Database; config: AppConfig; storage: AssetStorage; log: FastifyBaseLogger },
  guards: Guards,
): void {
  const context = (request: FastifyRequest): AuditRequestContext => ({
    requestId: request.id,
    ipAddress: request.ip,
    actor: { userId: request.auth!.user.id, email: request.auth!.user.email },
  });

  app.get("/suppliers", { preHandler: guards.requireUser }, async (request) => {
    const query = parseInput(listQuerySchema, request.query);
    return listSuppliers(deps.db, context(request), {
      q: query.q || undefined,
      categoryIds: query.category,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  app.post("/suppliers", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = parseInput(supplierBodySchema, request.body);
    const supplier = await createSupplier(deps.db, context(request), body);
    return reply.status(201).send({ supplier });
  });

  app.get("/suppliers/:id", { preHandler: guards.requireUser }, async (request) => {
    const { id } = parseInput(idParamsSchema, request.params);
    return { supplier: await getSupplier(deps.db, context(request), id) };
  });

  app.put("/suppliers/:id", { preHandler: guards.requireAdmin }, async (request) => {
    const { id } = parseInput(idParamsSchema, request.params);
    const body = parseInput(supplierBodySchema, request.body);
    return { supplier: await updateSupplier(deps.db, context(request), id, body) };
  });

  app.delete("/suppliers/:id", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params);
    await deleteSupplier(deps.db, deps.storage, deps.log, context(request), id);
    return reply.status(204).send();
  });
}

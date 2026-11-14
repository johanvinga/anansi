import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, errors } from "../errors.js";
import { attachmentDisposition } from "../lib/pdf.js";
import { parseInput, uuidSchema } from "../lib/validation.js";
import type { AuditRequestContext } from "../services/audit.service.js";
import {
  deleteAsset,
  listAssets,
  prepareDownload,
  updateAsset,
  uploadAsset,
  type AssetDeps,
} from "../services/asset.service.js";

interface Guards {
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const optionalTitle = z.string().trim().max(200).nullish();
const optionalDescription = z.string().trim().max(2000).nullish();

const uploadMetadataSchema = z.object({
  title: optionalTitle.transform((value) => value || null),
  description: optionalDescription.transform((value) => value || null),
});

const updateMetadataSchema = z
  .object({
    title: optionalTitle.transform((value) => (value === undefined ? undefined : value || null)),
    description: optionalDescription.transform((value) =>
      value === undefined ? undefined : value || null,
    ),
  })
  .refine((value) => value.title !== undefined || value.description !== undefined, {
    message: "At least one field must be provided.",
  });

const idParamsSchema = z.object({ id: uuidSchema });
const assetParamsSchema = z.object({ assetId: uuidSchema });

export function registerAssetRoutes(app: FastifyInstance, assetDeps: AssetDeps, guards: Guards): void {
  const deps = assetDeps;
  const context = (request: FastifyRequest): AuditRequestContext => ({
    requestId: request.id,
    ipAddress: request.ip,
    actor: { userId: request.auth!.user.id, email: request.auth!.user.email },
  });

  app.get("/suppliers/:id/assets", { preHandler: guards.requireUser }, async (request) => {
    const { id } = parseInput(idParamsSchema, request.params);
    return listAssets(deps.db, context(request), id);
  });

  app.post("/suppliers/:id/assets", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params);

    // Read all parts in one pass so text fields are available regardless of their order.
    const fields: Record<string, string> = {};
    let file: { buffer: Buffer; originalFileName: string; mimeType: string } | null = null;
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "file" || file) {
          part.file.resume();
          continue;
        }
        const buffer = await part.toBuffer();
        if (part.file.truncated) {
          throw new AppError(413, "PAYLOAD_TOO_LARGE", "The file exceeds the maximum upload size.");
        }
        file = { buffer, originalFileName: part.filename, mimeType: part.mimetype };
      } else {
        fields[part.fieldname] = String(part.value ?? "");
      }
    }

    if (!file) {
      throw errors.validation([{ field: "file", message: "A file is required." }]);
    }
    const metadata = parseInput(uploadMetadataSchema, fields);
    const asset = await uploadAsset(assetDeps, context(request), id, file, metadata);
    return reply.status(201).send({ asset });
  });

  app.get("/assets/:assetId/download", { preHandler: guards.requireUser }, async (request, reply) => {
    const { assetId } = parseInput(assetParamsSchema, request.params);
    const download = await prepareDownload(assetDeps, context(request), assetId);

    reply.header("Content-Type", download.mimeType);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Length", String(download.sizeBytes));
    reply.header("Content-Disposition", attachmentDisposition(download.fileName));
    reply.header("Cache-Control", "private, no-store");
    return reply.send(download.stream);
  });

  app.patch("/assets/:assetId", { preHandler: guards.requireAdmin }, async (request) => {
    const { assetId } = parseInput(assetParamsSchema, request.params);
    const body = parseInput(updateMetadataSchema, request.body);
    return { asset: await updateAsset(deps.db, context(request), assetId, body) };
  });

  app.delete("/assets/:assetId", { preHandler: guards.requireAdmin }, async (request, reply) => {
    const { assetId } = parseInput(assetParamsSchema, request.params);
    await deleteAsset(assetDeps, context(request), assetId);
    return reply.status(204).send();
  });
}

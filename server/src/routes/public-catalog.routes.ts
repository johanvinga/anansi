import { TextDecoder } from "node:util";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, errors } from "../errors.js";
import { emailSchema, parseInput } from "../lib/validation.js";
import type { UploadedFile } from "../services/asset.service.js";
import { authenticateCatalogUpload, type AuthDeps } from "../services/auth.service.js";
import { uploadCatalog } from "../services/catalog.service.js";
import type { CatalogDeps } from "../services/catalog.service.js";

const nameSchema = z.string().trim().max(200).transform((value) => value || undefined);
const uploadSchema = z.object({ name: nameSchema.optional() }).strict();
const BYTES_PER_MB = 1024 * 1024;
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

function credentials(header: string | undefined): { email: string | null; password: string } {
  const invalid = { email: null, password: "" };
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header ?? "");
  if (!match?.[1]) return invalid;
  const encoded = match[1];
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) return invalid;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return invalid;
  const email = emailSchema.safeParse(decoded.slice(0, separator));
  const password = decoded.slice(separator + 1);
  if (!email.success || password.length === 0 || password.length > 256) return invalid;
  return { email: email.data, password };
}

export function registerPublicCatalogRoutes(app: FastifyInstance, auth: AuthDeps, assets: CatalogDeps): void {
  app.post("/public/catalogs", async (request, reply) => {
    const { email, password } = credentials(request.headers.authorization);
    const info = { requestId: request.id, ipAddress: request.ip };
    let user;
    try {
      user = await authenticateCatalogUpload(auth, info, email, password);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 401) {
        reply.header("WWW-Authenticate", 'Basic realm="catalog-upload", charset="UTF-8"');
      }
      if (error instanceof AppError && error.statusCode === 429) {
        const accountWait = email ? auth.limiter.retryAfterSeconds(email) : 0;
        const ipWait = auth.ipLimiter.retryAfterSeconds(request.ip);
        reply.header("Retry-After", String(Math.max(accountWait, ipWait, 1)));
      }
      throw error;
    }

    const rawIdempotencyKey = request.headers["idempotency-key"];
    if (rawIdempotencyKey !== undefined && (
      typeof rawIdempotencyKey !== "string" || !idempotencyKeyPattern.test(rawIdempotencyKey)
    )) {
      throw errors.validation([{
        field: "Idempotency-Key",
        message: "Idempotency-Key must be 16-128 characters using letters, numbers, dots, underscores, colons or hyphens.",
      }]);
    }

    const fields: Record<string, string> = {};
    let file: UploadedFile | undefined;
    try {
      for await (const part of request.parts({
        limits: { files: 2, fileSize: auth.config.publicCatalogMaxUploadMb * BYTES_PER_MB },
      })) {
        if (part.type === "file") {
          if (part.fieldname !== "file" || file) {
            part.file.resume();
            throw errors.validation([{ field: "file", message: "Exactly one PDF file is required." }]);
          }
          const buffer = await part.toBuffer();
          if (part.file.truncated) {
            throw new AppError(413, "PAYLOAD_TOO_LARGE", "The file exceeds the maximum upload size.");
          }
          file = { buffer, originalFileName: part.filename, mimeType: part.mimetype };
        } else {
          if (part.fieldname !== "name" || Object.hasOwn(fields, part.fieldname)) {
            throw errors.validation([{ field: part.fieldname, message: "Unsupported or duplicate field." }]);
          }
          fields[part.fieldname] = String(part.value ?? "");
        }
      }
    } catch (error) {
      // Busboy emits these malformed-body errors without a status code.
      if (error instanceof Error && (
        ("code" in error && error.code === "ERR_STREAM_PREMATURE_CLOSE") ||
        [
          "Multipart: Boundary not found",
          "Unexpected end of multipart data",
          "Part terminated early due to unexpected end of multipart data",
          "Preamble terminated early due to unexpected end of multipart data",
        ].includes(error.message)
      )) {
        throw errors.validation([{ field: "file", message: "Malformed multipart request." }]);
      }
      throw error;
    }
    if (!file) throw errors.validation([{ field: "file", message: "A PDF file is required." }]);
    const metadata = parseInput(uploadSchema, fields);
    const result = await uploadCatalog(
      assets,
      { ...info, actor: { userId: user.id, email: user.email } },
      null,
      file,
      { name: metadata.name, version: null },
      rawIdempotencyKey ? { idempotencyKey: rawIdempotencyKey } : undefined,
    );
    return reply.status(result.replayed ? 200 : 201).send({ catalog: result.catalog });
  });
}

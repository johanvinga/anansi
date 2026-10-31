import { z } from "zod";
import { errors } from "../errors.js";

/** Parses input with a Zod schema, converting failures into a 400 VALIDATION_ERROR. */
export function parseInput<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw errors.validation(
      result.error.issues.map((issue) => ({
        field: issue.path.join(".") || undefined,
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address.").max(254));

/** Minimum 12 characters (SPEC §7). bcrypt only uses the first 72 bytes, so longer input is rejected. */
export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters.")
  .max(256)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password must be at most 72 bytes.");

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const uuidSchema = z.uuid("Invalid identifier.");

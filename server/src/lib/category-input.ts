import { z } from "zod";
import { uuidSchema } from "./validation.js";

export const categoryInputSchema = z.union([
  z.object({ id: uuidSchema }),
  z.object({ name: z.string().trim().min(1).max(100), parentId: uuidSchema.nullable().optional() }),
]);

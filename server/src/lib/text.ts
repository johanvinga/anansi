/** Key used for case-insensitive uniqueness (FR-SUP-08, FR-CAT-01). */
export function nameKeyOf(name: string): string {
  return name.trim().toLowerCase();
}

/** Prisma error code for unique constraint violations. Used to map races to 409 CONFLICT. */
export const PRISMA_UNIQUE_VIOLATION = "P2002";

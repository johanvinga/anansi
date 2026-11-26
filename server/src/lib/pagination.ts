import { z } from "zod";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Query parameters for lists that are always paginated. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

/**
 * Query parameters for lists that also feed dropdowns and filters. Without `page` or `pageSize`
 * the full list is returned, as before; with either one the list is paginated.
 */
export const optionalPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

export interface PageRequest {
  page: number;
  pageSize: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Prisma `skip`/`take` for a page. */
export function skipTake({ page, pageSize }: PageRequest): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

/** Resolves an optional pagination query into a page request, or `null` when the full list was asked for. */
export function resolvePage(query: { page?: number | undefined; pageSize?: number | undefined }): PageRequest | null {
  if (query.page === undefined && query.pageSize === undefined) return null;
  return { page: query.page ?? 1, pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE };
}

/** Prisma `skip`/`take` for an optional page request; empty when the full list was asked for. */
export function optionalSkipTake(request: PageRequest | null): { skip?: number; take?: number } {
  return request ? skipTake(request) : {};
}

/** Wraps rows as a paginated page, or as a plain `{ items }` list when the full list was asked for. */
export function listResponse<T>(items: T[], total: number, request: PageRequest | null): { items: T[] } | Page<T> {
  return request ? { items, total, page: request.page, pageSize: request.pageSize } : { items };
}

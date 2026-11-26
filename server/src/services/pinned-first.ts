import type { Database } from "../db.js";
import { PinnedItemType } from "../generated/prisma/client.js";
import type { PageRequest } from "../lib/pagination.js";

export type PinnedListItemType = "catalog" | "supplier" | "product";

export interface IdFilter {
  in?: string[];
  notIn?: string[];
}

export interface PinnedFirstSource<Row extends { id: string }> {
  /** Returns the subset of `ids` that match the list's search and filters. */
  matchingIds(ids: string[]): Promise<string[]>;
  /** Loads rows matching the list's filters, restricted by `id` and sorted in the list's default order. */
  fetch(id: IdFilter, window: { skip?: number; take?: number }): Promise<Row[]>;
}

export interface PinnedFirstResult<Row> {
  rows: Row[];
  pinnedIds: Set<string>;
}

/**
 * Loads one page of a list with the actor's pinned items first (most recently pinned first),
 * followed by the remaining items in the list's default order. Pinned items that do not match
 * the list's filters are left out, and paging applies to the combined ordering.
 */
export async function listPinnedFirst<Row extends { id: string }>(
  db: Database,
  userId: string | null | undefined,
  itemType: PinnedListItemType,
  page: PageRequest | null,
  source: PinnedFirstSource<Row>,
): Promise<PinnedFirstResult<Row>> {
  const pins = userId
    ? await db.pinnedItem.findMany({
        where: { userId, itemType: PinnedItemType[itemType] },
        orderBy: [{ pinnedAt: "desc" }, { id: "desc" }],
        select: { itemId: true },
      })
    : [];
  const matching = pins.length > 0 ? new Set(await source.matchingIds(pins.map((pin) => pin.itemId))) : new Set<string>();
  const pinnedOrder = pins.map((pin) => pin.itemId).filter((id) => matching.has(id));

  const skip = page ? (page.page - 1) * page.pageSize : 0;
  const pinnedSlice = page ? pinnedOrder.slice(skip, skip + page.pageSize) : pinnedOrder;

  const pinnedRows = pinnedSlice.length > 0 ? await source.fetch({ in: pinnedSlice }, {}) : [];
  const byId = new Map(pinnedRows.map((row) => [row.id, row]));
  const orderedPinned = pinnedSlice.flatMap((id) => byId.get(id) ?? []);

  const remaining = page ? page.pageSize - pinnedSlice.length : undefined;
  const rest =
    remaining === undefined || remaining > 0
      ? await source.fetch(
          { notIn: pinnedOrder },
          page && remaining !== undefined ? { skip: Math.max(0, skip - pinnedOrder.length), take: remaining } : {},
        )
      : [];

  return { rows: [...orderedPinned, ...rest], pinnedIds: new Set(pinnedOrder) };
}

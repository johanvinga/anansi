import { useEffect, useState } from "react";
import { useListParams } from "./use-list-params";

export const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function parsePage(raw: string): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

function parsePageSize(raw: string): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= MAX_PAGE_SIZE ? value : DEFAULT_PAGE_SIZE;
}

/**
 * URL-backed state for a paginated, searchable, filterable list: `q`, `page`, `pageSize` and any
 * filter keys live in the query string. Changing the search or a filter returns to page 1, page
 * changes add a history entry, and malformed `page`/`pageSize` values are rewritten to canonical ones.
 * With `persist` false the state stays local, for lists embedded in a page whose URL must not change.
 */
export function usePagedList(persist = true) {
  const params = useListParams(persist);
  const rawPage = params.getString("page");
  const rawPageSize = params.getString("pageSize");
  const page = parsePage(rawPage);
  const pageSize = parsePageSize(rawPageSize);
  const search = params.getString("q");

  const [searchInput, setSearchInput] = useState(search);
  const [syncedSearch, setSyncedSearch] = useState(search);
  if (syncedSearch !== search) {
    setSyncedSearch(search);
    setSearchInput(search);
  }

  const canonicalPage = page > 1 ? String(page) : "";
  const canonicalPageSize = pageSize === DEFAULT_PAGE_SIZE ? "" : String(pageSize);
  const needsNormalizing = rawPage !== canonicalPage || rawPageSize !== canonicalPageSize;
  useEffect(() => {
    if (needsNormalizing) params.setMany({ page: canonicalPage || null, pageSize: canonicalPageSize || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- params is rebuilt every render; only the raw values matter
  }, [needsNormalizing, canonicalPage, canonicalPageSize]);

  const resetPage = { page: null };
  const setSearch = (value: string) => params.setMany({ q: value || null, ...resetPage });

  return {
    page,
    pageSize,
    search,
    searchInput,
    setSearchInput,
    setSearch,
    submitSearch: () => setSearch(searchInput.trim()),
    /** Adds a history entry so Back steps through pages. */
    setPage: (value: number) => params.setString("page", value > 1 ? String(value) : null, { push: true }),
    replacePage: (value: number) => params.setString("page", value > 1 ? String(value) : null),
    getFilter: (key: string) => params.getString(key),
    getFilters: (key: string) => params.getAll(key),
    setFilter: (key: string, value: string | null) => params.setMany({ [key]: value || null, ...resetPage }),
    setFilters: (key: string, values: string[]) => {
      params.setAll(key, values);
      params.setMany(resetPage);
    },
    /** Sets several single-value filters at once and returns to page 1. */
    setFilterValues: (values: Record<string, string | null>) => params.setMany({ ...values, ...resetPage }),
    /** Clears search and every given filter key, returning to page 1. */
    clear: (keys: string[]) => {
      for (const key of keys) params.setAll(key, []);
      params.setMany({ q: null, ...resetPage });
    },
  };
}

export type PagedList = ReturnType<typeof usePagedList>;

/** Moves to the last page when the current page is past the end (e.g. after deleting the last row). */
export function usePageClamp(list: PagedList, total: number | undefined) {
  const { page, pageSize, replacePage } = list;
  useEffect(() => {
    if (total === undefined) return;
    const lastPage = Math.max(1, Math.ceil(total / pageSize));
    if (page > lastPage) replacePage(lastPage);
  }, [total, page, pageSize, replacePage]);
}

import { apiRequest } from "../../api/client";
import type { Page, Supplier } from "../../api/types";

export async function loadCatalogSuppliers(): Promise<Supplier[]> {
  const items: Supplier[] = [];
  let page = 1;
  let total: number;
  do {
    const result = await apiRequest<Page<Supplier>>("GET", `/suppliers?page=${page}&pageSize=100`);
    items.push(...result.items);
    total = result.total;
    if (!result.items.length && items.length < total) throw new Error("Unable to load all suppliers.");
    page++;
  } while (items.length < total);
  return items;
}

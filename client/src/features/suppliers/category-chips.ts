import { localize } from "../../api/translations";
import type { CategoryRef } from "../../api/types";

/** A category chip. Chips without an id are new names that the server creates on save (FR-CAT-06). */
export interface CategoryChip {
  id?: string;
  name: string;
}

export function toCategoryInputs(chips: CategoryChip[]) {
  return chips.map((chip) => (chip.id ? { id: chip.id } : { name: chip.name }));
}

export function chipsFrom(categories: CategoryRef[]): CategoryChip[] {
  return categories.map((category) => ({ id: category.id, name: localize(category.name) }));
}

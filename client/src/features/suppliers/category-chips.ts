import { localize } from "../../api/translations";
import type { CategoryRef } from "../../api/types";

export interface CategoryChip {
  id?: string;
  name: string;
  parentId?: string | null;
}

export function toCategoryInputs(chips: CategoryChip[]) {
  return chips.map((chip) => {
    if (chip.id) return { id: chip.id };
    if (chip.parentId === undefined) throw new Error("Unresolved category suggestion.");
    return { name: chip.name, parentId: chip.parentId };
  });
}

export function chipsFrom(categories: CategoryRef[]): CategoryChip[] {
  return categories.map((category) => ({ id: category.id, name: localize(category.name) }));
}

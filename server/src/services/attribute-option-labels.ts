import { errors } from "../errors.js";
import type { Translated } from "../lib/translations.js";
import type { AttributeDataType } from "./attribute-values.js";

export function normalizeOptionLabels(labels: Translated[], dataType: AttributeDataType): Translated[] {
  const trimmed = labels.map((label) => ({ en: label.en.trim(), fr: label.fr.trim() })).filter((label) => label.en.length > 0);
  if (dataType !== "select") {
    if (trimmed.length > 0) throw errors.validation([{ field: "options", message: "Options are only allowed for select fields." }]);
    return [];
  }
  if (trimmed.length === 0) throw errors.validation([{ field: "options", message: "Select fields need at least one option." }]);
  if (new Set(trimmed.map((label) => label.en.toLowerCase())).size !== trimmed.length) {
    throw errors.validation([{ field: "options", message: "Option labels must be unique." }]);
  }
  return trimmed;
}

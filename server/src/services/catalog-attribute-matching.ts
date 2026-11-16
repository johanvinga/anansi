import type { AttributeDataType } from "./attribute-values.js";

export interface MatchableAttribute {
  id: string;
  name: string;
  aliases?: readonly string[];
  dataType: AttributeDataType;
  unit: string | null;
}

export interface ExtractedAttribute {
  name: string;
  dataType: AttributeDataType;
  unit: string | null;
}

export type AttributeMatch =
  | { kind: "reuse"; attribute: MatchableAttribute }
  | { kind: "review"; candidates: MatchableAttribute[] }
  | { kind: "create" };

export function normalizeAttributeName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en").replace(/\s+/g, " ");
}

function normalizeUnit(value: string | null): string | null {
  return value === null || !value.trim() ? null : value.normalize("NFKC").trim();
}

const dimensions = new Set(["length", "width", "height", "depth", "thickness"]);

function dimensionAlias(name: string): string | null {
  const words = normalizeAttributeName(name).split(" ");
  if (words.length === 1 && dimensions.has(words[0]!)) return words[0]!;
  if (words.length === 2 && (words[0] === "product" || words[0] === "overall") && dimensions.has(words[1]!)) {
    return words[1]!;
  }
  return null;
}

/**
 * Only an unambiguous exact name and compatible definition may be reused without
 * review. Dimension aliases are suggestions because their scope can differ.
 */
export function matchCatalogAttribute(
  extracted: ExtractedAttribute,
  attributes: readonly MatchableAttribute[],
): AttributeMatch {
  const name = normalizeAttributeName(extracted.name);
  const unit = normalizeUnit(extracted.unit);
  const exact = attributes.filter((attribute) =>
    [attribute.name, ...(attribute.aliases ?? [])].some((candidate) => normalizeAttributeName(candidate) === name));
  const compatible = (attribute: MatchableAttribute) =>
    attribute.dataType === extracted.dataType && normalizeUnit(attribute.unit) === unit;

  if (exact.length === 1 && compatible(exact[0]!)) return { kind: "reuse", attribute: exact[0]! };
  if (exact.length > 0) return { kind: "review", candidates: exact };

  const alias = dimensionAlias(name);
  const suggestions = alias === null ? [] : attributes.filter((attribute) => dimensionAlias(attribute.name) === alias);
  if (suggestions.length > 0) return { kind: "review", candidates: suggestions };
  return { kind: "create" };
}

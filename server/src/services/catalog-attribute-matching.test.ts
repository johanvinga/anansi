import { describe, expect, it } from "vitest";
import { matchCatalogAttribute, type MatchableAttribute } from "./catalog-attribute-matching.js";

const length: MatchableAttribute = { id: "length", name: "Length", dataType: "decimal", unit: "mm" };

describe("catalog attribute matching", () => {
  it("reuses an exact, uniquely compatible definition despite case and whitespace", () => {
    expect(matchCatalogAttribute({ name: "  LENGTH  ", dataType: "decimal", unit: "mm" }, [length]))
      .toEqual({ kind: "reuse", attribute: length });
  });

  it("matches translated names and requires review when a translation is ambiguous", () => {
    const translated = { ...length, aliases: ["Longueur"] };
    const sameName = { ...length, id: "other", name: "Longueur" };
    const input = { name: "LONGUEUR", dataType: "decimal" as const, unit: "mm" };
    expect(matchCatalogAttribute(input, [translated])).toEqual({ kind: "reuse", attribute: translated });
    expect(matchCatalogAttribute(input, [translated, sameName])).toEqual({ kind: "review", candidates: [translated, sameName] });
  });

  it.each(["Product Length", "Overall Length"])("suggests %s for review, not automatic reuse", (name) => {
    expect(matchCatalogAttribute({ name, dataType: "decimal", unit: "mm" }, [length]))
      .toEqual({ kind: "review", candidates: [length] });
  });

  it.each([
    { name: "Length", dataType: "text" as const, unit: "mm" },
    { name: "Length", dataType: "decimal" as const, unit: "cm" },
    { name: "Length", dataType: "decimal" as const, unit: null },
  ])("requires review when definitions are incompatible or units unknown", (input) => {
    expect(matchCatalogAttribute(input, [length])).toEqual({ kind: "review", candidates: [length] });
  });

  it("requires review when multiple existing definitions have the same normalized name", () => {
    const conflicting = { ...length, id: "other", dataType: "text" as const };
    expect(matchCatalogAttribute({ name: "length", dataType: "decimal", unit: "mm" }, [length, conflicting]))
      .toEqual({ kind: "review", candidates: [length, conflicting] });
  });

  it.each(["Inside Length", "Maximum Length", "Length of Warranty", "Width"])(
    "does not equate different or uncertain meanings: %s",
    (name) => {
      expect(matchCatalogAttribute({ name, dataType: "decimal", unit: "mm" }, [length])).toEqual({ kind: "create" });
    },
  );
});

import { describe, expect, it } from "vitest";
import { diffFields } from "./audit.service.js";

describe("diffFields (FR-AUD-03)", () => {
  it("returns only the fields that changed, with before and after values", () => {
    expect(diffFields({ name: "A", role: "standard" }, { name: "A", role: "admin" })).toEqual({
      role: { before: "standard", after: "admin" },
    });
  });

  it("treats undefined and null as equal", () => {
    expect(diffFields({ name: undefined }, { name: null })).toBeUndefined();
  });

  it("returns undefined when nothing changed", () => {
    expect(diffFields({ a: 1 }, { a: 1 })).toBeUndefined();
  });
});

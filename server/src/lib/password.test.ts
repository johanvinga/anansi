import { describe, expect, it } from "vitest";
import { passwordSchema } from "./validation.js";
import { hashPassword, verifyPassword } from "./password.js";

describe("password rules (NFR-01, SPEC §7)", () => {
  it("rejects passwords shorter than 12 characters", () => {
    expect(passwordSchema.safeParse("short").success).toBe(false);
  });

  it("rejects passwords longer than the 72-byte bcrypt limit", () => {
    expect(passwordSchema.safeParse("a".repeat(73)).success).toBe(false);
  });

  it("accepts a 12-character password", () => {
    expect(passwordSchema.safeParse("twelve-chars").success).toBe(true);
  });

  it("stores hashes that verify only with the original password", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(hash).not.toContain("correct-horse-battery");
    expect(hash.startsWith("$2")).toBe(true);
    expect(await verifyPassword("correct-horse-battery", hash)).toBe(true);
    expect(await verifyPassword("wrong-horse-battery", hash)).toBe(false);
  });
});

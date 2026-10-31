import { describe, expect, it } from "vitest";
import { attachmentDisposition, hasPdfSignature, sanitizeFileName } from "./pdf.js";
import { createLocalAssetStorage } from "./asset-storage.js";

describe("hasPdfSignature (FR-AST-02)", () => {
  it("accepts data starting with %PDF-", () => {
    expect(hasPdfSignature(Buffer.from("%PDF-1.7 rest"))).toBe(true);
  });

  it("rejects other content and short buffers", () => {
    expect(hasPdfSignature(Buffer.from("<html>"))).toBe(false);
    expect(hasPdfSignature(Buffer.from("%PD"))).toBe(false);
  });
});

describe("sanitizeFileName (FR-AST-04)", () => {
  it("keeps only the base name", () => {
    expect(sanitizeFileName("..\\..\\secret/catalog.pdf")).toBe("catalog.pdf");
  });

  it("replaces unsafe characters and collapses whitespace", () => {
    expect(sanitizeFileName('a:b*c?  "d".pdf')).toBe("a_b_c_ _d_.pdf");
  });

  it("falls back to a default name when nothing usable remains", () => {
    expect(sanitizeFileName("   ")).toBe("document.pdf");
  });

  it("limits the length to 255 characters", () => {
    expect(sanitizeFileName(`${"a".repeat(300)}.pdf`)).toHaveLength(255);
  });
});

describe("attachmentDisposition", () => {
  it("provides an ASCII fallback and a UTF-8 encoded name", () => {
    const header = attachmentDisposition("Préis.pdf");
    expect(header).toContain('filename="Pr_is.pdf"');
    expect(header).toContain("filename*=UTF-8''Pr%C3%A9is.pdf");
  });
});

describe("createLocalAssetStorage", () => {
  it("rejects keys that are not generated UUID file names", async () => {
    const storage = createLocalAssetStorage("./storage/unit-test-unused");
    await expect(storage.save("../evil.pdf", Buffer.from("x"))).rejects.toThrow(/Invalid storage key/);
    await expect(storage.exists("notes.txt")).rejects.toThrow(/Invalid storage key/);
  });
});

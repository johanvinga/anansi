import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { attachmentDisposition, hasPdfSignature, sanitizeFileName } from "./pdf.js";
import { createLocalAssetStorage } from "./asset-storage.js";

describe("hasPdfSignature (FR-CLG-02)", () => {
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
    expect(() => attachmentDisposition(sanitizeFileName(`${"a".repeat(254)}😀.pdf`))).not.toThrow();
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
  it("supports namespaced keys and existing flat keys", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "asset-storage-test-"));
    try {
      const storage = createLocalAssetStorage(directory);
      const id = "123e4567-e89b-42d3-a456-426614174000";
      for (const key of [`assets/${id}`, `catalogs/${id}.pdf`, `${id}.pdf`]) {
        const bytes = Buffer.from(key);
        await storage.save(key, bytes);
        await expect(storage.exists(key)).resolves.toBe(true);
        const chunks: Buffer[] = [];
        for await (const chunk of storage.openRead(key)) chunks.push(chunk as Buffer);
        expect(Buffer.concat(chunks)).toEqual(bytes);
        await expect(storage.save(key, bytes)).rejects.toThrow();
        await storage.remove(key);
        await expect(storage.exists(key)).resolves.toBe(false);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects keys that are not generated UUID file names", async () => {
    const storage = createLocalAssetStorage("./storage/unit-test-unused");
    await expect(storage.save("../evil.pdf", Buffer.from("x"))).rejects.toThrow(/Invalid storage key/);
    await expect(storage.exists("notes.txt")).rejects.toThrow(/Invalid storage key/);
    await expect(storage.exists("assets/../123e4567-e89b-42d3-a456-426614174000.pdf")).rejects.toThrow(/Invalid storage key/);
    await expect(storage.exists("assets\\123e4567-e89b-42d3-a456-426614174000")).rejects.toThrow(/Invalid storage key/);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), upload: vi.fn(), get: vi.fn(), remove: vi.fn(), delay: vi.fn() }));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: mocks.generate };
    files = { upload: mocks.upload, get: mocks.get, delete: mocks.remove };
  },
  createPartFromUri: (uri: string, mimeType: string) => ({ fileData: { fileUri: uri, mimeType } }),
}));

import { createGeminiCatalogAnalyzer, parseGeminiCatalogResponse } from "./catalog-gemini-extraction.js";
import { GeminiRateLimitError } from "./gemini-request-limiter.js";

const candidate = {
  name: "Example", sku: null, description: null, categories: [],
  attributes: [{ name: "Material", value: "Steel", sourcePage: 2 }],
  pageNumbers: [2], excerpt: "Example",
};
const testFetch: typeof fetch = vi.fn();

describe("Gemini whole-catalog analysis", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.delay.mockResolvedValue(undefined);
    mocks.upload.mockResolvedValue({ name: "files/test", uri: "https://example.test/file", state: "ACTIVE" });
    mocks.remove.mockResolvedValue({});
  });

  it("validates source pages and rejects invalid or incomplete results", () => {
    expect(parseGeminiCatalogResponse(JSON.stringify({ products: [candidate] }), "STOP", 2)).toEqual({ products: [candidate] });
    const supplier = { name: "Example supplier", sourcePage: 1, excerpt: "Supplied by Example supplier" };
    expect(parseGeminiCatalogResponse(JSON.stringify({ supplier, products: [] }), "STOP", 2).supplier).toEqual(supplier);
    expect(() => parseGeminiCatalogResponse(JSON.stringify({ supplier: { ...supplier, sourcePage: 3 }, products: [] }), "STOP", 2))
      .toThrow(/out-of-range supplier/);
    expect(() => parseGeminiCatalogResponse(JSON.stringify({ products: [candidate] }), "STOP", 1)).toThrow(/out-of-range/);
    expect(() => parseGeminiCatalogResponse('{"products":[]}', "MAX_TOKENS", 2)).toThrow(/incomplete/);
    expect(() => parseGeminiCatalogResponse("{", "STOP", 2)).toThrow(/invalid JSON/);
    expect(() => parseGeminiCatalogResponse('{"products":[{}]}', "STOP", 2)).toThrow(/invalid catalog response/);
  });

  it("validates catalog name and all bilingual category path metadata", () => {
    const catalog = {
      name: "Structural Fasteners",
      categoryPaths: [
        [
          { en: "Building materials", fr: "Matériaux de construction" },
          { en: "Fasteners", fr: "Fixations" },
        ],
        [
          { en: "Building materials", fr: "Matériaux de construction" },
          { en: "Brackets", fr: "Équerres" },
        ],
      ],
    };
    expect(parseGeminiCatalogResponse(
      JSON.stringify({ catalog, products: [] }),
      "STOP",
      2,
    ).catalog).toEqual(catalog);
  });

  it("uploads the complete PDF and sends one structured request, then deletes the remote file", async () => {
    mocks.generate.mockResolvedValue({ text: JSON.stringify({ products: [candidate] }), candidates: [{ finishReason: "STOP" }] });
    const pdf = Buffer.from("%PDF-1.4 test");
    const result = await createGeminiCatalogAnalyzer("test-key", "test-model", testFetch)(pdf, 2);
    expect(result.products).toEqual([candidate]);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    const blob = mocks.upload.mock.calls[0]![0].file as Blob;
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(pdf);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({
      model: "test-model",
      contents: [expect.objectContaining({ parts: expect.arrayContaining([
        { text: expect.stringContaining("Create a separate product candidate for each distinct supplier SKU") },
        { text: expect.stringContaining("swatches, image captions, and small labels") },
        { text: expect.stringContaining("when the catalog clearly indicates they apply to that variant") },
        { text: expect.stringContaining("a brand or manufacturer alone is not proof") },
        { text: expect.stringContaining("Determine the catalog's clear descriptive title") },
        { text: expect.stringContaining("every distinct product category") },
        { text: expect.stringContaining("catalog.categoryPaths") },
        { text: expect.stringContaining("union of every category named in every") },
        { text: expect.stringContaining("every individual product category") },
        { fileData: { fileUri: "https://example.test/file", mimeType: "application/pdf" } },
      ]) })],
    }));
    expect(mocks.remove).toHaveBeenCalledWith({ name: "files/test" });
  });

  it("waits for the uploaded PDF to become active", async () => {
    mocks.upload.mockResolvedValue({ name: "files/test", state: "PROCESSING" });
    mocks.get.mockResolvedValue({ name: "files/test", uri: "https://example.test/file", state: "ACTIVE" });
    mocks.generate.mockResolvedValue({ text: '{"products":[]}', candidates: [{ finishReason: "STOP" }] });
    await createGeminiCatalogAnalyzer("test-key", "test-model", testFetch)(Buffer.from("pdf"), 1);
    expect(mocks.get).toHaveBeenCalledWith({ name: "files/test" });
    expect(mocks.delay).toHaveBeenCalledWith(2000);
  });

  it("retries 503 twice using the same uploaded file and reports exhaustion", async () => {
    mocks.generate.mockRejectedValue({ status: 503 });
    await expect(createGeminiCatalogAnalyzer("test-key", "test-model", testFetch)(Buffer.from("pdf"), 1))
      .rejects.toThrow("Gemini is temporarily unavailable after retries.");
    expect(mocks.generate).toHaveBeenCalledTimes(3);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.delay.mock.calls).toEqual([[3000], [10000]]);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it("surfaces deletion failure instead of saving results", async () => {
    mocks.generate.mockResolvedValue({ text: '{"products":[]}', candidates: [{ finishReason: "STOP" }] });
    mocks.remove.mockRejectedValue(new Error("secret"));
    await expect(createGeminiCatalogAnalyzer("test-key", "test-model", testFetch)(Buffer.from("pdf"), 1))
      .rejects.toThrow("Could not delete the temporary PDF");
  });

  it("reports Redis limiter failures when deleting the temporary PDF", async () => {
    mocks.generate.mockResolvedValue({ text: '{"products":[]}', candidates: [{ finishReason: "STOP" }] });
    mocks.remove.mockRejectedValue(new GeminiRateLimitError());
    await expect(createGeminiCatalogAnalyzer("test-key", "test-model", testFetch)(Buffer.from("pdf"), 1))
      .rejects.toThrow("Gemini request limiter is unavailable");
  });

  it.each([400, 401, 403, 404, 429])("does not retry HTTP %i", async (status) => {
    mocks.generate.mockRejectedValue({ status });
    await expect(createGeminiCatalogAnalyzer("test-key", "test-model", testFetch)(Buffer.from("pdf"), 1)).rejects.toThrow();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
});

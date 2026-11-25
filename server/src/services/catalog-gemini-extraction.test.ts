import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), upload: vi.fn(), get: vi.fn(), remove: vi.fn(), delay: vi.fn(), ocr: vi.fn(), pdfGetDocument: vi.fn() }));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: mocks.generate };
    files = { upload: mocks.upload, get: mocks.get, delete: mocks.remove };
  },
  createPartFromUri: (uri: string, mimeType: string) => ({ fileData: { fileUri: uri, mimeType } }),
}));
vi.mock("@napi-rs/canvas", () => ({
  createCanvas: (width: number, height: number) => ({
    width,
    height,
    getContext: () => ({}),
    toBuffer: () => Buffer.from("rendered-page"),
  }),
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: mocks.pdfGetDocument,
}));
vi.mock("tesseract.js", () => ({
  createWorker: vi.fn(async () => ({
    recognize: mocks.ocr,
    terminate: vi.fn(async () => undefined),
  })),
}));

import {
  createGeminiCatalogAnalyzer,
  parseGeminiCatalogResponse,
  selectedPromptAPages,
} from "./catalog-gemini-extraction.js";
import { GeminiRateLimitError } from "./gemini-request-limiter.js";

const candidate = {
  name: "Massage Chair",
  tags: [{
    en: "Massage Chair",
    fr: "Fauteuil de massage",
    confidence: 0.99,
    evidence: [{ pageNumber: 2, excerpt: "Massage chair" }],
  }],
  evidence: [{ pageNumber: 2, excerpt: "Massage chair" }],
};
const testFetch: typeof fetch = vi.fn();

describe("Gemini whole-catalog analysis", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.delay.mockResolvedValue(undefined);
    mocks.ocr.mockResolvedValue({ data: { text: "OCR supplier context", confidence: 90 } });
    mocks.pdfGetDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 2,
        getPage: vi.fn(async (_pageNumber: number) => ({
          getViewport: () => ({ width: 600, height: 800 }),
          render: () => ({ promise: Promise.resolve() }),
          cleanup: vi.fn(),
        })),
        destroy: vi.fn(async () => undefined),
      }),
      destroy: vi.fn(async () => undefined),
    });
    mocks.upload.mockResolvedValue({ name: "files/test", uri: "https://example.test/file", state: "ACTIVE" });
    mocks.remove.mockResolvedValue({});
  });

  it("selects the first four and last three pages with overlap deduplicated", () => {
    expect(selectedPromptAPages(215)).toEqual([1, 2, 3, 4, 213, 214, 215]);
    expect(selectedPromptAPages(3)).toEqual([1, 2, 3]);
    expect(selectedPromptAPages(1)).toEqual([1]);
  });

  it("validates source pages and rejects invalid or incomplete results", () => {
    expect(parseGeminiCatalogResponse(JSON.stringify({ products: [candidate] }), "STOP", 2, "tags")).toEqual({ products: [candidate], supplier: null });
    const supplier = {
      name: { value: "Example supplier", pageNumber: 1, excerpt: "Supplied by Example supplier" },
      street: null,
      city: null,
      stateRegion: null,
      postalCode: null,
      country: null,
      website: null,
      email: null,
      phone: null,
      contacts: [],
    };
    expect(parseGeminiCatalogResponse(JSON.stringify({ supplier, products: [] }), "STOP", 2).supplier).toEqual(supplier);
    expect(() => parseGeminiCatalogResponse(JSON.stringify({
      supplier: { ...supplier, name: { value: "Example supplier", pageNumber: 3, excerpt: "Supplied by Example supplier" } },
      products: [],
    }), "STOP", 2))
      .toThrow(/out-of-range supplier/);
    expect(() => parseGeminiCatalogResponse(JSON.stringify({ products: [candidate] }), "STOP", 1, "tags")).toThrow(/out-of-range/);
    expect(() => parseGeminiCatalogResponse('{"products":[]}', "MAX_TOKENS", 2)).toThrow(/incomplete/);
    expect(() => parseGeminiCatalogResponse("{", "STOP", 2)).toThrow(/invalid JSON/);
    expect(() => parseGeminiCatalogResponse('{"products":[{}]}', "STOP", 2, "tags")).toThrow(/invalid catalog response/);
  });

  it("accepts partial Prompt A supplier evidence", () => {
    const result = parseGeminiCatalogResponse(JSON.stringify({
      supplier: {
        name: { value: "Partial Supplier", pageNumber: 215, excerpt: "Partial Supplier" },
      },
      products: [],
    }), "STOP", 215, "supplier");
    expect(result.supplier?.name?.value).toBe("Partial Supplier");
  });

  it("does not validate irrelevant product fallback data for Prompt A", () => {
    const result = parseGeminiCatalogResponse(JSON.stringify({
      catalog: { name: "Roller Shades" },
      supplier: null,
      products: [{ name: "Roller Shades", tags: [], evidence: [{}, {}] }],
    }), "STOP", 25, "supplier");
    expect(result).toEqual({
      catalog: { name: "Roller Shades" },
      supplier: null,
      products: [],
    });
  });

  it("normalizes scalar Prompt A supplier names and contact lists", () => {
    const result = parseGeminiCatalogResponse(JSON.stringify({
      supplier: {
        name: "Scalar Supplier",
        contacts: [{ name: "Jane Doe", role: "Sales" }],
      },
      products: [],
    }), "STOP", 215, "supplier");
    expect(result.supplier?.name?.value).toBe("Scalar Supplier");
  });

  it("normalizes nested or unusable Prompt A supplier evidence", () => {
    const result = parseGeminiCatalogResponse(JSON.stringify({
      supplier: {
        name: { value: { text: "Nested Supplier" } },
        website: { value: { unexpected: true } },
        contacts: [{ name: { value: { label: "Sales contact" } } }, { name: { value: null } }],
      },
      products: [],
    }), "STOP", 2, "supplier");
    expect(result.supplier?.name?.value).toBe("Nested Supplier");
    expect(result.supplier?.website).toBeNull();
    expect(result.supplier?.contacts).toHaveLength(1);
  });

  it("validates catalog name metadata", () => {
    const catalog = {
      name: "Structural Fasteners",
    };
    expect(parseGeminiCatalogResponse(
      JSON.stringify({ catalog, products: [] }),
      "STOP",
      2,
    ).catalog).toEqual(catalog);
  });

  it("renders selected Prompt A pages and sends page images, never uploads the PDF", async () => {
    mocks.pdfGetDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 2,
        getPage: vi.fn(async (_pageNumber: number) => ({
          getViewport: () => ({ width: 600, height: 800 }),
          render: () => ({ promise: Promise.resolve() }),
          cleanup: vi.fn(),
        })),
      }),
      destroy: vi.fn(async () => undefined),
    });
    mocks.generate.mockResolvedValue({
      text: JSON.stringify({
        catalog: { name: null },
        supplier: null,
        products: [{ name: "Roller Shades", tags: [], evidence: [{}, {}] }],
      }),
      candidates: [{ finishReason: "STOP" }],
    });
    const pdf = Buffer.from("%PDF-1.4 test");
    const result = await createGeminiCatalogAnalyzer("test-key", "test-model", testFetch)(pdf, 2);
    expect(result.products).toEqual([]);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.ocr).toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({
      model: "test-model",
      contents: [expect.objectContaining({ parts: expect.arrayContaining([
        { text: expect.stringContaining("Prompt A - Supplier metadata") },
        { text: expect.not.stringContaining("Prompt B - Product tags") },
        { text: expect.stringContaining("OCR hint for physical page 1") },
        { inlineData: { data: expect.any(String), mimeType: "image/png" } },
      ]) })],
    }));
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("waits for the uploaded PDF to become active", async () => {
    mocks.upload.mockResolvedValue({ name: "files/test", state: "PROCESSING" });
    mocks.get.mockResolvedValue({ name: "files/test", uri: "https://example.test/file", state: "ACTIVE" });
    mocks.generate.mockResolvedValue({ text: '{"products":[]}', candidates: [{ finishReason: "STOP" }] });
    await createGeminiCatalogAnalyzer("test-key", "test-model", testFetch)(Buffer.from("pdf"), 1, [], "tags");
    expect(mocks.get).toHaveBeenCalledWith({ name: "files/test" });
    expect(mocks.delay).toHaveBeenCalledWith(2000);
  });

  it("retries 503 twice using the same uploaded file and reports exhaustion", async () => {
    mocks.generate.mockRejectedValue({ status: 503 });
    await expect(createGeminiCatalogAnalyzer("test-key", "test-model", testFetch)(Buffer.from("pdf"), 1, [], "tags"))
      .rejects.toThrow("Gemini is temporarily unavailable");
    expect(mocks.generate).toHaveBeenCalledTimes(5);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.delay.mock.calls).toEqual([[5000], [15000], [30000], [60000]]);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it("surfaces deletion failure instead of saving results", async () => {
    mocks.generate.mockResolvedValue({ text: '{"products":[]}', candidates: [{ finishReason: "STOP" }] });
    mocks.remove.mockRejectedValue(new Error("secret"));
    await expect(createGeminiCatalogAnalyzer("test-key", "test-model", testFetch)(Buffer.from("pdf"), 1, [], "tags"))
      .rejects.toThrow("Could not delete the temporary PDF");
  });

  it("reports Redis limiter failures when deleting the temporary PDF", async () => {
    mocks.generate.mockResolvedValue({ text: '{"products":[]}', candidates: [{ finishReason: "STOP" }] });
    mocks.remove.mockRejectedValue(new GeminiRateLimitError());
    await expect(createGeminiCatalogAnalyzer("test-key", "test-model", testFetch)(Buffer.from("pdf"), 1, [], "tags"))
      .rejects.toThrow("Gemini request limiter is unavailable");
  });

  it.each([400, 401, 403, 404, 429])("does not retry HTTP %i", async (status) => {
    mocks.generate.mockRejectedValue({ status });
    await expect(createGeminiCatalogAnalyzer("test-key", "test-model", testFetch)(Buffer.from("pdf"), 1, [], "tags")).rejects.toThrow();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
});

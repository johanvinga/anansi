import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it, vi } from "vitest";
import { pdfWithImage } from "../test/image-pdf.js";
import { extractCatalogImages } from "./catalog-image-extraction.js";

const product = {
  name: "Chair", sku: "CHAIR", description: null, categories: [], attributes: [],
  pageNumbers: [1], excerpt: "Chair",
};

describe("catalog image extraction", () => {
  it("finds embedded images and crops suggested regions from the rendered page", async () => {
    const task = getDocument({ data: new Uint8Array(pdfWithImage()) });
    try {
      const document = await task.promise;
      const result = await extractCatalogImages(document, [{
        ...product, imageRegions: [{ pageNumber: 1, box: [0, 0, 500, 500] }],
      }]);
      expect(result.warnings).toEqual([]);
      expect(result.images).toHaveLength(2);
      expect(result.images.every((image) => image.pageNumber === 1 && image.buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])))).toBe(true);
    } finally {
      await task.destroy();
    }
  });

  it("reports invalid suggested locations while retaining embedded-image choices", async () => {
    const task = getDocument({ data: new Uint8Array(pdfWithImage()) });
    try {
      const result = await extractCatalogImages(await task.promise, [{
        ...product, imageRegions: [{ pageNumber: 2, box: [0, 0, 2000, 1000] }],
      }]);
      expect(result.warnings).toContain("Some suggested image locations were invalid.");
      expect(result.images).toHaveLength(1);
    } finally {
      await task.destroy();
    }
  });

  it("uses the transformation of a nested PDF form when cropping an embedded image", async () => {
    const task = getDocument({ data: new Uint8Array(pdfWithImage(true)) });
    try {
      const result = await extractCatalogImages(await task.promise, [product]);
      expect(result.warnings).toEqual([]);
      expect(result.images).toHaveLength(1);
      const image = await loadImage(result.images[0]!.buffer);
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixel = context.getImageData(10, Math.floor(image.height / 2), 1, 1).data;
      expect(pixel[0]).toBeGreaterThan(200);
      expect(pixel[1]).toBeLessThan(80);
    } finally {
      await task.destroy();
    }
  });

  it.each([
    ["repeated images", OPS.paintImageXObjectRepeat, ["image", 100, 100, new Float32Array([20, 20])]],
    ["grouped inline images", OPS.paintInlineImageXObjectGroup, [null, [{ transform: [100, 0, 0, 100, 20, 20] }]]],
  ])("finds optimized PDF operators for %s", async (_name, operator, args) => {
    const task = getDocument({ data: new Uint8Array(pdfWithImage()) });
    try {
      const document = await task.promise;
      const page = await document.getPage(1);
      const original = await page.getOperatorList();
      vi.spyOn(page, "getOperatorList").mockResolvedValue({
        ...original, fnArray: [operator], argsArray: [args],
      });
      const result = await extractCatalogImages(document, [product]);
      expect(result.warnings).toEqual([]);
      expect(result.images).toHaveLength(1);
      const image = await loadImage(result.images[0]!.buffer);
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixel = context.getImageData(10, Math.floor(image.height / 2), 1, 1).data;
      expect(pixel[0]).toBeGreaterThan(200);
      expect(pixel[1]).toBeLessThan(80);
    } finally {
      await task.destroy();
    }
  });
});
import { createCanvas, loadImage } from "@napi-rs/canvas";

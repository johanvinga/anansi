import { createCanvas } from "@napi-rs/canvas";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { z } from "zod";
import type { GeminiCatalogResult } from "./catalog-gemini-extraction.js";

type Matrix = [number, number, number, number, number, number];
type Box = [number, number, number, number];
export interface ExtractedCatalogImage {
  pageNumber: number;
  buffer: Buffer;
}

const regionSchema = z.object({
  pageNumber: z.number().int().positive(),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});
const MAX_PAGES = 50;
const MAX_IMAGES = 100;
const MAX_PER_PAGE = 20;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function readMatrix(value: unknown): Matrix | undefined {
  if ((!Array.isArray(value) && !(value instanceof Float32Array)) || value.length !== 6 ||
    !value.every((item: unknown) => typeof item === "number" && Number.isFinite(item))) return undefined;
  return [value[0], value[1], value[2], value[3], value[4], value[5]];
}

async function embeddedBoxes(page: PDFPageProxy): Promise<Box[]> {
  const viewport = page.getViewport({ scale: 1 });
  const operators = await page.getOperatorList();
  const boxes: Box[] = [];
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const addBox = (transform: Matrix) => {
    const points = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) =>
      viewport.convertToViewportPoint(transform[0] * x! + transform[2] * y! + transform[4], transform[1] * x! + transform[3] * y! + transform[5]));
    const xs = points.map((point) => point[0]! / viewport.width);
    const ys = points.map((point) => point[1]! / viewport.height);
    boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  };
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i];
    const args: unknown = operators.argsArray[i];
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      stack.push([...matrix]);
      if (op === OPS.paintFormXObjectBegin && Array.isArray(args)) {
        const transform = readMatrix(args[0]);
        if (transform) matrix = multiply(matrix, transform);
      }
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) matrix = stack.pop() ?? matrix;
    else if (op === OPS.transform) {
      const transform = readMatrix(args);
      if (transform) matrix = multiply(matrix, transform);
    } else if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject) {
      addBox(matrix);
    } else if (op === OPS.paintImageXObjectRepeat && Array.isArray(args)) {
      const [, scaleX, scaleY, positions] = args;
      if (typeof scaleX === "number" && Number.isFinite(scaleX) && typeof scaleY === "number" &&
        Number.isFinite(scaleY) && (Array.isArray(positions) || positions instanceof Float32Array)) {
        for (let j = 0; j + 1 < positions.length && boxes.length < MAX_PER_PAGE * 3; j += 2) {
          const transform = readMatrix([scaleX, 0, 0, scaleY, positions[j], positions[j + 1]]);
          if (transform) addBox(multiply(matrix, transform));
        }
      }
    } else if (op === OPS.paintInlineImageXObjectGroup && Array.isArray(args) && Array.isArray(args[1])) {
      for (const entry of args[1]) {
        if (boxes.length >= MAX_PER_PAGE * 3) break;
        if (typeof entry !== "object" || entry === null || !("transform" in entry)) continue;
        const transform = readMatrix(entry.transform);
        if (transform) addBox(multiply(matrix, transform));
      }
    }
    if (boxes.length >= MAX_PER_PAGE * 3) break;
  }
  return boxes;
}

function validBox(box: Box): boolean {
  return box.every(Number.isFinite) && box[0] >= 0 && box[1] >= 0 && box[2] <= 1 && box[3] <= 1 &&
    box[2] > box[0] && box[3] > box[1];
}

export async function extractCatalogImages(
  document: PDFDocumentProxy, products: GeminiCatalogResult["products"],
): Promise<{ images: ExtractedCatalogImage[]; warnings: string[] }> {
  const pages = new Map<number, Box[]>();
  const warnings = new Set<string>();
  for (const product of products) {
    for (const page of product.pageNumbers) if (!pages.has(page)) pages.set(page, []);
    if (product.imageRegions === undefined) continue;
    if (!Array.isArray(product.imageRegions)) {
      warnings.add("Some suggested image locations were invalid.");
      continue;
    }
    for (const region of product.imageRegions.slice(0, MAX_PER_PAGE)) {
      const parsed = regionSchema.safeParse(region);
      if (!parsed.success || !product.pageNumbers.includes(parsed.data.pageNumber)) {
        warnings.add("Some suggested image locations were invalid.");
        continue;
      }
      const box = parsed.data.box.map((coordinate) => coordinate / 1000) as Box;
      if (!validBox(box)) {
        warnings.add("Some suggested image locations were invalid.");
        continue;
      }
      pages.get(parsed.data.pageNumber)!.push(box);
    }
    if (product.imageRegions.length > MAX_PER_PAGE) warnings.add("Some image suggestions were omitted because a limit was reached.");
  }
  const images: ExtractedCatalogImage[] = [];
  let totalBytes = 0;
  const pageNumbers = [...pages.keys()].sort((a, b) => a - b);
  if (pageNumbers.length > MAX_PAGES) warnings.add("Some pages were omitted because the image extraction limit was reached.");
  for (const pageNumber of pageNumbers.slice(0, MAX_PAGES)) {
    if (images.length >= MAX_IMAGES) {
      warnings.add("Some image suggestions were omitted because a limit was reached.");
      break;
    }
    let page: PDFPageProxy | undefined;
    try {
      page = await document.getPage(pageNumber);
      const boxes = [...pages.get(pageNumber)!, ...(await embeddedBoxes(page))];
      const distinct = new Map<string, Box>();
      for (const box of boxes) {
        if (!validBox(box)) continue;
        const key = box.map((value) => Math.round(value * 100)).join(":");
        distinct.set(key, box);
      }
      if (distinct.size > MAX_PER_PAGE) warnings.add("Some image suggestions were omitted because a limit was reached.");
      if (!distinct.size) continue;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, 2048 / Math.max(base.width, base.height)) });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
      for (const box of [...distinct.values()].slice(0, MAX_PER_PAGE)) {
        if (images.length >= MAX_IMAGES) {
          warnings.add("Some image suggestions were omitted because a limit was reached.");
          break;
        }
        const x = Math.floor(box[0] * canvas.width);
        const y = Math.floor(box[1] * canvas.height);
        const width = Math.min(canvas.width - x, Math.ceil(box[2] * canvas.width) - x);
        const height = Math.min(canvas.height - y, Math.ceil(box[3] * canvas.height) - y);
        if (width < 24 || height < 24) continue;
        const crop = createCanvas(width, height);
        crop.getContext("2d").drawImage(canvas, x, y, width, height, 0, 0, width, height);
        const buffer = crop.toBuffer("image/jpeg", 85);
        if (buffer.length > MAX_IMAGE_BYTES || totalBytes + buffer.length > MAX_TOTAL_BYTES) {
          warnings.add("Some image suggestions were omitted because a size limit was reached.");
        } else {
          images.push({ pageNumber, buffer });
          totalBytes += buffer.length;
        }
        crop.width = 0;
        crop.height = 0;
      }
      canvas.width = 0;
      canvas.height = 0;
    } catch {
      warnings.add(`Images could not be extracted from page ${pageNumber}.`);
    } finally {
      page?.cleanup();
    }
  }
  return { images, warnings: [...warnings] };
}

import { createCanvas } from "@napi-rs/canvas";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createWorker, type Worker as OcrWorker } from "tesseract.js";
import type { Database } from "../db.js";
import type { CatalogExtractionJob, Prisma } from "../generated/prisma/client.js";
import type { AssetStorage } from "../lib/asset-storage.js";

export interface ExtractedAttribute {
  name: string;
  value: string;
  confidence: number | null;
  sourcePage: number;
}

export interface ExtractedProductCandidate {
  sku: string | null;
  name: string;
  description: string | null;
  categories: string[];
  attributes: ExtractedAttribute[];
  source: { pageNumbers: number[]; excerpt: string };
  confidence: { overall: number | null; name: number | null; sku: number | null; attributes: number | null };
  validationStatus: "pending";
}

export interface CatalogExtractionResults {
  products: ExtractedProductCandidate[];
  suggestedAttributeFields: { name: string; type: "text" }[];
  pages: { pageNumber: number; textSource: "pdf" | "ocr"; confidence: number | null }[];
}

interface PageText {
  pageNumber: number;
  text: string;
  textSource: "pdf" | "ocr";
  confidence: number | null;
}

interface OcrEngine {
  recognize(image: Buffer): Promise<{ data: { text: string; confidence: number } }>;
}

interface ExtractionDependencies {
  db: Database;
  storage: AssetStorage;
  maxPages: number;
}

interface ProgressUpdate {
  stage: string;
  progress: number;
  currentPage: number;
  totalPages: number;
  productsIdentified?: number;
}

function textFromPdfItems(items: unknown[]): string {
  return items
    .filter((item): item is { str: string; hasEOL?: boolean } =>
      typeof item === "object" && item !== null && "str" in item && typeof item.str === "string",
    )
    .map((item) => `${item.str}${item.hasEOL ? "\n" : " "}`)
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SKU_PREFIX = /^(?:sku|mpn|model|modèle|modele|ref(?:erence)?|réf(?:érence)?|item(?:\s*(?:no\.?|number))?|article|code|part(?:\s*(?:no|number))?)\s*[:#-]\s*(\S+)/iu;
const PRODUCT_NAME_LABEL = /^(?:(?:product\s+)?name|nom(?:\s+du\s+produit)?|désignation|designation)\s*:\s*(.+)$/iu;
const ATTRIBUTE_LABELS = [
  "diameter of hinge cup",
  "opening degree",
  "door thinckness",
  "door thickness",
  "quality grade",
  "product features",
  "materials",
  "material",
  "finish",
  "optional plates",
];
const ATTRIBUTE_LABEL_PATTERN = new RegExp(
  `\\b(${ATTRIBUTE_LABELS.map((label) => label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")).join("|")})\\s*:`,
  "giu",
);

function cleanOcrLine(line: string): string {
  return line.replace(/^[\s@®©•·●▪◦]+/u, "").replace(/\s+/g, " ").trim();
}

function looksLikeSku(line: string): boolean {
  const value = cleanOcrLine(line);
  if (!value || value.length > 50) return false;
  const labeled = SKU_PREFIX.exec(value);
  const candidate = labeled?.[1] ?? value;
  return (
    /^[A-Z0-9][A-Z0-9._/-]{2,39}$/i.test(candidate) &&
    /[A-Z]/i.test(candidate) &&
    /\d/.test(candidate)
  );
}

function likelyProductTitle(line: string): boolean {
  const value = cleanOcrLine(line).replace(/\s+[A-Z]?[a-z]{1,2}$/u, "").trim();
  const letters = value.match(/[A-Za-z]/g) ?? [];
  const uppercase = value.match(/[A-Z]/g) ?? [];
  return value.length >= 5 && value.length <= 160 && !value.includes(":") &&
    letters.length >= 4 && uppercase.length / letters.length >= 0.65;
}

function findPageCategory(lines: string[], titleIndex: number): string | null {
  for (const line of lines.slice(0, titleIndex)) {
    const matches = line.match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,2}\b/gu) ?? [];
    const match = matches.find((phrase) => !/^(?:Monsoon|Make Trust|Trust As)$/iu.test(phrase));
    if (match) return match.trim();
  }
  return null;
}

function extractedAttributes(lines: string[], page: PageText): ExtractedAttribute[] {
  const attributes: ExtractedAttribute[] = [];
  const knownLabels = new Set(ATTRIBUTE_LABELS);
  for (const line of lines) {
    const matches = [...line.matchAll(ATTRIBUTE_LABEL_PATTERN)];
    if (matches.length === 0) {
      const labelValue = /^([^:]{1,60}):\s*(.{1,300})$/.exec(line);
      if (!labelValue) continue;
      const name = labelValue[1]!.trim();
      if (/^(?:(?:product\s+)?name|nom(?:\s+du\s+produit)?|désignation|designation|sku|mpn|model|modèle|modele|reference|référence)$/iu.test(name)) {
        continue;
      }
      attributes.push({
        name,
        value: labelValue[2]!.trim(),
        confidence: page.confidence ?? 0.5,
        sourcePage: page.pageNumber,
      });
      continue;
    }

    for (const [index, match] of matches.entries()) {
      const label = match[1]!.toLowerCase().replace(/\s+/g, " ");
      if (!knownLabels.has(label) || label === "optional plates") continue;
      const start = match.index! + match[0].length;
      const end = matches[index + 1]?.index ?? line.length;
      let value = line.slice(start, end).trim().replace(/^[\s:;,.-]+|[\s;]+$/gu, "");
      if (label === "material" || label === "materials") {
        value = value.replace(/^lron$/iu, "Iron");
      } else if (label === "diameter of hinge cup") {
        const dimension = /(?:[ØΦ∅]|\$p|[$p])?\s*\d+(?:\.\d+)?\s*(?:mm|cm|in(?:ch)?|°)?/iu.exec(value);
        if (dimension) value = dimension[0].replace(/^\$p/iu, "Ø").trim();
      } else if (label === "opening degree") {
        const degrees = /\d+(?:\.\d+)?\s*°?/u.exec(value);
        if (degrees) value = degrees[0].trim();
      } else if (label === "door thickness" || label === "door thinckness") {
        const thickness = /\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?\s*(?:mm|cm|in(?:ch)?)?/iu.exec(value);
        if (thickness) value = thickness[0].replace(/\s+/g, "");
      } else {
        value = value.replace(/\s+(?:\d+\s*)?[>@|/]+.*$/u, "").replace(/\s+[A-Z]{1,2}$/u, "").trim();
        if (label === "product features") value = value.replace(/\s+Fr$/iu, "").trim();
      }
      if (!value) continue;
      const name = label === "materials" ? "Material" : label === "door thinckness" ? "Door thickness" :
        label.replace(/\b\w/gu, (letter) => letter.toUpperCase());
      attributes.push({
        name,
        value,
        confidence: page.confidence ?? 0.5,
        sourcePage: page.pageNumber,
      });
    }
  }
  return attributes;
}

function extractCandidates(pages: PageText[]): ExtractedProductCandidate[] {
  const candidates: ExtractedProductCandidate[] = [];

  for (const page of pages) {
    const lines = page.text.split(/\r?\n/).map(cleanOcrLine).filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      const current = lines[index]!;
      const skuLine = looksLikeSku(current);
      const explicitName = PRODUCT_NAME_LABEL.exec(current);
      if (!skuLine && !explicitName) continue;

      const skuMatch = SKU_PREFIX.exec(current);
      const sku = skuLine ? (skuMatch?.[1] ?? current) : null;
      const precedingTitleIndex = skuLine
        ? lines.findLastIndex((line, lineIndex) => lineIndex < index && index - lineIndex <= 5 && likelyProductTitle(line))
        : -1;
      const boundary = lines.findIndex((line, lineIndex) => lineIndex > index && looksLikeSku(line));
      const end = boundary < 0 ? Math.min(lines.length, index + 14) : boundary;
      const segmentStart = skuLine ? index + 1 : index;
      const segment = lines.slice(segmentStart, end);
      const name = explicitName?.[1]?.trim() ||
        (precedingTitleIndex >= 0 ? lines[precedingTitleIndex]!.replace(/\s+[A-Z]?[a-z]{1,2}$/u, "").trim() : "") ||
        segment.find((line) => !/^[^:]{1,60}:\s*\S+/.test(line)) || "";
      if (!name || looksLikeSku(name)) continue;

      const attributes = extractedAttributes(segment, page);

      const excerpt = lines.slice(Math.max(0, index - 1), end).join("\n").slice(0, 4_000);
      candidates.push({
        sku,
        name,
        description: null,
        categories: precedingTitleIndex >= 0 ? [findPageCategory(lines, precedingTitleIndex)].filter((value): value is string => value !== null) : [],
        attributes,
        source: { pageNumbers: [page.pageNumber], excerpt },
        confidence: {
          overall: page.confidence,
          name: page.confidence,
          sku: sku ? page.confidence : null,
          attributes: attributes.length > 0 ? page.confidence : null,
        },
        validationStatus: "pending",
      });
    }
  }

  return candidates;
}

async function readStream(storage: AssetStorage, key: string, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of storage.openRead(key)) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += data.byteLength;
    if (total > maxBytes) throw new Error("Catalog PDF exceeds the extraction size limit.");
    chunks.push(data);
  }
  return Buffer.concat(chunks, total);
}

async function updateProgress(
  db: Database,
  job: CatalogExtractionJob,
  update: ProgressUpdate,
): Promise<void> {
  await db.catalogExtractionJob.update({
    where: { id: job.id },
    data: {
      stage: update.stage,
      progress: update.progress,
      currentPage: update.currentPage,
      totalPages: update.totalPages,
      productsIdentified: update.productsIdentified,
    },
  });
}

export async function processCatalogExtraction(
  extractionJobId: string,
  dependencies: ExtractionDependencies,
  ocrWorker: () => Promise<OcrEngine>,
): Promise<void> {
  const job = await dependencies.db.catalogExtractionJob.findUnique({
    where: { id: extractionJobId },
    include: { catalog: true },
  });
  if (!job) return;

  await dependencies.db.$transaction([
    dependencies.db.catalogExtractionJob.update({
      where: { id: job.id },
      data: {
        status: "processing",
        stage: "analyzing",
        progress: 1,
        currentPage: 0,
        startedAt: new Date(),
        processingError: null,
      },
    }),
    dependencies.db.catalog.update({
      where: { id: job.catalogId },
      data: { analysisStatus: "processing" },
    }),
  ]);

  let document: PDFDocumentProxy | undefined;
  let loadingTask: ReturnType<typeof getDocument> | undefined;
  try {
    const buffer = await readStream(dependencies.storage, job.catalog.storageKey, 50 * 1024 * 1024);
    loadingTask = getDocument({ data: new Uint8Array(buffer) });
    document = await loadingTask.promise;
    const totalPages = document.numPages;
    if (totalPages > dependencies.maxPages) {
      throw new Error(`Catalog has ${totalPages} pages; the configured limit is ${dependencies.maxPages}.`);
    }

    await updateProgress(dependencies.db, job, {
      stage: "extracting_text",
      progress: 2,
      currentPage: 0,
      totalPages,
    });

    const pages: PageText[] = [];
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const nativeText = textFromPdfItems(content.items);
      let text = nativeText;
      let textSource: PageText["textSource"] = "pdf";
      let confidence: number | null = null;

      if (nativeText.replace(/\s/g, "").length < 80) {
        await updateProgress(dependencies.db, job, {
          stage: "running_ocr",
          progress: 2 + Math.floor(((pageNumber - 1) / totalPages) * 70),
          currentPage: pageNumber - 1,
          totalPages,
        });
        const baseViewport = page.getViewport({ scale: 1 });
        const maxPixels = 12_000_000;
        const scale = Math.min(
          3,
          Math.sqrt(maxPixels / (baseViewport.width * baseViewport.height)),
        );
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext("2d");
        await page.render({
          canvas: canvas as never,
          canvasContext: context as never,
          viewport,
        }).promise;
        const recognized = await (await ocrWorker()).recognize(canvas.toBuffer("image/png"));
        text = recognized.data.text.trim();
        confidence = recognized.data.confidence / 100;
        textSource = "ocr";
        canvas.width = 0;
        canvas.height = 0;
      }

      pages.push({ pageNumber, text, textSource, confidence });
      page.cleanup();
      await updateProgress(dependencies.db, job, {
        stage: "extracting_text",
        progress: 2 + Math.floor((pageNumber / totalPages) * 70),
        currentPage: pageNumber,
        totalPages,
      });
    }

    await updateProgress(dependencies.db, job, {
      stage: "identifying_products",
      progress: 75,
      currentPage: totalPages,
      totalPages,
    });
    const products = extractCandidates(pages);
    const attributeNames = [...new Set(products.flatMap((product) => product.attributes.map((attribute) => attribute.name)))];
    const results = {
      products: products.map((product) => ({
        sku: product.sku,
        name: product.name,
        description: product.description,
        categories: product.categories,
        attributes: product.attributes.map((attribute) => ({
          name: attribute.name,
          value: attribute.value,
          confidence: attribute.confidence,
          sourcePage: attribute.sourcePage,
        })),
        source: { pageNumbers: product.source.pageNumbers, excerpt: product.source.excerpt },
        confidence: {
          overall: product.confidence.overall,
          name: product.confidence.name,
          sku: product.confidence.sku,
          attributes: product.confidence.attributes,
        },
        validationStatus: product.validationStatus,
      })),
      suggestedAttributeFields: attributeNames.map((name) => ({ name, type: "text" })),
      pages: pages.map(({ pageNumber, textSource, confidence }) => ({ pageNumber, textSource, confidence })),
    } satisfies Prisma.InputJsonObject;

    await dependencies.db.$transaction([
      dependencies.db.catalogExtractionJob.update({
        where: { id: job.id },
        data: {
          status: "processed",
          stage: "completed",
          progress: 100,
          currentPage: totalPages,
          totalPages,
          productsIdentified: products.length,
          results,
          processingError: null,
          completedAt: new Date(),
        },
      }),
      dependencies.db.catalog.update({
        where: { id: job.catalogId },
        data: { analysisStatus: "processed" },
      }),
    ]);
  } finally {
    await loadingTask?.destroy();
  }
}

export interface OcrWorkerFactory {
  get(): Promise<OcrWorker>;
  close(): Promise<void>;
}

export function createOcrWorker(languages: string): OcrWorkerFactory {
  let workerPromise: Promise<OcrWorker> | undefined;
  return {
    get() {
      workerPromise ??= createWorker(languages);
      return workerPromise;
    },
    async close() {
      if (workerPromise) await (await workerPromise).terminate();
    },
  };
}

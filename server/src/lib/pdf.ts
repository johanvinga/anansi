export const PDF_MIME_TYPE = "application/pdf";

const PDF_SIGNATURE = "%PDF-";

/** Checks the file's magic bytes, not just the client-supplied MIME type (FR-AST-02). */
export function hasPdfSignature(data: Buffer): boolean {
  return data.subarray(0, PDF_SIGNATURE.length).toString("latin1") === PDF_SIGNATURE;
}

/** Keeps the base name only and removes characters that are unsafe in file names and headers. */
export function sanitizeFileName(raw: string): string {
  const baseName = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = baseName
    // oxlint-disable-next-line no-control-regex -- stripping control characters is intentional
    .replace(/[\u0000-\u001f\u007f"<>:|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);
  return cleaned.length > 0 ? cleaned : "document.pdf";
}

/** Builds a Content-Disposition header that is safe for ASCII and UTF-8 file names. */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

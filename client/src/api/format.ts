/** Formats a decimal string in the product's own currency using the browser locale (FR-PRD-10, NFR-15). */
export function formatMoney(amount: string, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}

export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

export function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString();
}

/** Uploaded-at timestamps show date and time (catalogs table). */
export function formatDateTime(isoDate: string): string {
  return new Date(isoDate).toLocaleString();
}

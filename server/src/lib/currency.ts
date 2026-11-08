/** ISO 4217 codes known to the runtime's ICU data (FR-PRD-02, SPEC §7). */
export const CURRENCY_CODES: readonly string[] = Intl.supportedValuesOf("currency");

const codes = new Set(CURRENCY_CODES);

export function isCurrencyCode(value: string): boolean {
  return codes.has(value);
}

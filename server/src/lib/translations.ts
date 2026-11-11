import { z } from "zod";

/** A translatable value stored as one field per locale (FR-I18N-01). */
export interface Translated {
  en: string;
  fr: string;
}

/** An optional translatable text (FR-PRD-10). */
export interface TranslatedText {
  en: string | null;
  fr: string | null;
}

const requiredText = (max: number) => z.string().trim().min(1, "Name is required.").max(max);

/**
 * Body shape `{ en, fr? }` for create requests. A missing `fr` copies `en` (FR-I18N-02),
 * so the French value is never empty.
 */
export function translatedNameInput(max: number) {
  return z
    .object({ en: requiredText(max), fr: requiredText(max).optional() })
    .transform((value): Translated => ({ en: value.en, fr: value.fr ?? value.en }));
}

/** Body shape `{ en, fr }` for rename requests: both locales are required (FR-I18N-04). */
export function translatedNameUpdate(max: number) {
  return z.object({ en: requiredText(max), fr: requiredText(max) });
}

/** Optional description in both locales (FR-PRD-10). Empty strings are stored as null. */
export const translatedTextInput = z
  .object({
    en: z.string().trim().max(2000).nullish(),
    fr: z.string().trim().max(2000).nullish(),
  })
  .nullish()
  .transform((value): TranslatedText => ({ en: value?.en || null, fr: value?.fr || null }));

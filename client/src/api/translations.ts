import i18next from "i18next";
import type { Translated } from "./types";

/** Picks the value for the active UI language, falling back to English (FR-I18N-05). */
export function localize(value: Translated | null | undefined): string {
  if (!value) return "";
  const language = i18next.language?.startsWith("fr") ? "fr" : "en";
  return value[language] || value.en;
}

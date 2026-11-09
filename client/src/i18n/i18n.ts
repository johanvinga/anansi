import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import fr from "./locales/fr.json";

export const SUPPORTED_LANGUAGES = ["en", "fr"] as const;
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_STORAGE_KEY = "app-language";

/** Picks the first browser language we support, falling back to English (NFR-15). */
export function detectBrowserLanguage(): AppLanguage {
  for (const candidate of navigator.languages) {
    const short = candidate.slice(0, 2).toLowerCase();
    if ((SUPPORTED_LANGUAGES as readonly string[]).includes(short)) {
      return short as AppLanguage;
    }
  }
  return "en";
}

void i18next.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    fr: { translation: fr },
  },
  lng: localStorage.getItem(LANGUAGE_STORAGE_KEY) ?? detectBrowserLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});

export function setAppLanguage(language: AppLanguage): void {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  void i18next.changeLanguage(language);
  document.documentElement.lang = language;
}

document.documentElement.lang = i18next.language;

export default i18next;

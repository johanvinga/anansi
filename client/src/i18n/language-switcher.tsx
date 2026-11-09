import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AppLanguage } from "./i18n";
import { setAppLanguage, SUPPORTED_LANGUAGES } from "./i18n";

const LANGUAGE_NAMES: Record<AppLanguage, string> = {
  en: "English",
  fr: "Français",
};

interface LanguageSwitcherProps {
  className?: string;
}

/** Header control that switches the UI language and persists the choice (localStorage). */
export function LanguageSwitcher({ className }: LanguageSwitcherProps) {
  const { i18n, t } = useTranslation();
  const current = (SUPPORTED_LANGUAGES as readonly string[]).includes(i18n.language)
    ? (i18n.language as AppLanguage)
    : "en";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={className} aria-label={t("language.switch")}>
          <Languages />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SUPPORTED_LANGUAGES.map((language) => (
          <DropdownMenuItem
            key={language}
            onClick={() => setAppLanguage(language)}
            className={language === current ? "font-medium" : undefined}
          >
            {LANGUAGE_NAMES[language]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Komori's interface languages, as saved in the appearance record and set on `<html lang>`. */
export const interfaceLanguages = ["en", "ja", "zh-CN", "ko", "pt-BR"] as const;

export type InterfaceLanguage = (typeof interfaceLanguages)[number];

export const defaultInterfaceLanguage: InterfaceLanguage = "en";

export const isInterfaceLanguage = (value: unknown): value is InterfaceLanguage =>
  interfaceLanguages.some((language) => language === value);

/** Each language named in itself, as the language choice lists them. */
export const interfaceLanguageNames: Record<InterfaceLanguage, string> = {
  en: "English",
  ja: "日本語",
  "zh-CN": "简体中文",
  ko: "한국어",
  "pt-BR": "Português (Brasil)",
};

/** The locale used for numbers, dates and sorting: English formats as United States English. */
export const formattingLocale = (language: InterfaceLanguage) =>
  language === "en" ? "en-US" : language;

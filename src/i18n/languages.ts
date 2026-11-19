/** Komori's interface languages, as saved in the appearance record and set on `<html lang>`. */
export const interfaceLanguages = [
  "en",
  "ja",
  "zh-CN",
  "zh-TW",
  "ko",
  "de",
  "es",
  "fr",
  "it",
  "pt-BR",
  "ru",
  "nl",
  "pl",
  "sv",
  "nb",
  "da",
  "fi",
  "el",
  "tr",
  "ar",
  "hi",
  "th",
  "vi",
  "id",
] as const;

export type InterfaceLanguage = (typeof interfaceLanguages)[number];

export const defaultInterfaceLanguage: InterfaceLanguage = "en";

export const isInterfaceLanguage = (value: unknown): value is InterfaceLanguage =>
  interfaceLanguages.some((language) => language === value);

/** Each language named in itself, as the language choice lists them. */
export const interfaceLanguageNames: Record<InterfaceLanguage, string> = {
  en: "English",
  ja: "日本語",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  ko: "한국어",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  it: "Italiano",
  "pt-BR": "Português (Brasil)",
  ru: "Русский",
  nl: "Nederlands",
  pl: "Polski",
  sv: "Svenska",
  nb: "Norsk",
  da: "Dansk",
  fi: "Suomi",
  el: "Ελληνικά",
  tr: "Türkçe",
  ar: "العربية",
  hi: "हिन्दी",
  th: "ไทย",
  vi: "Tiếng Việt",
  id: "Bahasa Indonesia",
};

/**
 * The locale used for numbers, dates and sorting: English formats as United States English and
 * Arabic writes Western digits.
 */
export const formattingLocale = (language: InterfaceLanguage) =>
  language === "en" ? "en-US" : language === "ar" ? "ar-u-nu-latn" : language;

/** Interface languages written right to left, whose layout mirrors. */
export const rightToLeftLanguages: ReadonlySet<InterfaceLanguage> = new Set(["ar"]);

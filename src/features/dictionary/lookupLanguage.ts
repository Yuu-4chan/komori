/**
 * The language lookups deinflect and choose dictionaries for. Japanese is the default; each
 * language decides how the Reader scans text and which parts of an entry show.
 */
export const lookupLanguages = ["ja", "en", "fr", "pt", "it", "es", "ko", "zh"] as const;
export type LookupLanguage = (typeof lookupLanguages)[number];
export const defaultLookupLanguage: LookupLanguage = "ja";

export const isLookupLanguage = (value: unknown): value is LookupLanguage =>
  lookupLanguages.includes(value as LookupLanguage);

/** Whether the language spaces its words, so a lookup starts at the word under the pointer. */
export const spacesWords = (language: LookupLanguage) => language !== "ja" && language !== "zh";

/**
 * Whether a headword's reading shows beside it in the Dictionary page's entries: pinyin in
 * Chinese, Hangul for a Korean word in hanja. Japanese shows its reading as furigana instead.
 */
export const readsBeside = (language: LookupLanguage) => language === "zh" || language === "ko";

/**
 * The language lookups deinflect and choose dictionaries for. Japanese is the default; each
 * language decides how the Reader scans text and which parts of an entry show.
 */
export const lookupLanguages = ["ja", "en"] as const;
export type LookupLanguage = (typeof lookupLanguages)[number];
export const defaultLookupLanguage: LookupLanguage = "ja";

export const isLookupLanguage = (value: unknown): value is LookupLanguage =>
  lookupLanguages.includes(value as LookupLanguage);

/** Whether the language spaces its words, so a lookup starts at the word under the pointer. */
export const spacesWords = (language: LookupLanguage) => language === "en";

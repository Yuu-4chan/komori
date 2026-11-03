/**
 * The language lookups deinflect and choose dictionaries for. Japanese is the default; each
 * language decides how the Reader scans text and which parts of an entry show.
 */
export const lookupLanguages = [
  "ja",
  "en",
  "fr",
  "pt",
  "it",
  "es",
  "ko",
  "zh",
  "de",
  "ru",
] as const;
export type LookupLanguage = (typeof lookupLanguages)[number];
export const defaultLookupLanguage: LookupLanguage = "ja";

/** The languages starter dictionaries can have their definitions in, a wider set than lookups. */
export const definitionLanguages = [
  ...lookupLanguages,
  "cs",
  "el",
  "id",
  "ku",
  "ms",
  "nl",
  "pl",
  "th",
  "tr",
  "vi",
] as const;
export type DefinitionLanguage = (typeof definitionLanguages)[number];
export const isDefinitionLanguage = (value: unknown): value is DefinitionLanguage =>
  definitionLanguages.some((language) => language === value);

export const isLookupLanguage = (value: unknown): value is LookupLanguage =>
  lookupLanguages.includes(value as LookupLanguage);

/** Whether the language spaces its words, so a lookup starts at the word under the pointer. */
export const spacesWords = (language: LookupLanguage) => language !== "ja" && language !== "zh";

/**
 * Whether a headword's reading shows beside it in the Dictionary page's entries: pinyin in
 * Chinese, Hangul for a Korean word in hanja. Japanese shows its reading as furigana instead.
 */
export const readsBeside = (language: LookupLanguage) => language === "zh" || language === "ko";

/**
 * A word's pronunciations as an entry shows them: between slashes, except Chinese, whose
 * `ipa` metadata is pinyin.
 */
export const transcriptionText = (language: LookupLanguage, transcriptions: string[]) =>
  transcriptions
    .map((text) =>
      language === "zh" || /^[/[]|\p{Script=Hangul}/u.test(text) ? text : `/${text}/`,
    )
    .join(", ");

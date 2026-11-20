/**
 * The language lookups deinflect and choose dictionaries for. Japanese is the default; each
 * language decides how the Reader scans text and which parts of an entry show. The languages
 * without deinflection rules find inflected words through their dictionaries' own form entries.
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
export type LookupLanguage = (typeof lookupLanguages)[number];
export const defaultLookupLanguage: LookupLanguage = "ja";

/** The languages starter dictionaries can have their definitions in, a wider set than lookups. */
export const definitionLanguages = [...lookupLanguages, "cs", "ku", "ms"] as const;
export type DefinitionLanguage = (typeof definitionLanguages)[number];
export const isDefinitionLanguage = (value: unknown): value is DefinitionLanguage =>
  definitionLanguages.some((language) => language === value);

export const isLookupLanguage = (value: unknown): value is LookupLanguage =>
  lookupLanguages.includes(value as LookupLanguage);

const threeLetterCodes: Record<string, LookupLanguage> = {
  jpn: "ja",
  eng: "en",
  fra: "fr",
  fre: "fr",
  por: "pt",
  ita: "it",
  spa: "es",
  kor: "ko",
  zho: "zh",
  chi: "zh",
  cmn: "zh",
  yue: "zh",
  deu: "de",
  ger: "de",
  rus: "ru",
  nld: "nl",
  dut: "nl",
  pol: "pl",
  swe: "sv",
  nob: "nb",
  nor: "nb",
  no: "nb",
  dan: "da",
  fin: "fi",
  ell: "el",
  gre: "el",
  tur: "tr",
  ara: "ar",
  arb: "ar",
  hin: "hi",
  tha: "th",
  vie: "vi",
  ind: "id",
};

/**
 * The lookup language a language tag (a book's, say) names by its primary subtag, in either case,
 * as a two- or three-letter code (`it-IT`, `IT`, `ita`), as native code reads a dictionary's.
 */
export function lookupLanguageOf(tag: string | null | undefined): LookupLanguage | undefined {
  const primary = tag?.trim().split(/[-_]/u)[0]?.toLowerCase() ?? "";
  return isLookupLanguage(primary) ? primary : threeLetterCodes[primary];
}

/** Whether the language spaces its words, so a lookup starts at the word under the pointer. */
export const spacesWords = (language: LookupLanguage) =>
  language !== "ja" && language !== "zh" && language !== "th";

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

import { createContext, Fragment, useContext, type ReactNode } from "react";

import { defaultInterfaceLanguage, formattingLocale, type InterfaceLanguage } from "./languages";
import { de } from "./messages/de";
import { en } from "./messages/en";
import { es } from "./messages/es";
import { fr } from "./messages/fr";
import { it } from "./messages/it";
import { ja } from "./messages/ja";
import { ko } from "./messages/ko";
import { ptBR } from "./messages/pt-BR";
import { ru } from "./messages/ru";
import { zhCN } from "./messages/zh-CN";
import { zhTW } from "./messages/zh-TW";

export type MessageKey = keyof typeof en;
/** A message with plural forms: `<key>_one`, `<key>_other`, … in the catalog. */
type PluralKey = MessageKey extends infer K
  ? K extends `${infer Base}_other`
    ? Base
    : never
  : never;
/** A plural message's form for each CLDR category, such as Russian's `_few`. */
type PluralForm = `${PluralKey}_${Intl.LDMLPluralRule}`;
export type MessageCatalog = Partial<Record<MessageKey | PluralForm, string>>;
type Values = Record<string, string | number>;

export const catalogs: Record<InterfaceLanguage, MessageCatalog> = {
  en,
  ja,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ko,
  de,
  es,
  fr,
  it,
  "pt-BR": ptBR,
  ru,
};

/** Languages whose own compact forms ("1,2 mil", "1,2 Mio.") read long beside a count. */
const englishCompactSuffixes = new Set<InterfaceLanguage>(["de", "es", "fr", "it", "pt-BR"]);

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const pluralRules = new Map<InterfaceLanguage, Intl.PluralRules>();

function numberFormat(language: InterfaceLanguage, options?: Intl.NumberFormatOptions) {
  const id = `${language}|${options ? JSON.stringify(options) : ""}`;
  let format = numberFormats.get(id);
  if (!format) {
    format = new Intl.NumberFormat(formattingLocale(language), options);
    numberFormats.set(id, format);
  }
  return format;
}

function dateFormat(language: InterfaceLanguage, options?: Intl.DateTimeFormatOptions) {
  const id = `${language}|${options ? JSON.stringify(options) : ""}`;
  let format = dateFormats.get(id);
  if (!format) {
    format = new Intl.DateTimeFormat(formattingLocale(language), options);
    dateFormats.set(id, format);
  }
  return format;
}

function pluralCategory(language: InterfaceLanguage, count: number) {
  // CLDR counts Portuguese zero as singular; Brazilian interfaces read "0 livros".
  if (language === "pt-BR" && count === 0) return "other";
  let rules = pluralRules.get(language);
  if (!rules) {
    rules = new Intl.PluralRules(formattingLocale(language));
    pluralRules.set(language, rules);
  }
  return rules.select(count);
}

/** The message in the language, or in English when the language lacks it. */
function message(language: InterfaceLanguage, key: string): string {
  return (
    (catalogs[language] as Record<string, string | undefined>)[key] ??
    (en as Record<string, string | undefined>)[key] ??
    key
  );
}

function fill(language: InterfaceLanguage, text: string, values?: Values) {
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    if (value === undefined) return match;
    return typeof value === "number" ? numberFormat(language).format(value) : value;
  });
}

function pluralKey(language: InterfaceLanguage, key: PluralKey, count: number) {
  const exact = `${key}_${pluralCategory(language, count)}`;
  const catalog = catalogs[language] as Record<string, string | undefined>;
  if (catalog[exact] !== undefined) return exact;
  if (catalog[`${key}_other`] !== undefined) return `${key}_other`;
  // English fallback chooses its own form.
  return `${key}_${pluralCategory("en", count) === "one" ? "one" : "other"}`;
}

export interface Translator {
  language: InterfaceLanguage;
  /** The message with `{name}` placeholders filled; numbers format for the language. */
  t(key: MessageKey, values?: Values): string;
  /** The plural form for `count`, which also fills `{count}`. */
  tp(key: PluralKey, count: number, values?: Values): string;
  /** The message with placeholders replaced by elements, such as a link inside a sentence. */
  rich(key: MessageKey, parts: Record<string, ReactNode>): ReactNode;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /** A large count shortened for the language, such as 1.2M, 1,2M or 120万. */
  compact(value: number, maximumFractionDigits: number): string;
  date(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  /** Names a language tag, such as `ja`, in the interface language. */
  languageName(tag: string): string | null;
  /** A short relative time, such as "3 days ago". */
  relative(value: number, unit: Intl.RelativeTimeFormatUnit): string;
  list(items: string[], type?: Intl.ListFormatType): string;
  compare(a: string, b: string): number;
}

const displayNames = new Map<InterfaceLanguage, Intl.DisplayNames | null>();
const relativeFormats = new Map<InterfaceLanguage, Intl.RelativeTimeFormat>();
const collators = new Map<InterfaceLanguage, Intl.Collator>();

function createTranslator(language: InterfaceLanguage): Translator {
  const locale = formattingLocale(language);
  return {
    language,
    t: (key, values) => fill(language, message(language, key), values),
    tp: (key, count, values) =>
      fill(language, message(language, pluralKey(language, key, count)), { count, ...values }),
    rich: (key, parts) =>
      message(language, key)
        .split(/(\{\w+\})/)
        .map((piece, index) => {
          const name = /^\{(\w+)\}$/.exec(piece)?.[1];
          const part = name !== undefined && name in parts ? parts[name] : piece;
          return <Fragment key={index}>{part}</Fragment>;
        }),
    number: (value, options) => numberFormat(language, options).format(value),
    compact: (value, maximumFractionDigits) => {
      const options = { notation: "compact", maximumFractionDigits } as const;
      if (!englishCompactSuffixes.has(language))
        return numberFormat(language, options).format(value);
      // Keep localized separators, with the same compact suffixes as English.
      const separators = new Map(
        numberFormat(language)
          .formatToParts(12345.6)
          .filter((part) => part.type === "decimal" || part.type === "group")
          .map((part) => [part.type, part.value]),
      );
      return numberFormat("en", options)
        .formatToParts(value)
        .map((part) => separators.get(part.type) ?? part.value)
        .join("");
    },
    date: (value, options) => dateFormat(language, options).format(value),
    languageName(tag) {
      let names = displayNames.get(language);
      if (names === undefined) {
        try {
          names = new Intl.DisplayNames([locale], { type: "language" });
        } catch {
          names = null;
        }
        displayNames.set(language, names);
      }
      try {
        const name = names?.of(tag);
        // Some languages write language names in lowercase ("japonês"); a label starts capitalized.
        return name ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1) : null;
      } catch {
        return null;
      }
    },
    relative(value, unit) {
      let format = relativeFormats.get(language);
      if (!format) {
        format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
        relativeFormats.set(language, format);
      }
      return format.format(value, unit);
    },
    list: (items, type = "conjunction") =>
      new Intl.ListFormat(locale, { style: "long", type }).format(items),
    compare(a, b) {
      let collator = collators.get(language);
      if (!collator) {
        collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
        collators.set(language, collator);
      }
      return collator.compare(a, b);
    },
  };
}

const translators = Object.fromEntries(
  (Object.keys(catalogs) as InterfaceLanguage[]).map((language) => [
    language,
    createTranslator(language),
  ]),
) as Record<InterfaceLanguage, Translator>;

export const translatorFor = (language: InterfaceLanguage) => translators[language];

let current: Translator = translators[defaultInterfaceLanguage];

/**
 * The interface language's translator for code outside components. Components read it with
 * `useI18n` instead, so a language change renders them again.
 */
export const i18n = (): Translator => current;

const I18nContext = createContext<Translator>(translators[defaultInterfaceLanguage]);

/** Supplies the interface language below it; without one, the interface is in English. */
export function I18nProvider({
  language,
  children,
}: {
  language: InterfaceLanguage;
  children: ReactNode;
}) {
  // Helpers called while rendering read the same language as the components around them.
  current = translators[language];
  return <I18nContext.Provider value={translators[language]}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);

/**
 * How a count of characters or words is written, the same on every screen: the language's
 * short unit ("Ch." and "Wo." in English, 字 and 語 in Japanese) after the number. The Library
 * has the room to spell the unit out ("characters", "words") and does.
 */
import { i18n } from "./i18n";

export type AmountUnit = "characters" | "words";

/** "5,250 Ch."; a count already written, such as "1.6M", is kept as it is. */
export const amount = (unit: AmountUnit, count: number | string): string =>
  i18n().t(unit === "words" ? "amount.words" : "amount.characters", { count });

/** "12,345 / 50,000 Ch."; counts already written, such as "120K / 1.6M", are kept. */
export const amountOf = (unit: AmountUnit, read: number | string, total: number | string): string =>
  i18n().t(unit === "words" ? "amount.wordsOf" : "amount.charactersOf", { read, total });

/** The Library's "5,250 characters", or "27M characters" from a count already written. */
export const spelledAmount = (unit: AmountUnit, count: number | string): string =>
  i18n().t(unit === "words" ? "librarySummary.words" : "librarySummary.characters", { count });

/** The Library's "12,345 / 50,000 characters". */
export const spelledAmountOf = (
  unit: AmountUnit,
  read: number | string,
  total: number | string,
): string =>
  i18n().t(unit === "words" ? "libraryCard.readWords" : "libraryCard.readCharacters", {
    read,
    total,
  });

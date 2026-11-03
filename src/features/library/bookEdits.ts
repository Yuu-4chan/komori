/**
 * How Edit… numbers several books from the first one's new title: each book's volume is
 * guessed from its series, its title, its file name, or else its place, and put where the
 * first title has its number.
 */
import type { LibraryBook } from "./libraryApi";
import { bookTitle } from "./libraryView";

/** ASCII or full-width digits with an optional decimal part. */
const NUMBER = /[0-9０-９]+(?:[.．][0-9０-９]+)?/gu;
/** A four-digit year, which numbers a volume only when nothing else does. */
const YEAR = /^(?:19|20)\d\d$/u;

const toAscii = (text: string) =>
  text.replace(/[０-９．]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
const toFullWidth = (text: string) =>
  text.replace(/[0-9.]/gu, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0));

/** The last number in the text that isn't a year, or else its last year. */
function volumeNumber(text: string): { start: number; end: number; digits: string } | null {
  const numbers = [...text.matchAll(NUMBER)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    digits: match[0],
  }));
  return (
    [...numbers].reverse().find((number) => !YEAR.test(toAscii(number.digits))) ??
    numbers.at(-1) ??
    null
  );
}

/** Drops leading zeros (`03` is 3, `0.5` stays). */
const plain = (digits: string) => toAscii(digits).replace(/^0+(?=\d)/u, "");

/**
 * A book's volume, in ASCII digits: its series number, else the number its title or file name
 * ends in, else its place among the books being edited (from 1).
 */
export function guessVolume(book: LibraryBook, position: number): string {
  if (book.series && typeof book.seriesIndex === "number" && Number.isFinite(book.seriesIndex))
    return String(book.seriesIndex);
  const found =
    volumeNumber(bookTitle(book)) ?? volumeNumber(book.fileName.replace(/\.epub$/iu, ""));
  return found ? plain(found.digits) : String(position + 1);
}

/**
 * The first title with its number replaced by this volume, written as the first title writes
 * it (zero-padded to its width, full-width or not), or with the volume added after a space.
 */
export function followTitle(lead: string, volume: string): string {
  const found = volumeNumber(lead);
  if (!found) return `${lead.trimEnd()} ${volume}`;
  const whole = toAscii(found.digits).split(".")[0] ?? "";
  const [volumeWhole = "", fraction] = volume.split(".");
  const padded = whole.startsWith("0") ? volumeWhole.padStart(whole.length, "0") : volumeWhole;
  let digits = fraction === undefined ? padded : `${padded}.${fraction}`;
  if (/[０-９]/u.test(found.digits)) digits = toFullWidth(digits);
  return lead.slice(0, found.start) + digits + lead.slice(found.end);
}

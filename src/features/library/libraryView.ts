import { i18n } from "../../i18n/i18n";
/**
 * The Library's saved view choices and the reading status, sort, and search it derives from
 * each book. Keep the choices in step with `src-tauri/src/appearance_preferences.rs`.
 */
import type { LibraryBook } from "./libraryApi";

export type LibraryView = "grid" | "list";
export type LibrarySort = "recent" | "added" | "title" | "progress" | "characters" | "words";
export type LibraryFilter = "all" | "reading" | "completed" | "not-started";
export type LibraryReadingStatus = Exclude<LibraryFilter, "all">;
export type LibraryGroup = "none" | "series" | "language";

const libraryViews: readonly LibraryView[] = ["grid", "list"];
const librarySorts: readonly LibrarySort[] = [
  "recent",
  "added",
  "title",
  "progress",
  "characters",
  "words",
];
const libraryFilters: readonly LibraryFilter[] = ["all", "reading", "completed", "not-started"];

const libraryGroups: readonly LibraryGroup[] = ["none", "series", "language"];

export const isLibraryView = (value: unknown): value is LibraryView =>
  libraryViews.includes(value as LibraryView);
export const isLibrarySort = (value: unknown): value is LibrarySort =>
  librarySorts.includes(value as LibrarySort);
export const isLibraryFilter = (value: unknown): value is LibraryFilter =>
  libraryFilters.includes(value as LibraryFilter);
export const isLibraryGroup = (value: unknown): value is LibraryGroup =>
  libraryGroups.includes(value as LibraryGroup);

/** The narrowest a grid card may be, in px; the grid fills each row with cards this wide or wider. */
export const libraryCardSize = { min: 100, max: 480, step: 10, default: 180 } as const;

export const isLibraryCardSize = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= libraryCardSize.min &&
  value <= libraryCardSize.max &&
  value % libraryCardSize.step === 0;

/** How far through the book the Reader last counted, from 0 to 1; null before it is opened. */
function bookFraction(book: LibraryBook): number | null {
  const progress = book.progress;
  if (!progress || progress.total <= 0) return null;
  return Math.min(1, Math.max(0, progress.current / progress.total));
}

/**
 * Completed at the final page (the Reader counts it as the whole book); reading once opened;
 * not started otherwise.
 */
export function readingStatus(book: LibraryBook): LibraryReadingStatus {
  const fraction = bookFraction(book);
  if (fraction !== null && fraction >= 1) return "completed";
  if (fraction !== null || book.lastReadAt) return "reading";
  return "not-started";
}

/**
 * In progress with reading done: past the first counted character and not finished. A book only
 * opened (to look at its illustrations, say) is not, so Continue reading leaves it out.
 */
export function hasReadingProgress(book: LibraryBook): boolean {
  const fraction = bookFraction(book);
  return fraction !== null && fraction > 0 && fraction < 1;
}

/** A whole percentage that only shows 100 when the book is finished. */
export function progressPercent(book: LibraryBook): number {
  const fraction = bookFraction(book) ?? 0;
  return fraction >= 1 ? 100 : Math.min(99, Math.floor(fraction * 100));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function bookTitle(book: LibraryBook): string {
  return book.title ?? book.fileName;
}

/** Title, author, series, and file name contain every word of the query, ignoring case. */
export function matchesQuery(book: LibraryBook, query: string): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [book.title, book.author, book.series, book.fileName]
    .filter(Boolean)
    .join("\n")
    .toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}

const time = (value: string | null | undefined) => (value ? Date.parse(value) || 0 : 0);

/**
 * Sorts a copy. Recently opened puts never-opened books last in import order; Characters, most
 * first, keeps the books Komori counted (Chinese, Japanese, and Korean books) first, and
 * reversing only reverses within them.
 */
export function sortBooks(
  books: readonly LibraryBook[],
  sort: LibrarySort,
  reversed: boolean,
): LibraryBook[] {
  const direction = reversed ? -1 : 1;
  const compare = (a: LibraryBook, b: LibraryBook): number => {
    switch (sort) {
      case "recent": {
        const [first, second] = [time(a.lastReadAt), time(b.lastReadAt)];
        if (!first !== !second) return first ? -1 : 1;
        return direction * (second - first || time(b.importedAt) - time(a.importedAt));
      }
      case "added":
        return direction * (time(b.importedAt) - time(a.importedAt));
      case "title":
        return direction * collator.compare(bookTitle(a), bookTitle(b));
      case "progress":
        return direction * ((bookFraction(b) ?? -1) - (bookFraction(a) ?? -1));
      case "characters":
      case "words": {
        const [first, second] = [a[sort] ?? null, b[sort] ?? null];
        if ((first === null) !== (second === null)) return first === null ? 1 : -1;
        return direction * ((second ?? 0) - (first ?? 0));
      }
    }
  };
  return [...books].sort((a, b) => compare(a, b) || collator.compare(bookTitle(a), bookTitle(b)));
}

/**
 * "12,345 / 50,000 characters" once the Reader has counted the book;
 * "0 / 50,000 characters" (or words) for a book not yet opened, from what Komori counted at
 * import.
 */
export function readTotalLabel(book: LibraryBook): string | null {
  const { t } = i18n();
  const progress = book.progress;
  if (!progress) {
    if (book.lastReadAt) return null;
    if (typeof book.characters === "number")
      return t("libraryCard.readCharacters", { read: 0, total: book.characters });
    if (typeof book.words === "number")
      return t("libraryCard.readWords", { read: 0, total: book.words });
    return null;
  }
  return t(
    progress.unit === "characters" ? "libraryCard.readCharacters" : "libraryCard.readWords",
    {
      read: Math.min(progress.current, progress.total),
      total: progress.total,
    },
  );
}

/** The percentage beside a progress bar: "Completed" at the end. */
export function progressLabel(book: LibraryBook): string {
  const percent = progressPercent(book);
  return percent >= 100 ? i18n().t("libraryCard.completed") : `${percent}%`;
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "2 days ago", or null for a book never opened. */
export function lastReadLabel(book: LibraryBook, now = Date.now()): string | null {
  const read = book.lastReadAt ? Date.parse(book.lastReadAt) : Number.NaN;
  if (Number.isNaN(read)) return null;
  const seconds = Math.round((read - now) / 1000);
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return i18n().relative(Math.round(seconds / size), unit);
  }
  return i18n().t("libraryCard.justNow");
}

const SIMPLIFIED = new Set(["HANS", "CN", "SG", "MY"]);
const TRADITIONAL = new Set(["HANT", "TW", "HK", "MO"]);

/**
 * A language tag as the Library shows and groups it: the language alone (`ja-JP` is `ja`),
 * except Chinese, which keeps its script, `zh-Hans` or `zh-Hant`, from the tag's script or
 * else its region. Komori stores tags this way; older or other tags reduce the same way.
 */
export function shownLanguage(tag: string): string {
  const [primary = "", ...rest] = tag.split(/[-_]/);
  const language = primary.toLowerCase();
  if (language !== "zh") return language || tag;
  let script: string | null = null;
  for (const part of rest) {
    const upper = part.toUpperCase();
    script ??= SIMPLIFIED.has(upper) ? "zh-Hans" : TRADITIONAL.has(upper) ? "zh-Hant" : null;
    if (part.length === 4) break;
  }
  return script ?? "zh";
}

/**
 * "Japanese" for `ja` and `ja-JP`, "Chinese Simplified" for `zh-Hans` or `zh-CN`, "Chinese
 * Traditional" for `zh-Hant` or `zh-TW`, in the interface language; the tag itself when unnamed.
 */
export function languageName(tag: string): string {
  const shown = shownLanguage(tag);
  if (shown === "zh-Hans") return i18n().t("language.zhHans");
  if (shown === "zh-Hant") return i18n().t("language.zhHant");
  return i18n().languageName(shown) ?? tag;
}

export interface LibrarySection {
  /** `series:<name>` or `language:<tag>` (empty after the colon for books without one). */
  key: string;
  /** The heading; null for the ungrouped Library. */
  title: string | null;
  books: LibraryBook[];
}

// No series or language is ever empty, so the empty key stands for books without one.
const NO_GROUP = "";

/**
 * Books under headings: by series (each in series order, then the chosen order) or by
 * language, named groups alphabetically and books without one last. `none` is one untitled
 * section in the chosen order.
 */
export function groupBooks(books: readonly LibraryBook[], group: LibraryGroup): LibrarySection[] {
  if (group === "none") return [{ key: "all", title: null, books: [...books] }];
  const sections = new Map<string, LibraryBook[]>();
  for (const book of books) {
    const value = group === "series" ? book.series : book.language && shownLanguage(book.language);
    const key = value ?? NO_GROUP;
    const section = sections.get(key);
    if (section) section.push(book);
    else sections.set(key, [book]);
  }
  const title = (key: string) =>
    key === NO_GROUP
      ? group === "series"
        ? i18n().t("libraryCard.noSeries")
        : i18n().t("libraryCard.unknownLanguage")
      : group === "series"
        ? key
        : languageName(key);
  return [...sections.entries()]
    .sort(([first], [second]) =>
      first === NO_GROUP
        ? 1
        : second === NO_GROUP
          ? -1
          : collator.compare(title(first), title(second)),
    )
    .map(([key, members]) => ({
      key: `${group}:${key}`,
      title: title(key),
      books: group === "series" && key !== NO_GROUP ? inSeriesOrder(members) : members,
    }));
}

/** Numbered books first in their order; the rest keep the order they came in. */
function inSeriesOrder(books: LibraryBook[]): LibraryBook[] {
  return books
    .map((book, position) => ({ book, position }))
    .sort((first, second) => {
      const [a, b] = [first.book.seriesIndex ?? null, second.book.seriesIndex ?? null];
      if (a !== null && b !== null && a !== b) return a - b;
      if ((a === null) !== (b === null)) return a === null ? 1 : -1;
      return first.position - second.position;
    })
    .map(({ book }) => book);
}

/** The grouping a section key such as `series:Accel World` belongs to, if any. */
export function sectionGroup(key: string): Exclude<LibraryGroup, "none"> | null {
  const group = key.slice(0, key.indexOf(":"));
  return group === "series" || group === "language" ? group : null;
}

/** Characters across every book Komori counted (Chinese, Japanese, and Korean books). */
export function libraryCharacters(books: readonly LibraryBook[]): number {
  return books.reduce((sum, book) => sum + (book.characters ?? 0), 0);
}

/** Words across every other book Komori counted. */
export function libraryWords(books: readonly LibraryBook[]): number {
  return books.reduce((sum, book) => sum + (book.words ?? 0), 0);
}

import { i18n } from "../../i18n/i18n";
/**
 * The Library's saved view choices and the reading status, sort, and search it derives from
 * each book. Keep the choices in step with `src-tauri/src/appearance_preferences.rs`.
 */
import type { LibraryBook } from "./libraryApi";

export type LibraryView = "grid" | "list";
export type LibrarySort =
  "recent" | "added" | "title" | "author" | "progress" | "characters" | "words";
export type LibraryFilter = "all" | "reading" | "completed" | "not-started";
export type LibraryReadingStatus = Exclude<LibraryFilter, "all">;
export type LibraryGroup = "none" | "series" | "language" | "author";

const libraryViews: readonly LibraryView[] = ["grid", "list"];
const librarySorts: readonly LibrarySort[] = [
  "recent",
  "added",
  "title",
  "author",
  "progress",
  "characters",
  "words",
];
const libraryFilters: readonly LibraryFilter[] = ["all", "reading", "completed", "not-started"];

const libraryGroups: readonly LibraryGroup[] = ["none", "series", "language", "author"];

export const isLibraryView = (value: unknown): value is LibraryView =>
  libraryViews.includes(value as LibraryView);
export const isLibrarySort = (value: unknown): value is LibrarySort =>
  librarySorts.includes(value as LibrarySort);
/** Which of the phone's books its Library shows while paired with a PC. */
export type LibraryPlace = "all" | "phone" | "pc";
const libraryPlaces: readonly LibraryPlace[] = ["all", "phone", "pc"];
export const isLibraryPlace = (value: unknown): value is LibraryPlace =>
  libraryPlaces.includes(value as LibraryPlace);
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

/** Not finished yet, with a count to finish it in: the Reader's, or Komori's from import. */
export function canMarkCompleted(book: LibraryBook): boolean {
  return (
    readingStatus(book) !== "completed" &&
    ((book.progress?.total ?? 0) > 0 || (book.characters ?? 0) > 0 || (book.words ?? 0) > 0)
  );
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

/**
 * The first of a book's authors, which the Library groups it under: `A & B`, `A／B`, `A, B`
 * and `A、B` list several, as Calibre and Japanese stores write them.
 */
export function leadAuthor(book: LibraryBook): string | null {
  const lead = book.author?.split(/\s*(?:[&＆;；、／/]|,\s)\s*/u)[0]?.trim();
  return lead || null;
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
 * Sorts a copy. Recently opened puts never-opened books last in import order; Author, by name
 * and then title, keeps books without one last; Characters, most first, keeps the books Komori
 * counted (Chinese, Japanese, and Korean books) first, and reversing only reverses within them.
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
      case "author":
        if (!a.author !== !b.author) return a.author ? -1 : 1;
        return direction * collator.compare(a.author ?? "", b.author ?? "");
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
  return timeAgo(book.lastReadAt, now);
}

/** "2 days ago" for a stored time, or null for none. */
export function timeAgo(at: string | null | undefined, now = Date.now()): string | null {
  const read = at ? Date.parse(at) : Number.NaN;
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
  /**
   * `series:<name>`, `language:<tag>` or `author:<name>` (empty after the colon for books
   * without one).
   */
  key: string;
  /** The heading; null for the ungrouped Library. */
  title: string | null;
  books: LibraryBook[];
}

// No series, language or author is ever empty, so the empty key stands for books without one.
const NO_GROUP = "";

/**
 * What a group is ordered by under a sort, larger first: its latest opening (with its latest
 * import breaking ties) or import, its books' mean progress, or the characters or words of all
 * its books. Unranked groups (never opened, none opened, or none counted) follow the rest in
 * either direction. Title and Author order groups by name instead.
 */
function groupRank(
  books: readonly LibraryBook[],
  sort: Exclude<LibrarySort, "title" | "author">,
): { ranked: boolean; value: number; tie: number } {
  const latest = (field: "lastReadAt" | "importedAt") =>
    books.reduce((most, book) => Math.max(most, time(book[field])), 0);
  switch (sort) {
    case "recent": {
      const read = latest("lastReadAt");
      return { ranked: read > 0, value: read, tie: latest("importedAt") };
    }
    case "added":
      return { ranked: true, value: latest("importedAt"), tie: 0 };
    case "progress": {
      const fractions = books.map(bookFraction);
      const total = fractions.reduce<number>((sum, fraction) => sum + (fraction ?? 0), 0);
      return {
        ranked: fractions.some((fraction) => fraction !== null),
        value: total / books.length,
        tie: 0,
      };
    }
    case "characters":
    case "words": {
      const counts = books.flatMap((book) => (typeof book[sort] === "number" ? [book[sort]] : []));
      return {
        ranked: counts.length > 0,
        value: counts.reduce((sum, count) => sum + count, 0),
        tie: 0,
      };
    }
  }
}

/**
 * Books under headings, by series, language or (first) author, each group's books in the order they came
 * in (the chosen sort). Named groups follow the chosen sort and direction (see `groupRank`),
 * then their names; books without one come last. `none` is one untitled section.
 */
export function groupBooks(
  books: readonly LibraryBook[],
  group: LibraryGroup,
  sort: LibrarySort = "title",
  reversed = false,
): LibrarySection[] {
  if (group === "none") return [{ key: "all", title: null, books: [...books] }];
  const sections = new Map<string, LibraryBook[]>();
  for (const book of books) {
    const value =
      group === "series"
        ? book.series
        : group === "author"
          ? leadAuthor(book)
          : book.language && shownLanguage(book.language);
    const key = value ?? NO_GROUP;
    const section = sections.get(key);
    if (section) section.push(book);
    else sections.set(key, [book]);
  }
  const title = (key: string) =>
    key === NO_GROUP
      ? i18n().t(
          group === "series"
            ? "libraryCard.noSeries"
            : group === "author"
              ? "libraryCard.unknownAuthor"
              : "libraryCard.unknownLanguage",
        )
      : group === "language"
        ? languageName(key)
        : key;
  const direction = reversed ? -1 : 1;
  const rank = new Map(
    sort === "title" || sort === "author"
      ? []
      : [...sections].map(([key, members]) => [key, groupRank(members, sort)] as const),
  );
  const compare = (first: string, second: string): number => {
    const [a, b] = [rank.get(first), rank.get(second)];
    if (!a || !b) return direction * collator.compare(title(first), title(second));
    if (a.ranked !== b.ranked) return a.ranked ? -1 : 1;
    return direction * (b.value - a.value || b.tie - a.tie);
  };
  return [...sections.keys()]
    .sort((first, second) =>
      first === NO_GROUP
        ? 1
        : second === NO_GROUP
          ? -1
          : compare(first, second) || collator.compare(title(first), title(second)),
    )
    .map((key) => ({ key: `${group}:${key}`, title: title(key), books: sections.get(key) ?? [] }));
}

/** The grouping a section key such as `series:Accel World` belongs to, if any. */
export function sectionGroup(key: string): Exclude<LibraryGroup, "none"> | null {
  const group = key.slice(0, key.indexOf(":"));
  return group === "series" || group === "language" || group === "author" ? group : null;
}

/** `/library?group=<section key>` is one group's own page, opened from its See all or a card's chip. */
export function groupPageLink(key: string): string {
  return `/library?group=${encodeURIComponent(key)}`;
}

/** The words a series name can end in before a volume's number: `Vol. 2`, `Ep.05`, `第3巻`. */
const VOLUME_WORD =
  /(?:(?<![\p{L}\p{N}])(?:v|vol(?:ume)?|ep(?:isode)?|book|part|tome|tomo|livro|parte)|第)$/iu;

/** Numbers, separators and opening brackets ending a name, but not a title's own `！` or `？`. */
const TRAILING = /(?:(?![!?！？‼⁉⁈⁇])[\s\p{N}\p{Po}\p{Ps}\p{Pi}\p{Pc}])+$/u;

/** One part of a volume split in two or three, closing a name: `（上）`, `〈下〉`, `前編`. */
const PART = /(?:[（(〈【［[]\s*[上中下前後][編巻]?\s*[）)〉】］\]]|[上中下前後][編巻])$/u;

/** The opening partner of a closing symbol, so `＜インフィニット・ストラトス＞` keeps its `＞`. */
const OPENING: Record<string, string> = { ">": "<", "＞": "＜", "﹥": "﹤" };

/** A letter of a script that separates its words with spaces. */
const SPACED_LETTER = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u;

/** Whether two characters read the same, full-width (`４`) or not (`4`). */
const sameCharacter = (a: string, b: string) =>
  a === b || a.normalize("NFKC") === b.normalize("NFKC");

/**
 * The series name several titles share, from how they begin: `Cat Tales 1` and `Cat Tales 2`
 * give `Cat Tales`, and `86─エイティシックス─Ep.05─…` and `86─エイティシックス─Alter.01─…` give
 * `86─エイティシックス─`. Volume numbers and words, parts such as `（上）`, separators and
 * opening brackets before where the titles differ are left out, and so is a word they differ
 * within; a closing bracket, `！` or `？` stays, as does a dash or symbol that closes one
 * opening earlier in the name (`＜インフィニット・ストラトス＞`). A dash after a space only
 * separates (`Bing - An - Vol 3`), and an opening bracket heading the name that it never
 * closes is left out.
 * Empty for fewer than two titles, or when they share no name.
 */
export function seriesFromTitles(titles: readonly string[]): string {
  if (titles.length < 2) return "";
  const [first, ...rest] = titles.map((title) => [...title.normalize("NFC").trim()]);
  let length = first.length;
  for (const title of rest) {
    let index = 0;
    while (index < length && index < title.length && sameCharacter(title[index], first[index]))
      index += 1;
    length = index;
  }
  let stem = first.slice(0, length).join("");
  const last = first[length - 1];
  const midWord = [first, ...rest].some((title) => {
    const next = title[length];
    return next !== undefined && SPACED_LETTER.test(next);
  });
  if (last && SPACED_LETTER.test(last) && midWord) stem = stem.replace(/[\p{L}\p{M}]+$/u, "");
  for (;;) {
    let next = stem.replace(TRAILING, "").replace(VOLUME_WORD, "").replace(PART, "");
    const end = [...next].at(-1);
    const earlier = end ? next.slice(0, -end.length) : "";
    if (
      end &&
      /[\p{Pd}\p{S}]/u.test(end) &&
      ((!OPENING[end] && /\s$/u.test(earlier)) ||
        (!earlier.includes(end) && !earlier.includes(OPENING[end] ?? end)))
    )
      next = earlier;
    if (next === stem) break;
    stem = next;
  }
  if (!/[\p{Pe}\p{Pf}]/u.test(stem)) stem = stem.replace(/^[\p{Ps}\p{Pi}]\s*/u, "");
  return /\p{L}/u.test(stem) ? stem : "";
}

/** Characters across every book Komori counted (Chinese, Japanese, and Korean books). */
export function libraryCharacters(books: readonly LibraryBook[]): number {
  return books.reduce((sum, book) => sum + (book.characters ?? 0), 0);
}

/** Words across every other book Komori counted. */
export function libraryWords(books: readonly LibraryBook[]): number {
  return books.reduce((sum, book) => sum + (book.words ?? 0), 0);
}

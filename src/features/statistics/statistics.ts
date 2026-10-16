import { i18n } from "../../i18n/i18n";
import type { LibraryBook } from "../library/libraryApi";
import { languageName, readingStatus, type LibraryReadingStatus } from "../library/libraryView";
import { sessionMeasurements, type StoredReadingSession } from "./statisticsApi";

export type StatisticsRange = "today" | "month" | "all";

/** Local-time bounds, inclusive start and exclusive end; null for all time. */
export interface Period {
  start: number;
  end: number;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

/** The range's period and the one before it, to compare with. */
export function rangePeriods(
  range: StatisticsRange,
  now: Date,
): { current: Period | null; previous: Period | null } {
  if (range === "all") return { current: null, previous: null };
  if (range === "today") {
    const today = startOfDay(now);
    return {
      current: { start: +today, end: +addDays(today, 1) },
      previous: { start: +addDays(today, -1), end: +today },
    };
  }
  const month = startOfMonth(now);
  return {
    current: { start: +month, end: +addMonths(month, 1) },
    previous: { start: +addMonths(month, -1), end: +month },
  };
}

/** A session belongs to the local day (and month) it started on. */
function inPeriod(session: StoredReadingSession, period: Period | null): boolean {
  return !period || (session.startedAt >= period.start && session.startedAt < period.end);
}

export interface BookActivity {
  bookId: string;
  unit: StoredReadingSession["unit"];
  unitsRead: number;
  activeMs: number;
}

export interface ActivitySummary {
  activeMs: number;
  sessions: number;
  characters: number;
  words: number;
  /** Active time of sessions in each unit, for speed. */
  characterMs: number;
  wordMs: number;
  /** Books begun from their start, and books read to their end. */
  started: number;
  finished: number;
  /** Each book read, most read first (by time). */
  books: BookActivity[];
}

/** Totals over the sessions in a period. */
export function summarize(
  sessions: readonly StoredReadingSession[],
  period: Period | null,
): ActivitySummary {
  const summary: ActivitySummary = {
    activeMs: 0,
    sessions: 0,
    characters: 0,
    words: 0,
    characterMs: 0,
    wordMs: 0,
    started: 0,
    finished: 0,
    books: [],
  };
  const books = new Map<string, BookActivity>();
  const started = new Set<string>();
  const finished = new Set<string>();
  for (const session of sessions) {
    if (!inPeriod(session, period)) continue;
    const { unitsRead, activeMs } = sessionMeasurements(session);
    summary.sessions += 1;
    summary.activeMs += activeMs;
    if (session.unit === "characters") {
      summary.characters += unitsRead;
      summary.characterMs += activeMs;
    } else {
      summary.words += unitsRead;
      summary.wordMs += activeMs;
    }
    if (session.startUnits === 0 && session.unitsRead > 0) started.add(session.bookId);
    if (
      !session.finishCleared &&
      session.endUnits >= session.totalUnits &&
      session.startUnits < session.totalUnits
    )
      finished.add(session.bookId);
    const book = books.get(session.bookId) ?? {
      bookId: session.bookId,
      unit: session.unit,
      unitsRead: 0,
      activeMs: 0,
    };
    book.unit = session.unit;
    book.unitsRead += unitsRead;
    book.activeMs += activeMs;
    books.set(session.bookId, book);
  }
  summary.started = started.size;
  summary.finished = finished.size;
  summary.books = [...books.values()].sort(
    (a, b) => b.activeMs - a.activeMs || b.unitsRead - a.unitsRead,
  );
  return summary;
}

/** Units per hour of active reading, or null with less than a minute read in that unit. */
export function speed(units: number, ms: number): number | null {
  if (ms < 60_000) return null;
  return Math.round(units / (ms / 3_600_000));
}

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/** Calendar shading by minutes read: none, under 15, under 30, under 60, an hour or more. */
export function heatLevel(activeMs: number): HeatLevel {
  const minutes = activeMs / 60_000;
  if (activeMs <= 0) return 0;
  if (minutes < 15) return 1;
  if (minutes < 30) return 2;
  if (minutes < 60) return 3;
  return 4;
}

export interface CalendarDay {
  date: Date;
  summary: ActivitySummary;
  level: HeatLevel;
}

/** Every day of the month containing `month`, with its reading. */
export function calendarMonth(
  sessions: readonly StoredReadingSession[],
  month: Date,
): CalendarDay[] {
  const first = startOfMonth(month);
  const days: CalendarDay[] = [];
  for (let date = first; date.getMonth() === first.getMonth(); date = addDays(date, 1)) {
    const summary = summarize(sessions, { start: +date, end: +addDays(date, 1) });
    days.push({ date, summary, level: heatLevel(summary.activeMs) });
  }
  return days;
}

/** The local day key of a time, such as `2026-10-02`. */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Days read in a row up to today (or up to yesterday while today has none yet). */
export function currentStreak(sessions: readonly StoredReadingSession[], now: Date): number {
  const read = readDays(sessions);
  let day = startOfDay(now);
  if (!read.has(dayKey(day))) day = addDays(day, -1);
  let streak = 0;
  while (read.has(dayKey(day))) {
    streak += 1;
    day = addDays(day, -1);
  }
  return streak;
}

/** The longest run of days read within the month containing `month`. */
export function bestStreakInMonth(sessions: readonly StoredReadingSession[], month: Date): number {
  const read = readDays(sessions);
  let best = 0;
  let run = 0;
  const first = startOfMonth(month);
  for (let date = first; date.getMonth() === first.getMonth(); date = addDays(date, 1)) {
    run = read.has(dayKey(date)) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

function readDays(sessions: readonly StoredReadingSession[]): Set<string> {
  const days = new Set<string>();
  for (const session of sessions) {
    const { activeMs, unitsRead } = sessionMeasurements(session);
    if (activeMs > 0 || unitsRead > 0) days.add(dayKey(new Date(session.startedAt)));
  }
  return days;
}

const cjkLanguages = ["ja", "zh", "ko"] as const;
type CjkLanguage = (typeof cjkLanguages)[number];

/** `ja`, `zh`, or `ko` for a Chinese, Japanese, or Korean book's tag; null otherwise. */
function cjkLanguage(tag: string | null | undefined): CjkLanguage | null {
  const primary = tag?.split("-")[0]?.toLowerCase();
  return cjkLanguages.find((language) => language === primary) ?? null;
}

/** Whether a book is read in characters (its counted characters or progress say so). */
function isCharacterBook(book: LibraryBook): boolean {
  if (book.progress) return book.progress.unit === "characters";
  return book.characters !== null && book.characters !== undefined;
}

export interface LibraryOverview {
  books: number;
  addedThisMonth: number;
  cjkCharacters: number;
  /** Words in word-based books Komori counted, and how many such books there are. */
  words: number;
  wordBooks: number;
  countedWordBooks: number;
  completed: number;
}

export function libraryOverview(books: readonly LibraryBook[], now: Date): LibraryOverview {
  const month = +startOfMonth(now);
  const overview: LibraryOverview = {
    books: books.length,
    addedThisMonth: 0,
    cjkCharacters: 0,
    words: 0,
    wordBooks: 0,
    countedWordBooks: 0,
    completed: 0,
  };
  for (const book of books) {
    const imported = Date.parse(book.importedAt);
    if (imported >= month) overview.addedThisMonth += 1;
    if (readingStatus(book) === "completed") overview.completed += 1;
    if (isCharacterBook(book)) {
      overview.cjkCharacters += book.characters ?? book.progress?.total ?? 0;
    } else {
      overview.wordBooks += 1;
      // Counted at import, or by the Reader for a book Komori has not counted yet.
      const words =
        book.words ?? (book.progress?.unit === "words" ? book.progress.total : undefined);
      if (typeof words === "number") {
        overview.countedWordBooks += 1;
        overview.words += words;
      }
    }
  }
  return overview;
}

export interface LanguageShare {
  key: string;
  label: string;
  books: number;
  characters: number;
}

/** CJK characters by language, largest first, and the remaining books by language. */
export function languageBreakdown(books: readonly LibraryBook[]): {
  cjk: LanguageShare[];
  other: LanguageShare[];
} {
  const cjk = new Map<string, LanguageShare>();
  const other = new Map<string, LanguageShare>();
  for (const book of books) {
    const language = cjkLanguage(book.language);
    if (language && isCharacterBook(book)) {
      const share = cjk.get(language) ?? {
        key: language,
        label: languageName(language),
        books: 0,
        characters: 0,
      };
      share.books += 1;
      share.characters += book.characters ?? book.progress?.total ?? 0;
      cjk.set(language, share);
    } else {
      const tag = book.language?.split("-")[0]?.toLowerCase() || "";
      const share = other.get(tag) ?? {
        key: tag,
        label: tag ? languageName(tag) : i18n().t("libraryCard.unknownLanguage"),
        books: 0,
        characters: 0,
      };
      share.books += 1;
      other.set(tag, share);
    }
  }
  const byCharacters = (a: LanguageShare, b: LanguageShare) =>
    b.characters - a.characters || b.books - a.books || a.label.localeCompare(b.label);
  const byBooks = (a: LanguageShare, b: LanguageShare) =>
    (a.key === "" ? 1 : 0) - (b.key === "" ? 1 : 0) ||
    b.books - a.books ||
    a.label.localeCompare(b.label);
  return { cjk: [...cjk.values()].sort(byCharacters), other: [...other.values()].sort(byBooks) };
}

/** Every book's status: completed first, then in progress, then not started. */
export function completionOrder(
  books: readonly LibraryBook[],
): { book: LibraryBook; status: LibraryReadingStatus }[] {
  const order: Record<LibraryReadingStatus, number> = {
    completed: 0,
    reading: 1,
    "not-started": 2,
  };
  return books
    .map((book) => ({ book, status: readingStatus(book) }))
    .sort((a, b) => order[a.status] - order[b.status]);
}

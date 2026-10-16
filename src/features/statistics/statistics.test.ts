import { describe, expect, it } from "vitest";

import type { LibraryBook } from "../library/libraryApi";
import {
  bestStreakInMonth,
  calendarMonth,
  completionOrder,
  currentStreak,
  heatLevel,
  languageBreakdown,
  libraryOverview,
  rangePeriods,
  speed,
  summarize,
} from "./statistics";
import { normalizeSession, type StoredReadingSession } from "./statisticsApi";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
let sessionIds = 0;

function session(
  bookId: string,
  start: Date,
  minutes: number,
  unitsRead: number,
  extra: Partial<StoredReadingSession> = {},
): StoredReadingSession {
  sessionIds += 1;
  return {
    bookId,
    id: `00000000-0000-4000-8000-${String(sessionIds).padStart(12, "0")}`,
    startedAt: +start,
    endedAt: +start + minutes * 60_000,
    activeMs: minutes * 60_000,
    unit: "characters",
    unitsRead,
    startUnits: 100,
    endUnits: 100 + unitsRead,
    totalUnits: 100_000,
    bookTitle: null,
    finishCleared: false,
    ...extra,
  };
}

const now = new Date(2026, 9, 15, 21, 0);

describe("statistics", () => {
  it("uses corrected measurements for all ranges, shading, speeds and streaks while keeping checkpoints", () => {
    const raw = session(A, new Date(2026, 9, 15, 8), 20, 2000, { startUnits: 0, endUnits: 100000 });
    const corrected = { ...raw, adjustment: { unitsDelta: -2000, activeMsDelta: -1200000 } };
    expect(normalizeSession(corrected)).toEqual(corrected);
    expect(summarize([corrected], null)).toMatchObject({
      activeMs: 0,
      characters: 0,
      sessions: 1,
      started: 1,
      finished: 1,
    });
    expect(calendarMonth([corrected], now)[14].level).toBe(0);
    expect(currentStreak([corrected], now)).toBe(0);
    const increased = { ...raw, adjustment: { unitsDelta: 4000, activeMsDelta: 2400000 } };
    for (const range of ["today", "month", "all"] as const) {
      const summary = summarize([increased], rangePeriods(range, now).current);
      expect(summary).toMatchObject({ characters: 6000, activeMs: 3600000 });
      expect(speed(summary.characters, summary.characterMs)).toBe(6000);
    }
    expect(calendarMonth([increased], now)[14].level).toBe(4);
    expect(
      normalizeSession({ ...raw, adjustment: { unitsDelta: 1.5, activeMsDelta: 0 } }),
    ).toBeNull();
  });
  it("summarizes a range by local start day, with speed, books started and finished", () => {
    const sessions = [
      session(A, new Date(2026, 8, 30, 23, 50), 30, 9_000),
      session(A, new Date(2026, 9, 1, 8), 60, 18_000, { startUnits: 0, endUnits: 18_000 }),
      session(B, new Date(2026, 9, 15, 7), 20, 2_000, {
        unit: "words",
        startUnits: 98_000,
        endUnits: 100_000,
      }),
      session(A, new Date(2026, 9, 15, 20), 10, 3_000),
    ];
    const month = summarize(sessions, rangePeriods("month", now).current);
    expect(month).toMatchObject({
      activeMs: 90 * 60_000,
      sessions: 3,
      characters: 21_000,
      words: 2_000,
      started: 1,
      finished: 1,
    });
    expect(month.books.map((book) => [book.bookId, book.unitsRead])).toEqual([
      [A, 21_000],
      [B, 2_000],
    ]);
    expect(speed(month.characters, month.characterMs)).toBe(18_000);
    expect(speed(month.words, month.wordMs)).toBe(6_000);
    expect(speed(10, 59_000)).toBeNull();
    const previous = summarize(sessions, rangePeriods("month", now).previous);
    expect(previous).toMatchObject({ sessions: 1, characters: 9_000 });
    const today = summarize(sessions, rangePeriods("today", now).current);
    expect(today).toMatchObject({ sessions: 2, characters: 3_000, words: 2_000 });
    expect(summarize(sessions, rangePeriods("all", now).current).sessions).toBe(4);
    // A book marked unread since no longer counts as finished by its earlier sessions.
    const unread = sessions.map((entry) => ({ ...entry, finishCleared: entry.bookId === B }));
    expect(summarize(unread, rangePeriods("month", now).current).finished).toBe(0);
  });

  it("builds the month's calendar, heat levels and streaks", () => {
    const sessions = [
      session(A, new Date(2026, 9, 12, 9), 5, 100),
      session(A, new Date(2026, 9, 13, 9), 20, 100),
      session(A, new Date(2026, 9, 14, 9), 45, 100),
      session(A, new Date(2026, 9, 14, 21), 30, 100),
      session(A, new Date(2026, 9, 3, 9), 61, 100),
    ];
    const days = calendarMonth(sessions, now);
    expect(days).toHaveLength(31);
    expect(days[0].date.getDay()).toBe(4);
    expect(days.map((day) => day.level).slice(11, 15)).toEqual([1, 2, 4, 0]);
    expect(days[2].level).toBe(4);
    expect([0, 1, 14 * 60_000, 15 * 60_000, 59 * 60_000, 60 * 60_000].map(heatLevel)).toEqual([
      0, 1, 1, 2, 3, 4,
    ]);
    // Today has no reading yet, so the streak runs up to yesterday.
    expect(currentStreak(sessions, now)).toBe(3);
    expect(currentStreak(sessions, new Date(2026, 9, 17))).toBe(0);
    expect(bestStreakInMonth(sessions, now)).toBe(3);
  });

  it("describes the Library: overview, languages and completion order", () => {
    const book = (id: string, extra: Partial<LibraryBook>): LibraryBook => ({
      id,
      title: id,
      author: null,
      fileName: `${id}.epub`,
      importedAt: "2026-01-01T00:00:00Z",
      availability: "available",
      hasCover: false,
      ...extra,
    });
    const books = [
      book("ja1", { language: "ja", characters: 300_000 }),
      book("ja2", {
        language: "ja-JP",
        characters: 100_000,
        progress: { unit: "characters", current: 100_000, total: 100_000 },
      }),
      book("zh", { language: "zh-TW", characters: 100_000, importedAt: "2026-10-03T00:00:00Z" }),
      book("en1", {
        language: "en",
        progress: { unit: "words", current: 10, total: 50_000 },
      }),
      book("en2", { language: "en", words: 20_000 }),
      book("none", {}),
    ];
    expect(libraryOverview(books, now)).toEqual({
      books: 6,
      addedThisMonth: 1,
      cjkCharacters: 500_000,
      words: 70_000,
      wordBooks: 3,
      countedWordBooks: 2,
      completed: 1,
    });
    const languages = languageBreakdown(books);
    expect(languages.cjk.map((share) => [share.key, share.books, share.characters])).toEqual([
      ["ja", 2, 400_000],
      ["zh", 1, 100_000],
    ]);
    expect(languages.other.map((share) => [share.label, share.books])).toEqual([
      ["English", 2],
      ["Unknown language", 1],
    ]);
    expect(completionOrder(books).map((entry) => [entry.book.id, entry.status])).toEqual([
      ["ja2", "completed"],
      ["en1", "reading"],
      ["ja1", "not-started"],
      ["zh", "not-started"],
      ["en2", "not-started"],
      ["none", "not-started"],
    ]);
  });

  it("accepts only well-formed stored sessions", () => {
    const valid = session(A, now, 10, 100);
    expect(normalizeSession(valid)).toEqual(valid);
    for (const invalid of [
      null,
      { ...valid, bookId: "C:/private/a.epub" },
      { ...valid, id: 7 },
      { ...valid, unit: "pages" },
      { ...valid, activeMs: valid.endedAt - valid.startedAt + 1 },
      { ...valid, endedAt: valid.startedAt - 1 },
      { ...valid, unitsRead: -1 },
      { ...valid, unitsRead: 1.5 },
      { ...valid, totalUnits: 0 },
      { ...valid, endUnits: valid.totalUnits + 1 },
    ])
      expect(normalizeSession(invalid)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import type { StoredReadingSession } from "../statistics/statisticsApi";
import { readingStats } from "./readingStats";

const A = "11111111-1111-4111-8111-111111111111";
const LIVE = "00000000-0000-4000-8000-000000000009";

function stored(id: string, day: number, minutes: number, units: number): StoredReadingSession {
  const startedAt = +new Date(2026, 9, day, 20);
  return {
    bookId: A,
    id,
    startedAt,
    endedAt: startedAt + minutes * 60_000,
    activeMs: minutes * 60_000,
    unit: "characters",
    unitsRead: units,
    startUnits: 0,
    endUnits: units,
    totalUnits: 100_000,
    bookTitle: null,
    finishCleared: false,
  };
}

describe("Reader statistics", () => {
  it("adds the live session to the book's saved ones and times the rest at each speed", () => {
    const first = stored("00000000-0000-4000-8000-000000000001", 10, 60, 12_000);
    const savedLive = {
      ...stored(LIVE, 11, 10, 1000),
      adjustment: { unitsDelta: 0, activeMsDelta: 60_000 },
    };
    const live = {
      readingMs: 30 * 60_000,
      unitsRead: 9000,
      session: { ...savedLive, activeMs: 30 * 60_000, unitsRead: 9000 },
    };
    const stats = readingStats([first, savedLive], live, {
      unit: "characters",
      current: 21_000,
      total: 39_000,
    });
    expect(stats.session).toEqual({ readingMs: 1_800_000, unitsRead: 9000, speed: 18_000 });
    // The live session replaces its last save and keeps the minute added in Statistics.
    expect(stats.book).toEqual({
      readingMs: 91 * 60_000,
      unitsRead: 21_000,
      sessions: 2,
      days: 2,
      speed: Math.round(21_000 / (91 / 60)),
      percent: 53,
    });
    expect(stats.left).toBe(18_000);
    expect(stats.atSessionSpeed).toBe(3_600_000);
    expect(stats.atBookSpeed).toBe(Math.round((18_000 / stats.book.speed!) * 3_600_000));
  });

  it("has no speed or time left under a minute read, and counts only the book's unit", () => {
    const words = {
      ...stored("00000000-0000-4000-8000-000000000001", 10, 60, 500),
      unit: "words" as const,
    };
    const stats = readingStats(
      [words],
      { readingMs: 30_000, unitsRead: 100, session: null },
      {
        unit: "characters",
        current: 100,
        total: 100,
      },
    );
    expect(stats.session.speed).toBeNull();
    expect(stats.book).toMatchObject({
      readingMs: 3_600_000,
      unitsRead: 0,
      speed: null,
      percent: 100,
    });
    expect([stats.left, stats.atSessionSpeed, stats.atBookSpeed]).toEqual([0, null, null]);
  });
});

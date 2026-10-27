import { describe, expect, it } from "vitest";

import {
  formatDuration,
  formatDurationSeconds,
  formatReadingSpeed,
  maxReadStep,
  minRecordedMs,
  ReadingSessionTracker,
  type SessionOptions,
} from "./readingSession";

const id = "33333333-3333-4333-8333-333333333333";

function tracker(start = 1_790_000_000_000, options: SessionOptions = {}) {
  let now = start;
  const session = new ReadingSessionTracker(() => now, id, options);
  return {
    session,
    advance(ms: number, visible = true) {
      // Ticks every second, as the Reader does.
      for (let left = ms; left > 0; left -= 1000) {
        now += Math.min(1000, left);
        session.tick(visible);
      }
    },
    jumpClock(ms: number) {
      now += ms;
    },
  };
}

const at = (current: number, total = 100_000) => ({ unit: "characters" as const, current, total });

describe("reading session tracker", () => {
  it("counts visible time and excludes hidden time", () => {
    const { session, advance } = tracker();
    advance(60_000);
    expect(session.readingMs).toBe(60_000);
    advance(10_000, false);
    expect(session.readingMs).toBe(60_000);
    advance(10_000);
    expect(session.readingMs).toBe(70_000);
  });

  it("drops the stretch without progress past the idle limit and counts again on reading", () => {
    const idleLimitMs = 5 * 60_000;
    const { session, advance } = tracker(1_790_000_000_000, { idleLimitMs });
    session.progress(at(1_000), true);
    advance(60_000);
    session.progress(at(1_600), false);
    // Away from the book: the time since the last forward move counts until the limit...
    advance(idleLimitMs);
    expect(session.readingMs).toBe(60_000 + idleLimitMs);
    // ...and past it, that whole stretch is dropped, so the speed does not fall.
    advance(1_000);
    expect(session.readingMs).toBe(60_000);
    const speed = session.readingSpeed!.perHour;
    advance(30 * 60_000);
    expect(session.readingMs).toBe(60_000);
    expect(session.readingSpeed!.perHour).toBe(speed);
    expect(session.record()).toMatchObject({ activeMs: 60_000, unitsRead: 600 });
    const { startedAt, endedAt } = session.record()!;
    expect(endedAt - startedAt).toBe(60_000);
    // Reading forward again counts from then on.
    session.progress(at(1_900), false);
    advance(20_000);
    session.progress(at(2_100), false);
    expect(session.readingMs).toBe(80_000);
    expect(session.record()).toMatchObject({ activeMs: 80_000, unitsRead: 1_100 });
  });

  it("does not count hidden time toward the idle limit, and 0 never stops", () => {
    const idleLimitMs = 60_000;
    const { session, advance } = tracker(1_790_000_000_000, { idleLimitMs });
    session.progress(at(0), true);
    advance(50_000);
    advance(10 * 60_000, false);
    advance(5_000);
    expect(session.readingMs).toBe(55_000);
    const never = tracker(1_790_000_000_000, { idleLimitMs: 0 });
    never.advance(60 * 60_000);
    expect(never.session.readingMs).toBe(60 * 60_000);
  });

  it("keeps the time before a pause even without progress", () => {
    const { session, advance } = tracker(1_790_000_000_000, { idleLimitMs: 60_000 });
    session.progress(at(0), true);
    advance(50_000);
    session.pause();
    session.resume();
    advance(50_000);
    expect(session.readingMs).toBe(100_000);
  });

  it("does not count a long gap between ticks, such as a suspended timer", () => {
    const { session, advance, jumpClock } = tracker();
    advance(5_000);
    jumpClock(10 * 60_000);
    session.tick(true);
    expect(session.readingMs).toBe(5_000);
  });

  it("counts forward reading once, restarts after jumps and ignores implausible steps", () => {
    const { session, advance } = tracker();
    session.progress(at(1_000), true);
    session.progress(at(1_400), false);
    session.progress(at(1_200), false);
    // Reading the same pages again counts nothing new.
    session.progress(at(1_400), false);
    session.progress(at(1_700), false);
    advance(minRecordedMs);
    expect(session.record()).toMatchObject({ unitsRead: 700, startUnits: 1_000, endUnits: 1_700 });
    // A contents jump forward, then reading on from there.
    session.progress(at(6_000), true);
    session.progress(at(6_300), false);
    // A scrollbar drag across the book is not reading.
    session.progress(at(6_300 + maxReadStep + 1), false);
    session.progress(at(6_300 + maxReadStep + 101), false);
    expect(session.record()).toMatchObject({
      id,
      unit: "characters",
      unitsRead: 1_100,
      startUnits: 1_000,
      endUnits: 6_300 + maxReadStep + 101,
      totalUnits: 100_000,
    });
  });

  it("records only a counted book that was read or open for a while, within its span", () => {
    const { session, advance } = tracker();
    advance(minRecordedMs);
    // Nothing counted yet: the book has no units to record.
    expect(session.record()).toBeNull();
    session.progress(at(0), true);
    const recorded = session.record()!;
    expect(recorded.activeMs).toBe(minRecordedMs);
    expect(recorded.endedAt - recorded.startedAt).toBeGreaterThanOrEqual(recorded.activeMs);

    const short = tracker();
    short.session.progress(at(0), true);
    short.advance(minRecordedMs - 1000);
    expect(short.session.record()).toBeNull();
    short.session.progress(at(10), false);
    expect(short.session.record()).toMatchObject({ unitsRead: 10 });
  });

  it("ignores malformed progress", () => {
    const { session } = tracker();
    session.progress(at(5, 0), true);
    session.progress(at(-1), true);
    session.progress(at(200_000), true);
    expect(session.record()).toBeNull();
  });
});

describe("session reading speed", () => {
  it("is units read per active minute once a minute was read, in the book's unit", () => {
    const { session, advance } = tracker();
    expect(session.readingSpeed).toBeNull();
    session.progress(at(1_000), true);
    advance(30_000);
    session.progress(at(1_300), false);
    advance(29_000);
    expect(session.readingSpeed).toBeNull();
    advance(1_000);
    expect(session.readingSpeed).toEqual({ perHour: 18_000, unit: "characters" });
    session.progress(at(1_600), false);
    advance(30_000);
    expect(session.readingSpeed).toEqual({ perHour: 24_000, unit: "characters" });
    // A jump counts no reading, so the speed falls with the time spent after it.
    session.progress(at(50_000), true);
    advance(30_000);
    expect(session.readingSpeed).toEqual({ perHour: 18_000, unit: "characters" });

    const words = tracker();
    words.session.progress({ unit: "words", current: 0, total: 9_000 }, true);
    words.advance(120_000);
    words.session.progress({ unit: "words", current: 480, total: 9_000 }, false);
    expect(words.session.readingSpeed).toEqual({ perHour: 14_400, unit: "words" });
  });

  it("formats speeds as the reader shows them", () => {
    expect(formatReadingSpeed({ perHour: 31_200, unit: "characters" })).toBe("31,200 Ch./h");
    expect(formatReadingSpeed({ perHour: 14_400, unit: "words" })).toBe("14,400 Wo./h");
  });
});

describe("session start modes and the jump limit", () => {
  it("starts a first-read session at the first forward move, where that move began", () => {
    const start = 1_790_000_000_000;
    const { session, advance } = tracker(start, { start: "read" });
    session.progress(at(1_000), true);
    advance(60_000);
    expect(session.counting).toBe(false);
    expect(session.readingMs).toBe(0);
    expect(session.record()).toBeNull();
    // Going back counts nothing and does not start it.
    session.progress(at(800), false);
    expect(session.counting).toBe(false);
    session.progress(at(1_200), false);
    expect(session.counting).toBe(true);
    advance(30_000);
    expect(session.record()).toMatchObject({
      startedAt: start + 60_000,
      startUnits: 800,
      unitsRead: 200,
      activeMs: 30_000,
    });
  });

  it("counts a manual session only between resume and pause", () => {
    const { session, advance } = tracker(1_790_000_000_000, { start: "manual" });
    session.progress(at(0), true);
    session.progress(at(500), false);
    advance(30_000);
    expect(session.record()).toBeNull();
    session.resume();
    session.progress(at(900), false);
    advance(30_000);
    session.pause();
    // Reading while paused is skipped, not counted later.
    session.progress(at(1_500), false);
    advance(30_000);
    session.resume();
    session.progress(at(1_600), false);
    advance(10_000);
    expect(session.record()).toMatchObject({ unitsRead: 500, activeMs: 40_000, startUnits: 500 });
  });

  it("reports a move past the jump limit either way and counts none of it", () => {
    const { session } = tracker(1_790_000_000_000, { jumpLimit: 1_000 });
    session.progress(at(10_000), true);
    expect(session.progress(at(11_000), false)).toBeUndefined();
    expect(session.progress(at(12_001), false)).toBe("jump");
    expect(session.progress(at(12_500), true)).toBeUndefined();
    expect(session.progress(at(11_000), true)).toBe("jump");
    // The jump target is not the session's end.
    expect(session.record()).toMatchObject({ unitsRead: 1_000, endUnits: 12_500 });
    expect(session.progress(at(99_000), false)).toBe("jump");
    expect(session.record()).toMatchObject({ endUnits: 12_500 });
    // 0 never reports a jump.
    const unlimited = tracker();
    unlimited.session.progress(at(0), true);
    expect(unlimited.session.progress(at(90_000), true)).toBeUndefined();
  });
});

describe("formatDurationSeconds", () => {
  it("shows minutes and seconds, then hours with padded minutes and seconds", () => {
    expect(formatDurationSeconds(0)).toBe("0m 00s");
    expect(formatDurationSeconds(5_999)).toBe("0m 05s");
    expect(formatDurationSeconds(12 * 60_000 + 5_000)).toBe("12m 05s");
    expect(formatDurationSeconds(62 * 60_000 + 5_000)).toBe("1h 02m 05s");
    expect(formatDurationSeconds(-5)).toBe("0m 00s");
  });
});

describe("formatDuration", () => {
  it("shows minutes, then hours with padded minutes", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(1)).toBe("<1m");
    expect(formatDuration(59_999)).toBe("<1m");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(45 * 60_000)).toBe("45m");
    expect(formatDuration(125 * 60_000)).toBe("2h 05m");
    expect(formatDuration(-5)).toBe("0m");
  });
});

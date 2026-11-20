import { dayKey, speed } from "../statistics/statistics";
import { sessionMeasurements, type StoredReadingSession } from "../statistics/statisticsApi";
import type { ReadingSession } from "../statistics/readingSession";
import type { ReaderBookProgress, ReaderProgressUnit } from "./renderer";

/** The session being read, as the Reader counts it now. */
export interface LiveReading {
  readingMs: number;
  unitsRead: number;
  /** The session as it would be saved, or null while it is too short to record. */
  session: ReadingSession | null;
}

/** What the Reader's status pill shows on hover: this session, the whole book, and what is left. */
export interface ReadingStats {
  unit: ReaderProgressUnit;
  session: { readingMs: number; unitsRead: number; speed: number | null };
  book: {
    readingMs: number;
    unitsRead: number;
    sessions: number;
    days: number;
    speed: number | null;
    percent: number;
  };
  /** Units left to the end, and the time they take at each speed (null without one). */
  left: number;
  atSessionSpeed: number | null;
  atBookSpeed: number | null;
}

function timeFor(units: number, perHour: number | null): number | null {
  if (perHour === null || perHour <= 0) return null;
  return Math.round((units / perHour) * 3_600_000);
}

/**
 * The book's totals from its saved sessions and the live one: the live session replaces its
 * own last save, keeping any correction made to it in Statistics.
 */
export function readingStats(
  stored: readonly StoredReadingSession[],
  live: LiveReading,
  progress: Pick<ReaderBookProgress, "unit" | "current" | "total">,
): ReadingStats {
  const { unit } = progress;
  const sessions = new Map<string, ReadingSession & { units: number; ms: number }>();
  for (const session of stored) {
    const measured = sessionMeasurements(session);
    sessions.set(session.id, { ...session, units: measured.unitsRead, ms: measured.activeMs });
  }
  if (live.session) {
    const saved = stored.find((session) => session.id === live.session!.id);
    const adjustment = saved?.adjustment ?? { unitsDelta: 0, activeMsDelta: 0 };
    sessions.set(live.session.id, {
      ...live.session,
      units: Math.max(0, live.session.unitsRead + adjustment.unitsDelta),
      ms: Math.max(0, live.session.activeMs + adjustment.activeMsDelta),
    });
  }
  let readingMs = 0;
  let unitsRead = 0;
  let unitMs = 0;
  const days = new Set<string>();
  let counted = 0;
  for (const session of sessions.values()) {
    // A session emptied by an idle stop read nothing; one corrected to nothing still counts.
    if (session.activeMs <= 0 && session.unitsRead <= 0 && session.ms <= 0 && session.units <= 0)
      continue;
    counted += 1;
    readingMs += session.ms;
    days.add(dayKey(new Date(session.startedAt)));
    if (session.unit !== unit) continue;
    unitsRead += session.units;
    unitMs += session.ms;
  }
  const sessionSpeed = speed(live.unitsRead, live.readingMs);
  const bookSpeed = speed(unitsRead, unitMs);
  const left = Math.max(0, progress.total - progress.current);
  return {
    unit,
    session: { readingMs: live.readingMs, unitsRead: live.unitsRead, speed: sessionSpeed },
    book: {
      readingMs,
      unitsRead,
      sessions: counted,
      days: days.size,
      speed: bookSpeed,
      // As the footer shows it.
      percent:
        progress.total > 0
          ? Math.floor((Math.min(progress.current, progress.total) / progress.total) * 100)
          : 0,
    },
    left,
    atSessionSpeed: timeFor(left, sessionSpeed),
    atBookSpeed: timeFor(left, bookSpeed),
  };
}

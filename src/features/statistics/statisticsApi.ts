import { i18n } from "../../i18n/i18n";
import { invoke, isTauri } from "@tauri-apps/api/core";

import type { ReadingSession } from "./readingSession";

/** A recorded session with the catalog ID of its book. */
export interface StoredReadingSession extends ReadingSession {
  bookId: string;
  /** The book's title when the session was last saved, for books since removed. */
  bookTitle: string | null;
  /** The book was marked unread since, so this session no longer finishes it. */
  finishCleared: boolean;
  adjustment?: { unitsDelta: number; activeMsDelta: number };
}

/** One script's kanji across the Library's Japanese or Chinese books. */
export interface LibraryKanji {
  language: "ja" | "zh";
  /** Books of this language with counted kanji. */
  books: number;
  kanji: KanjiEntry[];
}

interface KanjiEntry {
  character: string;
  /** Books containing it. */
  books: number;
  /** Whether a completed book contains it. */
  completed: boolean;
}

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const maxDailyUnits = 1_000_000_000;
export const maxDailyMs = 86_400_000;

export interface DailyActivityEdit {
  bookId: string;
  dayStart: number;
  dayEnd: number;
  unit: StoredReadingSession["unit"];
  unitsRead: number;
  activeMs: number;
  expectedUnits: number;
  expectedActiveMs: number;
  expectedSessions: number;
}

export function validDailyEdit(edit: DailyActivityEdit): boolean {
  return (
    uuid.test(edit.bookId) &&
    (edit.unit === "characters" || edit.unit === "words") &&
    [
      edit.dayStart,
      edit.dayEnd,
      edit.unitsRead,
      edit.activeMs,
      edit.expectedUnits,
      edit.expectedActiveMs,
      edit.expectedSessions,
    ].every(count) &&
    edit.dayEnd > edit.dayStart &&
    edit.dayEnd - edit.dayStart >= 23 * 3_600_000 &&
    edit.dayEnd - edit.dayStart <= 25 * 3_600_000 &&
    edit.unitsRead <= maxDailyUnits &&
    edit.activeMs <= maxDailyMs &&
    edit.expectedSessions > 0
  );
}

/** The day's reading changed since the editor opened; reopening it shows the current amounts. */
export class DailyActivityConflict extends Error {}

export async function editDailyActivity(edit: DailyActivityEdit): Promise<StoredReadingSession[]> {
  if (!validDailyEdit(edit)) throw new Error(i18n().t("dailyEdit.invalid"));
  if (!isTauri()) throw new Error(i18n().t("statistics.desktopOnly"));
  const result = await invoke<{ status: string; sessions: unknown }>("edit_daily_activity", {
    edit,
  });
  if (result.status !== "saved") {
    if (result.status === "conflict")
      throw new DailyActivityConflict(i18n().t("dailyEdit.conflict"));
    throw new Error(i18n().t("dailyEdit.saveFailed"));
  }
  if (!Array.isArray(result.sessions)) throw new Error(i18n().t("dailyEdit.reloadFailed"));
  return result.sessions.flatMap((value) => normalizeSession(value) ?? []);
}

/** Original checkpoints stay separate from the corrected measurements. New reading adds on. */
export function sessionMeasurements(session: StoredReadingSession): {
  unitsRead: number;
  activeMs: number;
} {
  return {
    unitsRead: Math.max(
      0,
      Math.min(maxDailyUnits, session.unitsRead + (session.adjustment?.unitsDelta ?? 0)),
    ),
    activeMs: Math.max(
      0,
      Math.min(maxDailyMs, session.activeMs + (session.adjustment?.activeMsDelta ?? 0)),
    ),
  };
}

/** Accepts only a well-formed stored session; anything else is left out. */
export function normalizeSession(value: unknown): StoredReadingSession | null {
  if (!value || typeof value !== "object") return null;
  const session = value as Record<string, unknown>;
  const { bookId, id, startedAt, endedAt, activeMs, unit, bookTitle, finishCleared } = session;
  const { unitsRead, startUnits, endUnits, totalUnits } = session;
  if (typeof bookId !== "string" || !uuid.test(bookId)) return null;
  if (typeof id !== "string" || !uuid.test(id)) return null;
  if (unit !== "characters" && unit !== "words") return null;
  if (![startedAt, endedAt, activeMs, unitsRead, startUnits, endUnits, totalUnits].every(count))
    return null;
  const numbers = { startedAt, endedAt, activeMs, unitsRead, startUnits, endUnits, totalUnits };
  const n = numbers as Record<keyof typeof numbers, number>;
  if (n.endedAt < n.startedAt || n.activeMs > n.endedAt - n.startedAt) return null;
  if (n.totalUnits < 1 || n.startUnits > n.totalUnits || n.endUnits > n.totalUnits) return null;
  const adjustment = session.adjustment as StoredReadingSession["adjustment"];
  if (
    adjustment !== undefined &&
    (!adjustment ||
      !Number.isSafeInteger(adjustment.unitsDelta) ||
      Math.abs(adjustment.unitsDelta) > maxDailyUnits ||
      !Number.isSafeInteger(adjustment.activeMsDelta) ||
      Math.abs(adjustment.activeMsDelta) > maxDailyMs)
  )
    return null;
  return {
    bookId,
    id,
    unit,
    ...n,
    bookTitle: typeof bookTitle === "string" && bookTitle.trim() ? bookTitle : null,
    finishCleared: finishCleared === true,
    ...(adjustment
      ? {
          adjustment: {
            unitsDelta: adjustment.unitsDelta,
            activeMsDelta: adjustment.activeMsDelta,
          },
        }
      : {}),
  };
}

export async function listReadingSessions(): Promise<StoredReadingSession[]> {
  if (!isTauri()) throw new Error(i18n().t("statistics.desktopOnly"));
  const listed = await invoke<unknown>("list_reading_sessions");
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((value) => normalizeSession(value) ?? []);
}

export async function listLibraryKanji(): Promise<LibraryKanji[]> {
  if (!isTauri()) throw new Error(i18n().t("statistics.desktopOnly"));
  const listed = await invoke<unknown>("list_library_kanji");
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((value): LibraryKanji[] => {
    const group = value as Partial<LibraryKanji> | null;
    if (!group || (group.language !== "ja" && group.language !== "zh")) return [];
    if (!count(group.books) || !Array.isArray(group.kanji)) return [];
    const kanji = group.kanji.filter(
      (entry): entry is KanjiEntry =>
        !!entry &&
        typeof entry.character === "string" &&
        Array.from(entry.character).length === 1 &&
        count(entry.books) &&
        typeof entry.completed === "boolean",
    );
    return [{ language: group.language, books: group.books, kanji }];
  });
}

/** How much Statistics holds, for Settings. */
export interface StatisticsCounts {
  sessions: number;
  /** Sessions of books no longer in the Library, and how many such books. */
  orphanSessions: number;
  orphanBooks: number;
}

export async function getStatisticsCounts(): Promise<StatisticsCounts> {
  if (!isTauri()) throw new Error(i18n().t("statistics.desktopOnly"));
  const counts = await invoke<Partial<StatisticsCounts> | null>("get_statistics_counts");
  return {
    sessions: count(counts?.sessions) ? counts.sessions : 0,
    orphanSessions: count(counts?.orphanSessions) ? counts.orphanSessions : 0,
    orphanBooks: count(counts?.orphanBooks) ? counts.orphanBooks : 0,
  };
}

/**
 * Deletes every recorded session, or with `orphans` only those of books no longer in the
 * Library; resolves how many were deleted. Books, progress and positions are untouched.
 */
export async function deleteReadingSessions(orphans: boolean): Promise<number> {
  if (!isTauri()) throw new Error(i18n().t("statistics.desktopOnly"));
  const deleted = await invoke<unknown>("delete_reading_sessions", { orphans });
  return count(deleted) ? deleted : 0;
}

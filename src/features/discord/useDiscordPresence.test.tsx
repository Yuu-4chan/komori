import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReaderBookProgress } from "../reader/renderer";
import type { ReadingSpeed } from "../statistics/readingSession";
import { reportDiscordReading } from "./discordApi";
import { discordRefreshMs, useDiscordPresence } from "./useDiscordPresence";

vi.mock("./discordApi", async (original) => ({
  ...(await original<typeof import("./discordApi")>()),
  reportDiscordReading: vi.fn(),
}));
const windowVisibility = vi.hoisted(() => ({ listeners: new Set<(visible: boolean) => void>() }));
vi.mock("../../app/windowLifecycle", () => ({
  watchWindowVisibility: (changed: (visible: boolean) => void) => {
    windowVisibility.listeners.add(changed);
    changed(true);
    return () => windowVisibility.listeners.delete(changed);
  },
}));
const setWindowShown = (shown: boolean) =>
  act(() => {
    for (const changed of windowVisibility.listeners) changed(shown);
  });

const book = { id: "11111111-1111-4111-8111-111111111111", title: "吾輩は猫である" };
const progress = (current: number): ReaderBookProgress => ({
  unit: "characters",
  current,
  total: 20_000,
  chapter: { current: 300, total: 1_000 },
});

describe("Discord status from the Reader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("reports the open book, its progress and speed, refreshes the speed, and no book once it closes", () => {
    let speed: ReadingSpeed | null = null;
    const view = renderHook(
      ({ open, at }: { open: typeof book | null; at: ReaderBookProgress | null }) =>
        useDiscordPresence(open, at, () => speed),
      { initialProps: { open: book as typeof book | null, at: null as ReaderBookProgress | null } },
    );
    // Before the book is counted it shows only its title.
    expect(reportDiscordReading).toHaveBeenLastCalledWith({
      book: book.id,
      title: book.title,
      bookProgress: null,
      chapterProgress: null,
      readingSpeed: null,
      position: 0,
    });
    view.rerender({ open: book, at: progress(9_099) });
    expect(reportDiscordReading).toHaveBeenLastCalledWith({
      book: book.id,
      title: book.title,
      bookProgress: "45%",
      chapterProgress: "Chapter 30%",
      readingSpeed: null,
      position: 9_099,
    });
    const reports = vi.mocked(reportDiscordReading).mock.calls.length;
    speed = { perHour: 31_200, unit: "characters" };
    vi.advanceTimersByTime(discordRefreshMs);
    expect(reportDiscordReading).toHaveBeenCalledTimes(reports + 1);
    expect(reportDiscordReading).toHaveBeenLastCalledWith(
      expect.objectContaining({ readingSpeed: "31,200 Ch./h", position: 9_099 }),
    );

    view.rerender({ open: null, at: null });
    expect(reportDiscordReading).toHaveBeenLastCalledWith(null);
    const closed = vi.mocked(reportDiscordReading).mock.calls.length;
    vi.advanceTimersByTime(discordRefreshMs * 2);
    expect(reportDiscordReading).toHaveBeenCalledTimes(closed);

    view.rerender({ open: book, at: progress(20_000) });
    expect(reportDiscordReading).toHaveBeenLastCalledWith(
      expect.objectContaining({ bookProgress: "100%", position: 20_000 }),
    );
    view.rerender({
      open: book,
      at: { ...progress(25_000), unit: "words", chapter: { current: 0, total: 0 } },
    });
    expect(reportDiscordReading).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bookProgress: "100%",
        chapterProgress: null,
      }),
    );
    view.unmount();
    expect(reportDiscordReading).toHaveBeenLastCalledWith(null);
  });

  it("reports no book while the window is in the tray and the book again once it is shown", () => {
    const view = renderHook(() => useDiscordPresence(book, progress(9_099), () => null));
    expect(reportDiscordReading).toHaveBeenLastCalledWith(
      expect.objectContaining({ book: book.id, position: 9_099 }),
    );
    setWindowShown(false);
    expect(reportDiscordReading).toHaveBeenLastCalledWith(null);
    const hidden = vi.mocked(reportDiscordReading).mock.calls.length;
    vi.advanceTimersByTime(discordRefreshMs * 2);
    expect(reportDiscordReading).toHaveBeenCalledTimes(hidden);
    setWindowShown(true);
    expect(reportDiscordReading).toHaveBeenLastCalledWith(
      expect.objectContaining({ book: book.id, position: 9_099 }),
    );
    view.unmount();
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../appearance/AppearanceProvider";
import type { ReadingSession } from "../statistics/readingSession";
import { ReaderShell } from "./ReaderShell";
import type { ReaderBookProgress, ReaderPositionStore, ReaderRendererFactory } from "./renderer";

afterEach(() => vi.useRealTimers());

const progress = (current: number): ReaderBookProgress => ({
  unit: "characters",
  current,
  total: 10_000,
  chapter: { current: 0, total: 0 },
});

/** A Reader whose book opens at 1,000 characters; `move` turns a page to a new position. */
function openBook(preferences: Record<string, unknown>) {
  const book = { publish: (_value: ReaderBookProgress) => {}, next: 1_000 };
  const factory: ReaderRendererFactory = () => ({
    mount: async (...args) => {
      book.publish = (value) => args[6]?.(value);
      book.publish(progress(1_000));
      args[2]({ canAdvance: true, canRetreat: true, forwardArrow: "ArrowRight" });
      return "ready" as const;
    },
    // A page turn lands wherever the test moves next.
    advancePage: vi.fn(async () => book.publish(progress(book.next))),
    retreatPage: vi.fn(async () => {}),
    dispose: vi.fn(),
  });
  const sessions: ReadingSession[] = [];
  const store: ReaderPositionStore = {
    load: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    saveProgress: vi.fn(async () => {}),
    saveSession: vi.fn(async (session: ReadingSession) => {
      sessions.push(session);
    }),
  };
  const view = render(
    <MemoryRouter>
      <AppearanceProvider store={{ load: async () => preferences, save: async () => {} }}>
        <ReaderShell rendererFactory={factory} positionStore={store} />
      </AppearanceProvider>
    </MemoryRouter>,
  );
  const move = async (current: number) => {
    book.next = current;
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
  };
  return { view, sessions, move };
}

describe("Reader sessions", () => {
  it("records active time and forward reading, saving when hidden and on close", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 2, 20, 0, 0));
    let publish: (value: ReaderBookProgress) => void = () => {};
    const advancePage = vi.fn(async () => publish(progress(1_400)));
    const factory: ReaderRendererFactory = () => ({
      mount: async (...args) => {
        publish = (value) => args[6]?.(value);
        publish(progress(1_000));
        args[2]({ canAdvance: true, canRetreat: true, forwardArrow: "ArrowRight" });
        return "ready" as const;
      },
      advancePage,
      retreatPage: vi.fn(async () => {}),
      dispose: vi.fn(),
    });
    const sessions: ReadingSession[] = [];
    const store: ReaderPositionStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      saveProgress: vi.fn(async () => {}),
      saveSession: vi.fn(async (session: ReadingSession) => {
        sessions.push(session);
      }),
    };
    const view = render(
      <MemoryRouter>
        <AppearanceProvider
          store={{
            load: async () => ({ readerShowReadingTime: true, readerShowReadingSpeed: true }),
            save: async () => {},
          }}
        >
          <ReaderShell rendererFactory={factory} positionStore={store} />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Reader ready");
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    screen.getByRole("main").focus();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(advancePage).toHaveBeenCalled();
    expect(screen.getByLabelText(/^Reading time this session: 0m \d\ds$/)).toBeInTheDocument();
    // The speed appears only once a minute was read.
    expect(screen.queryByLabelText(/Reading speed/)).toBeNull();

    // A hidden window adds no time and saves the session so far.
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {});
    expect(sessions.at(-1)).toMatchObject({ unitsRead: 400, startUnits: 1_000, endUnits: 1_400 });
    const hiddenAt = sessions.at(-1)!.activeMs;
    expect(hiddenAt).toBeGreaterThanOrEqual(20_000);
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => vi.advanceTimersByTimeAsync(45_000));
    expect(screen.getByLabelText(/Reading time this session: 1m \d\ds/)).toBeInTheDocument();
    // 400 characters over just over a minute of active reading, per hour.
    expect(
      screen.getByLabelText(/Reading speed this session: 2\d,\d\d\d chars\/h/),
    ).toBeInTheDocument();
    // The speed is the lower footer pill's last group, not part of the upper pill.
    expect(screen.getByRole("group", { name: "Reading speed" }).closest("footer")).not.toBeNull();
    expect(screen.getByRole("group", { name: "Reading status" }).textContent).not.toMatch(/chars/);
    visibility.mockRestore();

    view.unmount();
    await act(async () => {});
    const last = sessions.at(-1)!;
    expect(last.activeMs).toBeGreaterThanOrEqual(hiddenAt + 44_000);
    expect(last.activeMs).toBeLessThan(hiddenAt + 47_000);
    expect(last).toMatchObject({ unit: "characters", unitsRead: 400, totalUnits: 10_000 });
    expect(new Set(sessions.map((session) => session.id)).size).toBe(1);
  });

  it("counts a manual session only while P has started it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 2, 20, 0, 0));
    const { view, sessions, move } = openBook({
      readerShowReadingTime: true,
      statisticsSessionStart: "manual",
    });
    await screen.findByText("Reader ready");
    await screen.findByLabelText("Reading time this session: 0m 00s");
    // No start/pause control is shown: P alone toggles counting.
    expect(screen.queryByRole("button", { name: /reading session/ })).toBeNull();
    await move(1_300);
    await act(async () => vi.advanceTimersByTimeAsync(40_000));
    expect(screen.getByLabelText("Reading time this session: 0m 00s")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("main"), { key: "p" });
    await move(1_500);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    // P while typing in a field does nothing.
    const field = document.createElement("input");
    document.body.append(field);
    fireEvent.keyDown(field, { key: "p" });
    field.remove();
    // P again pauses; reading while paused is not counted.
    fireEvent.keyDown(screen.getByRole("main"), { key: "p" });
    await move(1_900);
    view.unmount();
    await act(async () => {});
    expect(sessions.at(-1)).toMatchObject({ unitsRead: 200, startUnits: 1_300 });
    expect(sessions.at(-1)!.activeMs).toBeGreaterThanOrEqual(10_000);
    expect(sessions.at(-1)!.activeMs).toBeLessThan(13_000);
  });

  it("ends an automatic session at a jump past the limit and starts another on reading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 2, 20, 0, 0));
    const { view, sessions, move } = openBook({ statisticsJumpLimit: 2_000 });
    await screen.findByText("Reader ready");
    await move(1_400);
    // Within the limit: one session.
    await move(3_000);
    await move(8_000);
    const first = sessions.at(-1)!;
    // The session ends where reading was before the jump.
    expect(first).toMatchObject({ unitsRead: 2_000, endUnits: 3_000 });
    // The new session waits for the next forward move.
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(sessions.every((session) => session.id === first.id)).toBe(true);
    await move(8_300);
    view.unmount();
    await act(async () => {});
    const second = sessions.at(-1)!;
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ unitsRead: 300, startUnits: 8_000, endUnits: 8_300 });
  });

  it("records nothing and says so while statistics are off", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { view, sessions, move } = openBook({
      readerShowReadingTime: true,
      readerShowReadingSpeed: true,
      statisticsEnabled: false,
    });
    await screen.findByText("Reader ready");
    await move(1_400);
    await act(async () => vi.advanceTimersByTimeAsync(90_000));
    expect(screen.getByText("Statistics off")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Reading speed/)).toBeNull();
    view.unmount();
    expect(sessions).toEqual([]);
  });
});

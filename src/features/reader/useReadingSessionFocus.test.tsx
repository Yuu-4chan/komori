import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useReadingSession } from "./useReadingSession";
import type { ReaderBookProgress, ReaderRendererFactory } from "./renderer";
import type { ReadingSession } from "../statistics/readingSession";

const native = vi.hoisted(() => ({
  focus: (_event: { payload: boolean }) => {},
  resized: () => {},
  minimized: false,
  initialFocus: true,
  stopFocus: vi.fn(),
  stopResize: vi.fn(),
  probe: null as Promise<boolean> | null,
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: vi.fn(async (fn) => {
      native.focus = fn;
      return native.stopFocus;
    }),
    isFocused: vi.fn(() => native.probe ?? Promise.resolve(native.initialFocus)),
    onResized: vi.fn(async (fn) => {
      native.resized = fn;
      return native.stopResize;
    }),
    isMinimized: vi.fn(async () => native.minimized),
  }),
}));
const factory: ReaderRendererFactory = () => ({
  mount: async () => "ready",
  advancePage: async () => {},
  retreatPage: async () => {},
  dispose: () => {},
});
const progress = (current: number): ReaderBookProgress => ({
  unit: "characters",
  current,
  total: 10000,
  chapter: { current: 0, total: 0 },
});
afterEach(() => {
  vi.useRealTimers();
  native.minimized = false;
  native.initialFocus = true;
  native.probe = null;
  vi.clearAllMocks();
});

it.each(["auto", "manual", "first-read"] as const)(
  "pauses %s statistics on native focus loss, saves immediately and skips background navigation",
  async (start) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 7, 12));
    const save = vi.fn(async (_session: ReadingSession) => {});
    const hook = renderHook(
      ({ current }) =>
        useReadingSession(factory, true, progress(current), false, save, {
          enabled: true,
          start,
          jumpLimit: 2000,
        }),
      { initialProps: { current: 1000 } },
    );
    await act(async () => {});
    if (start === "manual") act(() => hook.result.current.toggle());
    hook.rerender({ current: 1200 });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => {
      vi.advanceTimersByTime(250);
      native.focus({ payload: false });
    });
    expect(hook.result.current.readingMs()).toBe(1250);
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeMs: 1250, unitsRead: 200 }),
    );
    // DOM focus within Komori cannot override the native window's background state.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    hook.rerender({ current: 8000 });
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(hook.result.current.readingMs()).toBe(1250);
    await act(async () => native.focus({ payload: true }));
    hook.rerender({ current: 8100 });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    hook.unmount();
    await act(async () => {});
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeMs: 2250, unitsRead: 300 }),
    );
    expect(new Set(save.mock.calls.map(([session]) => session.id)).size).toBe(1);
    expect(native.stopFocus).toHaveBeenCalledOnce();
  },
);
it("starts unfocused, keeps manual pause across focus changes and ignores a stale initial probe", async () => {
  vi.useFakeTimers();
  native.initialFocus = false;
  let resolve!: (value: boolean) => void;
  native.probe = new Promise((done) => {
    resolve = done;
  });
  const save = vi.fn(async () => {});
  const hook = renderHook(() =>
    useReadingSession(factory, true, progress(1000), false, save, {
      enabled: true,
      start: "manual",
      jumpLimit: 0,
    }),
  );
  await act(async () => {});
  act(() => native.focus({ payload: true }));
  act(() => hook.result.current.toggle());
  await act(async () => {
    resolve(false);
  });
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(hook.result.current.readingMs()).toBe(1000);
  act(() => hook.result.current.toggle());
  await act(async () => {
    native.focus({ payload: false });
    vi.advanceTimersByTime(500);
    native.focus({ payload: true });
  });
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(hook.result.current.state).toBe("paused");
  expect(hook.result.current.readingMs()).toBe(1000);
  hook.unmount();
  await act(async () => {});
});
it("does not count an initially unfocused book or resume while minimized", async () => {
  vi.useFakeTimers();
  native.initialFocus = false;
  const hook = renderHook(() => useReadingSession(factory, true, progress(1000), false));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(hook.result.current.readingMs()).toBe(0);
  await act(async () => {
    native.minimized = true;
    native.resized();
  });
  await act(async () => {
    native.focus({ payload: true });
    vi.advanceTimersByTime(2000);
  });
  expect(hook.result.current.readingMs()).toBe(0);
  await act(async () => {
    native.minimized = false;
    native.resized();
  });
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(hook.result.current.readingMs()).toBe(1000);
  hook.unmount();
  await act(async () => {});
});
it.each(["auto", "first-read"] as const)(
  "P pauses and resumes a %s session, and its pause holds across reading and jumps",
  async (start) => {
    vi.useFakeTimers();
    const save = vi.fn(async (_session: ReadingSession) => {});
    const hook = renderHook(
      ({ current }) =>
        useReadingSession(factory, true, progress(current), false, save, {
          enabled: true,
          start,
          jumpLimit: 2000,
        }),
      { initialProps: { current: 1000 } },
    );
    await act(async () => {});
    hook.rerender({ current: 1100 });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(hook.result.current.state).toBe("counting");
    act(() => hook.result.current.toggle());
    expect(hook.result.current.state).toBe("paused");
    const counted = hook.result.current.readingMs();
    hook.rerender({ current: 1300 });
    hook.rerender({ current: 6000 });
    hook.rerender({ current: 6100 });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(hook.result.current.state).toBe("paused");
    expect(hook.result.current.readingMs()).toBe(counted);
    act(() => hook.result.current.toggle());
    expect(hook.result.current.state).toBe("counting");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(hook.result.current.readingMs()).toBe(counted + 1000);
    hook.unmount();
    await act(async () => {});
  },
);
it("stops counting after the idle minutes without progress and drops that stretch", async () => {
  vi.useFakeTimers();
  const hook = renderHook(
    ({ current }) =>
      useReadingSession(factory, true, progress(current), false, undefined, {
        enabled: true,
        start: "auto",
        jumpLimit: 0,
        idleMinutes: 1,
      }),
    { initialProps: { current: 1000 } },
  );
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  hook.rerender({ current: 1200 });
  await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
  expect(hook.result.current.readingMs()).toBe(10_000);
  hook.unmount();
  await act(async () => {});
});

import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useReadingSession } from "./useReadingSession";
import type { ReaderBookProgress, ReaderRendererFactory } from "./renderer";

vi.mock("../../app/platform", () => ({ isAndroid: true }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
// Android's WebView reports Komori's window as never focused.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: vi.fn(async () => () => {}),
    isFocused: vi.fn(async () => false),
    onResized: vi.fn(async () => () => {}),
    isMinimized: vi.fn(async () => {
      throw new Error("not on Android");
    }),
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
});

it("counts the session while the phone shows the page, and stops while it is hidden", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 3, 12));
  const save = vi.fn(async () => {});
  const hook = renderHook(
    ({ current }) =>
      useReadingSession(factory, true, progress(current), false, save, {
        enabled: true,
        start: "auto",
        jumpLimit: 2000,
      }),
    { initialProps: { current: 1000 } },
  );
  await act(async () => {});
  hook.rerender({ current: 1200 });
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(hook.result.current.readingMs()).toBe(2000);

  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ activeMs: 2000 }));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(hook.result.current.readingMs()).toBe(2000);
  visibility.mockRestore();
  hook.unmount();
});

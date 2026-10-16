import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useReaderMonitor } from "./useReaderMonitor";

const watches = vi.hoisted(() => ({ callbacks: [] as (() => void)[], unlisten: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => {
    const listen = async (callback: () => void) => {
      watches.callbacks.push(callback);
      return watches.unlisten;
    };
    return { onMoved: listen, onResized: listen, onScaleChanged: listen };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  watches.callbacks.length = 0;
  vi.mocked(isTauri).mockReturnValue(true);
});

it("follows native move/scale reporting, ignores stale dimensions and releases subscriptions", async () => {
  let finish!: (size: { width: number; height: number }) => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, unmount } = renderHook(useReaderMonitor);
  vi.mocked(invoke).mockResolvedValue({ width: 7680, height: 4320 });
  await act(async () => watches.callbacks[0]());
  await waitFor(() => expect(result.current).toEqual({ width: 7680, height: 4320 }));
  await act(async () => finish({ width: 1280, height: 720 }));
  expect(result.current?.width).toBe(7680);
  vi.mocked(invoke).mockResolvedValue({ width: 1920, height: 1080 });
  await act(async () => watches.callbacks[2]());
  expect(result.current).toEqual({ width: 1920, height: 1080 });
  expect(invoke).toHaveBeenCalledWith("get_reader_monitor_size");
  unmount();
  await waitFor(() => expect(watches.unlisten).toHaveBeenCalledTimes(3));
});

it("reports unavailable dimensions after a native failure and without a native application", async () => {
  vi.mocked(invoke).mockRejectedValue(Error("unavailable"));
  const first = renderHook(useReaderMonitor);
  await act(async () => {});
  expect(first.result.current).toBeNull();
  first.unmount();
  vi.mocked(isTauri).mockReturnValue(false);
  vi.mocked(invoke).mockClear();
  const second = renderHook(useReaderMonitor);
  expect(second.result.current).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});

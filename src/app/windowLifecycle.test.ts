import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  installWindowLifecycle,
  registerWindowFlush,
  watchWindowVisibility,
} from "./windowLifecycle";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn(async () => true) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

describe("Native close handshake", () => {
  beforeEach(() => vi.clearAllMocks());
  it("pauses hidden time and waits for every pending write before acknowledging close; showing resumes", async () => {
    const stop = installWindowLifecycle();
    const calls = vi.mocked(listen).mock.calls;
    const closing = calls.find(([event]) => event === "komori-window-closing")![1];
    const shown = calls.find(([event]) => event === "komori-window-visible")![1];
    const visibility = vi.fn();
    const stopVisibility = watchWindowVisibility(visibility);
    let finish!: () => void;
    const stopFlush = registerWindowFlush(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const stopFailed = registerWindowFlush(async () => {
      throw Error("failed write");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stopUnsaved = registerWindowFlush(async () => false);
    const pending = closing({ payload: "native-token" } as never);
    await Promise.resolve();
    expect(visibility).toHaveBeenLastCalledWith(false);
    expect(invoke).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(invoke).toHaveBeenCalledWith("finish_window_close", { token: "native-token" });
    // A failed flush is logged without details; the window still closes.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]).toEqual([
      "Komori could not save every change before the window closed.",
    ]);
    stopUnsaved();
    stopFailed();
    stopFlush();
    warn.mockClear();
    await closing({ payload: "saved-token" } as never);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    shown({ payload: true } as never);
    expect(visibility).toHaveBeenLastCalledWith(true);
    stopVisibility();
    stop();
    vi.mocked(invoke).mockClear();
    await closing({ payload: "after-dispose" } as never);
    expect(invoke).not.toHaveBeenCalled();
  });
});

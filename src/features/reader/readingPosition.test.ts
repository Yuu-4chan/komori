import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  normalizeReaderLocator,
  ReaderPositionSaver,
  readerPositionStore,
} from "./readingPosition";
import type { ReaderLocator } from "./renderer";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));

const id = "11111111-1111-4111-8111-111111111111";
const invokeMock = vi.mocked(invoke);
const at = (progress: number): ReaderLocator => ({
  spineIndex: 2,
  sectionKey: "0a1b2c3d",
  progress,
});

describe("reading position service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTauri).mockReturnValue(true);
  });

  it("accepts only well-formed Komori locators", () => {
    expect(normalizeReaderLocator(at(0.5))).toEqual(at(0.5));
    expect(normalizeReaderLocator({ spineIndex: 0, sectionKey: null, progress: 0 })).toEqual({
      spineIndex: 0,
      progress: 0,
    });
    for (const invalid of [
      null,
      "epubcfi(/6/4!/4/2)",
      { spineIndex: "2", progress: 0.5 },
      { spineIndex: -1, progress: 0.5 },
      { spineIndex: 1.5, progress: 0.5 },
      { spineIndex: 2, progress: 1.2 },
      { spineIndex: 2, progress: Number.NaN },
      { spineIndex: 2, sectionKey: "../Text/one.xhtml", progress: 0.5 },
    ])
      expect(normalizeReaderLocator(invalid)).toBeNull();
  });

  it("loads by catalog ID and treats invalid tokens or native failures as no position", async () => {
    const store = readerPositionStore(id);
    invokeMock.mockResolvedValueOnce(at(0.25));
    expect(await store.load()).toEqual(at(0.25));
    expect(invokeMock).toHaveBeenLastCalledWith("get_reading_position", { id });
    invokeMock.mockResolvedValueOnce({ cfi: "epubcfi(/6/4!/4)" });
    expect(await store.load()).toBeNull();
    invokeMock.mockRejectedValueOnce(Error("C:/private/book.epub"));
    expect(await store.load()).toBeNull();
    vi.mocked(isTauri).mockReturnValue(false);
    expect(await store.load()).toBeNull();
  });

  it("saves valid positions and reports native failures to the saver", async () => {
    const store = readerPositionStore(id);
    invokeMock.mockRejectedValueOnce(Error("storage"));
    await expect(store.save(at(0.5))).rejects.toThrow("storage");
    expect(invokeMock).toHaveBeenCalledWith("save_reading_position", { id, position: at(0.5) });
    invokeMock.mockRejectedValueOnce(Error("storage"));
    await expect(
      store.saveProgress!({ unit: "characters", current: 5, total: 10 }),
    ).rejects.toThrow("storage");
    invokeMock.mockRejectedValueOnce(Error("storage"));
    await expect(store.saveSession!({} as never)).rejects.toThrow("storage");
    invokeMock.mockClear();
    await store.save({ spineIndex: -1, progress: 0 });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("reading position saver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("writes promptly, then throttles to the latest position in order", async () => {
    const saved: number[] = [];
    let release!: () => void;
    const save = vi.fn(async (locator: ReaderLocator) => {
      if (locator.progress === 0.1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      saved.push(locator.progress);
    });
    const saver = new ReaderPositionSaver({ save }, 1000);
    saver.update(at(0.1));
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledOnce();
    saver.update(at(0.2));
    saver.update(at(0.3));
    await vi.advanceTimersByTimeAsync(999);
    expect(save).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    // The newer write waits for the slow earlier one, so it cannot be overwritten by it.
    expect(save).toHaveBeenCalledOnce();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toEqual([0.1, 0.3]);
    saver.update(at(0.3));
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("flushes a pending position on disposal and ignores later updates", async () => {
    const save = vi.fn(async () => undefined);
    const saver = new ReaderPositionSaver({ save }, 1000);
    saver.update(at(0.1));
    await vi.advanceTimersByTimeAsync(0);
    saver.update(at(0.4));
    await saver.dispose();
    expect(save).toHaveBeenLastCalledWith(at(0.4));
    saver.update(at(0.9));
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed position pending and retries it, even when it repeats", async () => {
    const save = vi
      .fn<(locator: ReaderLocator) => Promise<void>>()
      .mockRejectedValueOnce(Error("busy"))
      .mockResolvedValue(undefined);
    const saver = new ReaderPositionSaver({ save }, 1000);
    saver.update(at(0.1));
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledOnce();
    // The same position again is not skipped: it was never saved.
    saver.update(at(0.1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
    await expect(saver.flush()).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("retries a failed position once on flush and reports whether it was saved", async () => {
    const save = vi
      .fn<(locator: ReaderLocator) => Promise<void>>()
      .mockRejectedValueOnce(Error("busy"))
      .mockRejectedValueOnce(Error("busy"))
      .mockResolvedValue(undefined);
    const saver = new ReaderPositionSaver({ save }, 1000);
    saver.update(at(0.1));
    await vi.advanceTimersByTimeAsync(0);
    // No timer loop retries the failure.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).toHaveBeenCalledOnce();
    await expect(saver.flush()).resolves.toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
    await expect(saver.dispose()).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenLastCalledWith(at(0.1));
  });
});

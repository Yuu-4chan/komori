import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { changeDownloadedFont, importReaderFonts, useReaderFonts } from "./readerFonts";
import { act, renderHook } from "@testing-library/react";
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
it("subscribes before native download, keeps one action pending, cleans failed listeners and can retry/remove", async () => {
  const unlisten = vi.fn();
  vi.mocked(listen).mockResolvedValue(unlisten);
  let fail!: (error: Error) => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  const pending = changeDownloadedFont("zen-old-mincho-700", "download");
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  expect(vi.mocked(listen).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(invoke).mock.invocationCallOrder[0],
  );
  await changeDownloadedFont("literata", "download");
  expect(invoke).toHaveBeenCalledOnce();
  fail(new Error("Offline"));
  await pending;
  expect(unlisten).toHaveBeenCalledOnce();
  vi.mocked(invoke).mockResolvedValue([]);
  await changeDownloadedFont("zen-old-mincho-700", "download");
  expect(unlisten).toHaveBeenCalledTimes(2);
  await changeDownloadedFont("zen-old-mincho-700", "remove");
  expect(invoke).toHaveBeenLastCalledWith("remove_reader_font", { id: "zen-old-mincho-700" });
  await changeDownloadedFont("https://example.test/font", "download");
  expect(invoke).toHaveBeenCalledTimes(3);
});
it("keeps imports pending across consumers, retains safe successful files from a partial result, and removes by hash only", async () => {
  vi.mocked(invoke).mockClear();
  const id = "a".repeat(64);
  let resolve!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const hook = renderHook(() => useReaderFonts());
  let importDone!: Promise<void>;
  act(() => {
    importDone = importReaderFonts();
  });
  expect(hook.result.current.pending).toBe("import");
  await importReaderFonts();
  await changeDownloadedFont("klee-one-600", "download");
  expect(invoke).toHaveBeenCalledOnce();
  await act(async () => {
    resolve({
      failed: 1,
      fonts: [
        {
          id,
          family: "Imported",
          source: "uploaded",
          weight: "400 700",
          style: "normal",
          available: true,
          url: `http://komori-font.localhost/uploaded/${id}.ttf`,
        },
        {
          id: "b".repeat(64),
          family: "Bad URL",
          source: "uploaded",
          weight: "400",
          style: "normal",
          available: true,
          url: "https://example.test/font",
        },
      ],
    });
    await importDone;
  });
  expect(hook.result.current.pending).toBeNull();
  expect(hook.result.current.error).toBe("fonts.importFailed");
  expect(hook.result.current.fonts.filter((f) => f.source === "uploaded")).toEqual([
    expect.objectContaining({ id, family: "Imported" }),
  ]);
  vi.mocked(invoke).mockResolvedValue([]);
  await act(async () => changeDownloadedFont(id, "remove"));
  expect(invoke).toHaveBeenLastCalledWith("remove_reader_font", { id });
  expect(hook.result.current.fonts.some((f) => f.source === "uploaded")).toBe(false);
  hook.unmount();
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke, isTauri } from "@tauri-apps/api/core";
import { prepareReaderContent } from "./contentApi";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

const id = "55be5081-d0b1-4c11-891f-b709b649107b";
const invokeMock = vi.mocked(invoke);
const tauriMock = vi.mocked(isTauri);

describe("Reader content boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMock.mockReturnValue(true);
  });

  it("requests only the selected catalog ID and accepts a scoped URL", async () => {
    const url = `http://komori-book.localhost/${id}/0123456789abcdef`;
    invokeMock.mockResolvedValue({ status: "ready", url });
    expect(await prepareReaderContent(id)).toEqual({ status: "ready", url });
    expect(invokeMock).toHaveBeenCalledWith("prepare_book_content", { id });
  });

  it.each(["unknown", "missing", "unreadable", "invalid", "tooLarge", "failed"] as const)(
    "keeps %s typed and path-safe",
    async (status) => {
      invokeMock.mockResolvedValue({ status, url: "file:///C:/private/book.epub" });
      expect(await prepareReaderContent(id)).toEqual({ status, url: null });
    },
  );

  it("drops an unsafe URL or a native error containing a private path", async () => {
    for (const url of [
      "file:///C:/private/book.epub",
      `http://komori-book.localhost/${id}`,
      `http://komori-book.localhost/${id}/0123456789ABCDEF`,
      `http://komori-book.localhost/${id}/0123456789abcdef/0`,
      `http://komori-book.localhost/../${id}/0123456789abcdef`,
      `http://komori-book.localhost/55be5081-d0b1-4c11-891f-b709b6491070/0123456789abcdef`,
    ]) {
      invokeMock.mockResolvedValueOnce({ status: "ready", url });
      expect(await prepareReaderContent(id)).toEqual({ status: "failed", url: null });
    }
    invokeMock.mockRejectedValueOnce(new Error("C:\\private\\book.epub"));
    expect(await prepareReaderContent(id)).toEqual({ status: "failed", url: null });
  });

  it("has no content URL in a browser-only session", async () => {
    tauriMock.mockReturnValue(false);
    expect(await prepareReaderContent(id)).toEqual({ status: "failed", url: null });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

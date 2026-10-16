import { invoke, isTauri } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";

import { bookmarkStore, normalizeBookmark, normalizeBookmarkLocator } from "./bookmarks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
const id = "11111111-1111-4111-8111-111111111111";
const locator = {
  spineIndex: 2,
  sectionKey: "1234abcd",
  progress: 0.5,
  contentKey: "a".repeat(64),
};
const bookmark = { id, locator, label: "Study", excerpt: "A useful passage" };

describe("bookmark native boundary", () => {
  it("normalizes bounded locators and labels while dropping unexpected data", () => {
    expect(normalizeBookmark({ ...bookmark, source: "private" })).toEqual(bookmark);
    for (const invalid of [
      { ...locator, progress: 2 },
      { ...locator, spineIndex: -1 },
      { ...locator, sectionKey: undefined },
      { ...locator, contentKey: "../path" },
    ])
      expect(normalizeBookmarkLocator(invalid)).toBeNull();
    for (const invalid of [
      { ...bookmark, id: "path" },
      { ...bookmark, label: "a".repeat(81) },
      { ...bookmark, excerpt: "line\nbreak" },
    ])
      expect(normalizeBookmark(invalid)).toBeNull();
  });

  it("binds every operation to the catalog and keeps duplicate identity", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const store = bookmarkStore(id);
    vi.mocked(invoke).mockResolvedValueOnce([bookmark]);
    expect(await store.load()).toEqual([bookmark]);
    vi.mocked(invoke).mockResolvedValueOnce({ status: "duplicate", bookmark });
    expect(await store.create(bookmark, "Second")).toEqual({ duplicate: true, bookmark });
    expect(invoke).toHaveBeenLastCalledWith("create_bookmark", {
      id,
      locator,
      label: "Second",
      excerpt: bookmark.excerpt,
    });
    vi.mocked(invoke).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    await store.rename(id, "Renamed");
    await store.remove(id);
    expect(invoke).toHaveBeenLastCalledWith("remove_bookmark", { id, bookmarkId: id });
  });

  it("reports desktop, load, write and limit failures without native details", async () => {
    const store = bookmarkStore(id);
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(store.load()).rejects.toThrow("desktop app");
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockRejectedValueOnce(Error("C:/private/database"));
    await expect(store.load()).rejects.toThrow("Try again");
    vi.mocked(invoke).mockResolvedValueOnce({ status: "limit" });
    await expect(store.create(bookmark, "")).rejects.toThrow("1,000");
    vi.mocked(invoke).mockResolvedValueOnce(false);
    await expect(store.rename(id, "New")).rejects.toThrow("no longer available");
  });
});

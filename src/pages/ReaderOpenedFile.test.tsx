import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../features/appearance/AppearanceProvider";
import { getLibraryBook } from "../features/library/libraryApi";
import { bookmarkStore } from "../features/reader/bookmarks";
import { epubRendererFactory } from "../features/reader/epubRenderer";
import { noteStore } from "../features/reader/notes";
import { getOpenedFile } from "../features/reader/openedFiles";
import { readerPositionStore } from "../features/reader/readingPosition";
import { rememberLastBook } from "../features/startup/startupApi";
import { ReaderPage } from "./ReaderPage";

vi.mock("../features/library/libraryApi", () => ({ getLibraryBook: vi.fn() }));
vi.mock("../features/reader/openedFiles", () => ({ getOpenedFile: vi.fn() }));
vi.mock("../features/reader/readingPosition", async (original) => ({
  ...(await original<typeof import("../features/reader/readingPosition")>()),
  readerPositionStore: vi.fn(),
}));
vi.mock("../features/reader/bookmarks", async (original) => ({
  ...(await original<typeof import("../features/reader/bookmarks")>()),
  bookmarkStore: vi.fn(),
}));
vi.mock("../features/reader/notes", async (original) => ({
  ...(await original<typeof import("../features/reader/notes")>()),
  noteStore: vi.fn(),
}));
vi.mock("../features/startup/startupApi", async (original) => ({
  ...(await original<typeof import("../features/startup/startupApi")>()),
  rememberLastBook: vi.fn(async () => {}),
}));
vi.mock("../features/reader/epubRenderer", () => ({
  epubRendererFactory: vi.fn(() => () => ({
    mount: async (host: HTMLElement) => {
      host.textContent = "EPUB content";
      return "ready" as const;
    },
    dispose: vi.fn(),
  })),
}));

const FILE = "22222222-2222-4222-8222-222222222222";

function renderRoute(route = `/reader/file/${FILE}`) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AppearanceProvider store={null}>
        <Routes>
          <Route path="/reader/:catalogId" element={<ReaderPage />} />
          <Route path="/reader/file/:fileId" element={<ReaderPage />} />
        </Routes>
      </AppearanceProvider>
    </MemoryRouter>,
  );
}

describe("a book opened from a folder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOpenedFile).mockImplementation(async (id) =>
      id === FILE ? { id, title: "Field Notes", author: "A Walker", language: "ja" } : null,
    );
  });

  it("opens in the Reader without the Library or keeping anything", async () => {
    renderRoute();
    expect(await screen.findByRole("heading", { name: "Field Notes" })).toBeInTheDocument();
    expect(screen.getAllByText("A Walker").length).toBeGreaterThan(0);
    expect(await screen.findByText("Reader ready")).toBeInTheDocument();
    expect(document.querySelector(".reader-viewport__host")).toHaveTextContent("EPUB content");
    expect(epubRendererFactory).toHaveBeenCalledWith(FILE);
    expect(getOpenedFile).toHaveBeenCalledWith(FILE);
    expect(getLibraryBook).not.toHaveBeenCalled();
    // No saved place, bookmarks, notes, last book or reading time.
    expect(readerPositionStore).not.toHaveBeenCalled();
    expect(bookmarkStore).not.toHaveBeenCalled();
    expect(noteStore).not.toHaveBeenCalled();
    expect(rememberLastBook).not.toHaveBeenCalled();
    expect(document.querySelector(".reader-sidebar__cover")).not.toBeInTheDocument();
  });

  it("says a file this run did not open is not found", async () => {
    renderRoute(`/reader/file/${"3".repeat(8)}-3333-4333-8333-333333333333`);
    expect((await screen.findAllByRole("heading", { name: "Book not found" })).length).toBe(2);
    expect(epubRendererFactory).not.toHaveBeenCalled();
    expect(getLibraryBook).not.toHaveBeenCalled();
  });
});

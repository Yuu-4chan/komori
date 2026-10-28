import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";

import {
  importBooks,
  importDroppedBooks,
  onLibraryFileDrag,
  postLibraryFiles,
  listLibrary,
  markBookUnread,
  markBooksCompleted,
  relinkBook,
  removeBook,
  removeBooks,
  resetBookSeries,
  scanLibraryFolders,
  setBookSeries,
} from "../features/library/libraryApi";
import { AppearanceProvider } from "../features/appearance/AppearanceProvider";
import type { AppearancePreferences } from "../features/appearance/appearancePreferences";
import { I18nProvider } from "../i18n/i18n";
import { libraryCache, libraryReturn } from "../features/library/libraryCache";
import { LibraryPage } from "./LibraryPage";
import { AppShell } from "../components/layout/AppShell";
import { guardDocument } from "../app/nativeSurfaces";
import libraryCss from "../styles/library.css?raw";

// The Library's view choices are appearance preferences; nothing is saved in tests.
function renderPage(ui: ReactElement) {
  return render(ui, {
    wrapper: ({ children }) => <AppearanceProvider store={null}>{children}</AppearanceProvider>,
  });
}

vi.mock("../features/library/libraryApi", () => ({
  importBooks: vi.fn(),
  importDroppedBooks: vi.fn(),
  onLibraryFileDrag: vi.fn(() => () => {}),
  postLibraryFiles: vi.fn(() => true),
  listLibrary: vi.fn(),
  relinkBook: vi.fn(),
  markBookUnread: vi.fn(),
  markBooksCompleted: vi.fn(),
  removeBook: vi.fn(),
  removeBooks: vi.fn(),
  setBookSeries: vi.fn(),
  resetBookSeries: vi.fn(),
  scanLibraryFolders: vi.fn(async () => []),
  onLibraryDetailsUpdated: vi.fn(() => () => {}),
}));

const listMock = vi.mocked(listLibrary);
const coverId = "0de3d2ad-4c1b-4d2e-9f00-1234567890ab";
const coverUrl = (revision: number) => `http://komori-cover.localhost/${coverId}/${revision}`;
const importMock = vi.mocked(importBooks);
const relinkMock = vi.mocked(relinkBook);
const removeMock = vi.mocked(removeBook);
const removeManyMock = vi.mocked(removeBooks);

const catalogBook = {
  id: "book-1",
  title: "A Quiet Book",
  author: "An Author",
  fileName: "quiet.epub",
  importedAt: "2026-09-21T00:00:00Z",
  availability: "available" as const,
  hasCover: false,
};

const secondCatalogBook = {
  ...catalogBook,
  id: "book-2",
  title: "Another Quiet Book",
  fileName: "another.epub",
};

function ReaderDestination() {
  const { catalogId } = useParams();
  return <h1>Reader for {catalogId}</h1>;
}

describe("Library page", () => {
  it("shows Windows DOM drag feedback and transfers only EPUB File objects with nested leave cleanup", async () => {
    listMock.mockResolvedValue([catalogBook]);
    const view = renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "A Quiet Book" });
    const epub = new File(["contents"], "BOOK.EPUB", { type: "application/epub+zip" });
    const png = new File(["image"], "image.png", { type: "image/png" });
    const dataTransfer = {
      types: ["Files"],
      items: [{ kind: "file", type: epub.type }],
      files: [epub, png],
      dropEffect: "none",
    };
    fireEvent.dragEnter(window, { dataTransfer });
    fireEvent.dragEnter(window, { dataTransfer });
    expect(screen.getByText("Drop EPUBs to add books")).toBeVisible();
    fireEvent.dragLeave(window);
    expect(screen.getByText("Drop EPUBs to add books")).toBeVisible();
    fireEvent.dragLeave(window);
    expect(document.querySelector(".library-drop-overlay")).toBeNull();
    fireEvent.dragEnter(window, { dataTransfer });
    fireEvent.dragOver(window, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("copy");
    fireEvent.drop(window, { dataTransfer });
    expect(postLibraryFiles).toHaveBeenLastCalledWith([epub]);
    expect(importDroppedBooks).not.toHaveBeenCalled();
    expect(document.querySelector(".library-drop-overlay")).toBeNull();
    const count = vi.mocked(postLibraryFiles).mock.calls.length;
    view.unmount();
    fireEvent.drop(window, { dataTransfer });
    expect(postLibraryFiles).toHaveBeenCalledTimes(count);
  });

  it("reports a failed native File handoff and ignores text-only drags", async () => {
    listMock.mockResolvedValue([catalogBook]);
    vi.mocked(postLibraryFiles).mockReturnValueOnce(false);
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "A Quiet Book" });
    fireEvent.dragEnter(window, { dataTransfer: { types: ["text/plain"] } });
    expect(document.querySelector(".library-drop-overlay")).toBeNull();
    fireEvent.drop(window, {
      dataTransfer: { types: ["Files"], files: [new File(["book"], "one.epub")] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not add dropped files.");
  });

  it("shows native drag feedback, imports a drop once, refreshes results and clears on leave/unmount", async () => {
    let drag!: Parameters<typeof onLibraryFileDrag>[0];
    const stop = vi.fn();
    vi.mocked(onLibraryFileDrag).mockImplementationOnce((callback) => {
      drag = callback;
      return stop;
    });
    vi.mocked(importDroppedBooks).mockResolvedValueOnce({
      canceled: false,
      results: [
        { fileName: "quiet.epub", status: "imported", message: null },
        { fileName: "again.epub", status: "alreadyImported", message: null },
        { fileName: "broken.epub", status: "failed", message: "Invalid EPUB" },
      ],
    });
    const page = renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByText("No books yet");
    act(() => drag({ phase: "enter", accepted: true, dropId: null }));
    expect(screen.getByText("Drop EPUBs to add books")).toBeInTheDocument();
    act(() => drag({ phase: "leave", accepted: false, dropId: null }));
    expect(screen.queryByText("Drop EPUBs to add books")).not.toBeInTheDocument();
    act(() => drag({ phase: "enter", accepted: false, dropId: null }));
    expect(screen.getByText("EPUB files only")).toBeInTheDocument();
    act(() => drag({ phase: "drop", accepted: false, dropId: null }));
    expect(importDroppedBooks).not.toHaveBeenCalled();
    const loads = listMock.mock.calls.length;
    await act(async () => drag({ phase: "drop", accepted: true, dropId: "opaque-drop-id" }));
    expect(importDroppedBooks).toHaveBeenCalledWith("opaque-drop-id");
    expect(listMock.mock.calls.length).toBeGreaterThan(loads);
    expect(screen.queryByText("EPUB files only")).not.toBeInTheDocument();
    expect(screen.getByText("broken.epub:", { exact: false })).toBeInTheDocument();
    // The result is a plain notice the reader can close.
    const notice = screen.getByText("broken.epub:", { exact: false }).closest(".library-notice")!;
    expect(notice).not.toHaveClass("library-notice--error");
    fireEvent.click(within(notice as HTMLElement).getByRole("button", { name: "Close" }));
    expect(screen.queryByText("broken.epub:", { exact: false })).toBeNull();
    page.unmount();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("refuses a second drop while importing and clears the overlay on window blur", async () => {
    let drag!: Parameters<typeof onLibraryFileDrag>[0];
    vi.mocked(onLibraryFileDrag).mockImplementationOnce((callback) => {
      drag = callback;
      return () => {};
    });
    let finish!: (value: { canceled: boolean; results: [] }) => void;
    vi.mocked(importDroppedBooks).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByText("No books yet");
    act(() => drag({ phase: "drop", accepted: true, dropId: "first" }));
    act(() => drag({ phase: "enter", accepted: true, dropId: null }));
    expect(screen.queryByText("Drop EPUBs to add books")).not.toBeInTheDocument();
    act(() => drag({ phase: "drop", accepted: true, dropId: "second" }));
    expect(importDroppedBooks).toHaveBeenCalledTimes(1);
    const dataTransfer = {
      types: ["Files"],
      files: [new File(["book"], "second.epub")],
      dropEffect: "copy",
    };
    fireEvent.dragOver(window, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("none");
    fireEvent.drop(window, { dataTransfer });
    expect(postLibraryFiles).not.toHaveBeenCalled();
    act(() => drag({ phase: "enter", accepted: true, dropId: null }));
    expect(document.querySelector(".library-drop-overlay")).not.toBeNull();
    fireEvent.blur(window);
    expect(document.querySelector(".library-drop-overlay")).toBeNull();
    await act(async () => finish({ canceled: false, results: [] }));
  });

  it("Escape releases empty or populated Library search and preserves clearing", async () => {
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
    const input = await screen.findByRole("searchbox", { name: "Search books" });
    expect(input).toHaveAttribute("spellcheck", "false");
    // Ctrl+F focuses the field on the next frame; let it, so it cannot refocus after Escape.
    await waitFor(() => expect(input).toHaveFocus());
    for (const query of ["", "Quiet"]) {
      input.focus();
      fireEvent.change(input, { target: { value: query } });
      fireEvent.keyDown(input, { key: "Escape", shiftKey: true });
      expect(input).toHaveFocus();
      expect(input).toHaveValue(query);
      await userEvent.keyboard("{Escape}");
      expect(input).not.toHaveFocus();
      expect(input).toHaveValue("");
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    libraryCache.reset();
    listMock.mockResolvedValue([]);
    relinkMock.mockResolvedValue({ status: "canceled", message: null });
    removeMock.mockResolvedValue(true);
    removeManyMock.mockResolvedValue([]);
  });

  it("keeps full authors wrapping in grid, list and Continue reading with card actions intact", async () => {
    const author = "A Very Long Author Name With Several Contributors AndAnUnbrokenContributorName";
    listMock.mockResolvedValue([
      {
        ...catalogBook,
        author,
        progress: { unit: "words", current: 2, total: 10 },
        lastReadAt: "2026-10-04T00:00:00Z",
      },
    ]);
    // jsdom has no line layout; check the production wrapping rule here and real dimensions
    // in the standalone app. The same card is used for every Library surface.
    const style = document.createElement("style");
    style.textContent = libraryCss.match(/\.library-book__details p\s*\{[^}]*\}/)?.[0] ?? "";
    document.head.append(style);
    try {
      renderPage(
        <MemoryRouter>
          <LibraryPage />
        </MemoryRouter>,
      );
      await screen.findAllByText(author);
      for (const view of ["Grid view", "List view"]) {
        await userEvent.click(screen.getByRole("button", { name: view }));
        const authors = screen.getAllByText(author);
        expect(authors).toHaveLength(2);
        for (const element of authors) {
          const css = getComputedStyle(element);
          expect(css.whiteSpace).toBe("normal");
          expect(css.overflowWrap).toBe("anywhere");
          expect(css.overflow).not.toBe("hidden");
          expect(css.textOverflow).not.toBe("ellipsis");
          const card = element.closest("article")!;
          expect(
            within(card).getByRole("link", { name: "Open A Quiet Book in reader" }),
          ).toHaveAttribute("href", "/reader/book-1");
          expect(
            within(card).getByRole("button", { name: "More actions for A Quiet Book" }),
          ).toBeEnabled();
          expect(within(card).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "20");
        }
      }
      await userEvent.click(screen.getAllByRole("checkbox", { name: "Select A Quiet Book" })[0]);
      // Continue reading stays while selecting, its card chosen with the Library's.
      for (const box of screen.getAllByRole("checkbox", { name: "Select A Quiet Book" }))
        expect(box).toBeChecked();
      expect(screen.getByRole("region", { name: "Continue reading" })).toBeInTheDocument();
      expect(screen.getAllByText(author)).toHaveLength(2);
    } finally {
      style.remove();
    }
  });

  it.each([
    ["d", "/dictionary"],
    ["s", "/statistics"],
    ["g", "/settings"],
  ])("Library Ctrl+%s opens %s and respects typing/modifiers", async (key, destination) => {
    listMock.mockResolvedValue([catalogBook]);
    renderPage(
      <MemoryRouter initialEntries={["/library"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/library" element={<LibraryPage />} />
            <Route path={destination} element={<h1>Shortcut destination</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    const field = await screen.findByRole("searchbox", { name: "Search books" });
    fireEvent.keyDown(field, { key, ctrlKey: true });
    expect(screen.queryByText("Shortcut destination")).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key, ctrlKey: true, shiftKey: true });
    expect(screen.queryByText("Shortcut destination")).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key, ctrlKey: true });
    expect(screen.getByText("Shortcut destination")).toBeInTheDocument();
  });
  it("puts the top bar first in Tab order, before the page and the dock", async () => {
    listMock.mockResolvedValue([catalogBook]);
    renderPage(
      <MemoryRouter initialEntries={["/library"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/library" element={<LibraryPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: "Open A Quiet Book in reader" });
    const order = Array.from(
      document.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input"),
    )
      .filter((control) => control.tabIndex >= 0)
      .map((control) =>
        control.closest(".app-topbar") ? "top" : control.closest(".app-dock") ? "dock" : "page",
      );
    expect(order.indexOf("top")).toBe(0);
    expect(order.lastIndexOf("top")).toBeLessThan(order.indexOf("page"));
    expect(order.lastIndexOf("page")).toBeLessThan(order.indexOf("dock"));
  });
  it("keeps search in an empty Library and Ctrl+F focuses it", async () => {
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByText("No books yet");
    expect(screen.getByRole("searchbox", { name: "Search books" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
    await waitFor(() =>
      expect(screen.getByRole("searchbox", { name: "Search books" })).toHaveFocus(),
    );
  });

  it("opens a card by catalog ID with pointer or keyboard, while selection keeps card activation local", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([catalogBook]);
    const view = renderPage(
      <MemoryRouter initialEntries={["/library"]}>
        <Routes>
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/reader/:catalogId" element={<ReaderDestination />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "A Quiet Book" });
    const open = screen.getByRole("link", { name: "Open A Quiet Book in reader" });
    expect(open).toHaveAttribute("href", "/reader/book-1");
    open.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Reader for book-1" })).toBeInTheDocument();

    view.unmount();
    renderPage(
      <MemoryRouter initialEntries={["/library"]}>
        <Routes>
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/reader/:catalogId" element={<ReaderDestination />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "A Quiet Book" });
    // The card's corner box starts selecting, and then the whole card selects.
    await user.click(screen.getByRole("checkbox", { name: "Select A Quiet Book" }));
    expect(screen.queryByRole("link", { name: /in reader/ })).not.toBeInTheDocument();
    expect(screen.getByText("1 book selected")).toBeInTheDocument();
    await user.click(screen.getByRole("article"));
    expect(screen.getByText("0 books selected")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Reader for/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done selecting" }));
    await user.click(screen.getByRole("link", { name: "Open A Quiet Book in reader" }));
    expect(screen.getByRole("heading", { name: "Reader for book-1" })).toBeInTheDocument();
  });

  it("shows loading and then an actionable empty state", async () => {
    let finish!: (books: []) => void;
    listMock.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading your library…");
    finish([]);
    expect(await screen.findByRole("heading", { name: "No books yet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add books" })).toBeInTheDocument();
  });

  it("renders catalog metadata fallbacks and missing source status", async () => {
    listMock.mockResolvedValueOnce([
      {
        id: "book-1",
        title: null,
        author: null,
        fileName: "sample.epub",
        importedAt: "2026-09-21T00:00:00Z",
        availability: "missing",
        hasCover: false,
      },
    ]);
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Untitled book" })).toBeInTheDocument();
    expect(screen.getByText("Unknown author")).toBeInTheDocument();
    expect(screen.getByText("sample.epub")).toBeInTheDocument();
    expect(screen.getByText("Source file missing")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Library" })).getByText("1 book"),
    ).toBeInTheDocument();
  });

  it("shows each cover thumbnail straight from its cover protocol URL", async () => {
    listMock.mockResolvedValueOnce([{ ...catalogBook, hasCover: true, coverUrl: coverUrl(0) }]);
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "A Quiet Book" })).toBeInTheDocument();
    expect(document.querySelector(".library-book__cover img")).toHaveAttribute("src", coverUrl(0));
  });

  it("shows the title fallback for an unsafe cover value or an image that fails", async () => {
    listMock.mockResolvedValueOnce([
      { ...catalogBook, hasCover: true, coverUrl: "file:///C:/private/cover.png" },
      { ...secondCatalogBook, hasCover: true, coverUrl: coverUrl(0) },
    ]);
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "A Quiet Book" });
    expect(document.body.innerHTML).not.toContain("file:///");
    const images = document.querySelectorAll(".library-book__cover img");
    expect(images).toHaveLength(1);
    fireEvent.error(images[0]);
    expect(document.querySelector(".library-book__cover img")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".library-book__cover-fallback")).toHaveLength(2);
  });

  it("renders only the books near the view and follows the scroll", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    // jsdom has no layout: the collection moves up as its scroll container scrolls.
    let scroller: HTMLElement | null = null;
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const top = this.classList.contains("library-books") ? -(scroller?.scrollTop ?? 0) : 0;
        return { top, bottom: top, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
      });
    try {
      listMock.mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, index) => ({
          ...catalogBook,
          id: `book-${index}`,
          title: `Book ${String(index).padStart(3, "0")}`,
          fileName: index < 100 ? "matching.epub" : "outside.epub",
          importedAt: new Date(Date.UTC(2026, 0, 1) - index * 60_000).toISOString(),
        })),
      );
      renderPage(
        <MemoryRouter>
          <div style={{ overflowY: "auto" }}>
            <LibraryPage />
          </div>
        </MemoryRouter>,
      );

      expect(await screen.findByRole("heading", { name: "Book 000" })).toBeInTheDocument();
      const rendered = screen.getAllByRole("article").length;
      expect(rendered).toBeGreaterThan(0);
      expect(rendered).toBeLessThan(50);
      expect(screen.queryByRole("heading", { name: "Book 499" })).not.toBeInTheDocument();
      expect(screen.getByText("500 books")).toBeInTheDocument();

      // Ctrl+A uses every filtered ID, including cards outside the virtual viewport.
      const user = userEvent.setup();
      const search = screen.getByRole("searchbox", { name: "Search books" });
      fireEvent.change(search, { target: { value: "matching" } });
      await user.click(screen.getByRole("checkbox", { name: "Select Book 000" }));
      await user.keyboard("{Control>}a{/Control}");
      expect(screen.getByText("100 books selected")).toBeInTheDocument();
      expect(screen.getAllByRole("article").length).toBeLessThan(50);
      await user.click(screen.getByRole("button", { name: "Remove" }));
      expect(screen.getByRole("alertdialog")).toHaveAccessibleName("Remove 100 books from Komori?");
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await user.click(screen.getByRole("button", { name: "Done selecting" }));
      fireEvent.change(search, { target: { value: "" } });

      scroller = document
        .querySelector<HTMLElement>(".library-books")!
        .closest<HTMLElement>("[style*=overflow]")!;
      scroller.scrollTop = 40_000;
      fireEvent.scroll(scroller);
      await waitFor(() =>
        expect(screen.queryByRole("heading", { name: "Book 000" })).not.toBeInTheDocument(),
      );
      expect(screen.getAllByRole("article").length).toBeLessThan(50);
      expect(libraryCache.place("")?.scrollTop).toBe(40_000);
    } finally {
      height.mockRestore();
      rect.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("returns to the books it was left at, even when what is above them grew", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    // jsdom has no layout: the collection sits `above` px down its scroll container.
    let scroller: HTMLElement | null = null;
    let above = 0;
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const top = this.classList.contains("library-books")
          ? above - (scroller?.scrollTop ?? 0)
          : 0;
        return { top, bottom: top, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
      });
    const books = Array.from({ length: 500 }, (_, index) => ({
      ...catalogBook,
      id: `book-${index}`,
      title: `Book ${String(index).padStart(3, "0")}`,
      importedAt: new Date(Date.UTC(2026, 0, 1) - index * 60_000).toISOString(),
    }));
    const page = (entry: Parameters<typeof MemoryRouter>[0]["initialEntries"]) =>
      renderPage(
        <MemoryRouter initialEntries={entry}>
          <div style={{ overflowY: "auto" }}>
            <LibraryPage />
          </div>
        </MemoryRouter>,
      );
    const findScroller = () =>
      document
        .querySelector<HTMLElement>(".library-books")!
        .closest<HTMLElement>("[style*=overflow]")!;
    try {
      listMock.mockResolvedValue(books);
      const first = page(["/library"]);
      await screen.findByRole("heading", { name: "Book 000" });
      scroller = findScroller();
      scroller.scrollTop = 40_000;
      fireEvent.scroll(scroller);
      await waitFor(() => expect(libraryCache.place("")?.anchor).toBeDefined());
      const shown = screen.getAllByRole("article").map((article) => article.textContent);
      first.unmount();

      // Opening a book added a row to Continue reading above the books.
      above = 900;
      scroller = null;
      page(["/library"]);
      await waitFor(() => expect(findScroller().scrollTop).toBe(40_900));
      scroller = findScroller();
      fireEvent.scroll(scroller);
      await waitFor(() =>
        expect(screen.getAllByRole("article").map((article) => article.textContent)).toEqual(shown),
      );
    } finally {
      height.mockRestore();
      rect.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("returns the Reader to the group page it was opened from, where it was left", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    const books = Array.from({ length: 300 }, (_, index) => ({
      ...catalogBook,
      id: `book-${index}`,
      title: `Cats ${index}`,
      series: "Cats",
      seriesIndex: index + 1,
    }));
    const search = `?group=${encodeURIComponent("series:Cats")}`;
    const pageAt = (state?: unknown) =>
      renderPage(
        <MemoryRouter initialEntries={[{ pathname: "/library", search, state }]}>
          <div style={{ overflowY: "auto" }}>
            <LibraryPage />
          </div>
        </MemoryRouter>,
      );
    const scrollTop = () =>
      document
        .querySelector<HTMLElement>(".library-books")
        ?.closest<HTMLElement>("[style*=overflow]")?.scrollTop;
    try {
      listMock.mockResolvedValue(books);
      libraryCache.setBooks(books);
      libraryCache.setPlace("series:Cats", { scrollTop: 1234 });

      // The Reader's Back to library returns to the group's page where it was left…
      const returned = pageAt(libraryReturn);
      await waitFor(() => expect(scrollTop()).toBe(1234));
      expect(libraryCache.lastPage()).toBe(`/library${search}`);
      returned.unmount();

      // …while See all opens it at its top.
      libraryCache.setPlace("series:Cats", { scrollTop: 1234 });
      pageAt();
      await screen.findByRole("heading", { name: "Cats 0" });
      expect(scrollTop()).toBe(0);
    } finally {
      height.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("shows a returning Library at once from the session's last listing", async () => {
    listMock.mockResolvedValueOnce([catalogBook]);
    const first = renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "A Quiet Book" });
    first.unmount();

    let finish!: (books: (typeof catalogBook)[]) => void;
    listMock.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    // Shown before the new listing returns, which then replaces it.
    expect(screen.getByRole("heading", { name: "A Quiet Book" })).toBeInTheDocument();
    expect(screen.queryByText("Loading your library…")).not.toBeInTheDocument();
    await act(async () => finish([catalogBook, secondCatalogBook]));
    expect(screen.getByRole("heading", { name: "Another Quiet Book" })).toBeInTheDocument();
  });

  it("relinks a missing book through its visible recovery action without changing its catalog ID", async () => {
    const user = userEvent.setup();
    const missingBook = { ...catalogBook, availability: "missing" as const };
    const repairedBook = {
      ...catalogBook,
      title: "Refreshed Book Metadata",
      author: "Replacement Author",
      fileName: "replacement.epub",
      hasCover: true,
      coverUrl: coverUrl(1),
    };
    listMock.mockResolvedValueOnce([missingBook]).mockResolvedValueOnce([repairedBook]);
    relinkMock.mockResolvedValueOnce({ status: "relinked", message: null });
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByText("Source file missing");

    await user.click(screen.getByRole("button", { name: "Relink EPUB" }));

    await waitFor(() => expect(relinkMock).toHaveBeenCalledWith("book-1"));
    expect(
      await screen.findByRole("heading", { name: "Refreshed Book Metadata" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("article")).toHaveAttribute("data-catalog-id", "book-1");
    expect(screen.getByRole("status")).toHaveTextContent("Source relinked");
    expect(screen.getByRole("status")).toHaveTextContent("catalog identity");
    expect(document.querySelector(".library-book__cover img")).toHaveAttribute("src", coverUrl(1));
  });

  it("shows the new cover revision after relinking an available book with the same stable ID", async () => {
    const user = userEvent.setup();
    const coveredBook = { ...catalogBook, hasCover: true, coverUrl: coverUrl(0) };
    listMock
      .mockResolvedValueOnce([coveredBook])
      .mockResolvedValueOnce([{ ...coveredBook, coverUrl: coverUrl(1) }]);
    relinkMock.mockResolvedValueOnce({ status: "relinked", message: null });
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "A Quiet Book" });
    expect(document.querySelector(".library-book__cover img")).toHaveAttribute("src", coverUrl(0));

    await user.click(screen.getByRole("button", { name: "More actions for A Quiet Book" }));
    await user.click(screen.getByRole("menuitem", { name: "Relink EPUB…" }));

    await waitFor(() =>
      expect(document.querySelector(".library-book__cover img")).toHaveAttribute(
        "src",
        coverUrl(1),
      ),
    );
    expect(screen.getByRole("article")).toHaveAttribute("data-catalog-id", "book-1");
  });

  it("treats picker cancellation as a visible non-error with no Library refresh", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce([catalogBook]);
    relinkMock.mockResolvedValueOnce({ status: "canceled", message: null });
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "A Quiet Book" });

    await user.click(screen.getByRole("button", { name: "More actions for A Quiet Book" }));
    await user.click(screen.getByRole("menuitem", { name: "Relink EPUB…" }));

    expect(await screen.findByText("Relink canceled")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("library record was not changed");
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "A Quiet Book" })).toBeInTheDocument();
  });

  it.each([
    [
      { status: "invalid" as const, message: "The selected file is not a valid readable EPUB." },
      "Replacement is not a valid EPUB",
    ],
    [
      {
        status: "duplicate" as const,
        message: "That EPUB is already linked to another Library book. Choose a different file.",
      },
      "That EPUB is already in your library",
    ],
    [
      {
        status: "readFailed" as const,
        message: "Komori couldn't read the selected file. Check its permissions.",
      },
      "Replacement could not be read",
    ],
  ])(
    "distinguishes %s relink outcomes without changing the visible record",
    async (result, title) => {
      const user = userEvent.setup();
      listMock.mockResolvedValueOnce([catalogBook]);
      relinkMock.mockResolvedValueOnce(result);
      renderPage(
        <MemoryRouter>
          <LibraryPage />
        </MemoryRouter>,
      );
      await screen.findByRole("heading", { name: "A Quiet Book" });

      await user.click(screen.getByRole("button", { name: "More actions for A Quiet Book" }));
      await user.click(screen.getByRole("menuitem", { name: "Relink EPUB…" }));

      expect(await screen.findByText(title)).toBeInTheDocument();
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "A Quiet Book" })).toBeInTheDocument();
      expect(listMock).toHaveBeenCalledTimes(1);
    },
  );

  it("reports a native relink failure without exposing native error details", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce([catalogBook]);
    relinkMock.mockRejectedValueOnce(new Error("private native detail"));
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "A Quiet Book" });

    await user.click(screen.getByRole("button", { name: "More actions for A Quiet Book" }));
    await user.click(screen.getByRole("menuitem", { name: "Relink EPUB…" }));

    expect(await screen.findByText("Relink could not finish")).toBeInTheDocument();
    expect(screen.getByRole("alert")).not.toHaveTextContent("private native detail");
    expect(screen.getByRole("heading", { name: "A Quiet Book" })).toBeInTheDocument();
  });

  it("keeps successful imports visible alongside per-file failures", async () => {
    const user = userEvent.setup();
    importMock.mockResolvedValueOnce({
      canceled: false,
      results: [
        { fileName: "good.epub", status: "imported", message: null },
        { fileName: "bad.epub", status: "failed", message: "Unreadable EPUB." },
      ],
    });
    listMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "good",
        title: "Good Book",
        author: "Writer",
        fileName: "good.epub",
        importedAt: "2026-09-21T00:00:00Z",
        availability: "available",
        hasCover: false,
      },
    ]);
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "No books yet" });
    await user.click(screen.getByRole("button", { name: "Add books" }));

    expect(await screen.findByRole("heading", { name: "Good Book" })).toBeInTheDocument();
    expect(screen.getByText(/1 imported.*1 failed/)).toBeInTheDocument();
    expect(screen.getByText(/Unreadable EPUB/)).toBeInTheDocument();
  });

  it("shows native import failures in the interface language", async () => {
    const user = userEvent.setup();
    importMock.mockResolvedValueOnce({
      canceled: false,
      results: [
        { fileName: "no-package.epub", status: "failed", message: "failure.epubNoPackage" },
        {
          fileName: "locked.epub",
          status: "failed",
          message: "Cannot read the source file: denied",
        },
      ],
    });
    listMock.mockResolvedValue([]);
    const page = renderPage(
      <I18nProvider language="pt-BR">
        <MemoryRouter>
          <LibraryPage />
        </MemoryRouter>
      </I18nProvider>,
    );
    try {
      await user.click(await screen.findByRole("button", { name: "Adicionar livros" }));
      expect(
        await screen.findByText("Este EPUB não indica um arquivo de pacote válido."),
      ).toBeInTheDocument();
      // An unexpected I/O error keeps its own detail.
      expect(screen.getByText("Cannot read the source file: denied")).toBeInTheDocument();
      expect(screen.queryByText(/failure\./)).not.toBeInTheDocument();
    } finally {
      page.unmount();
      render(<I18nProvider language="en">{null}</I18nProvider>).unmount();
    }
  });

  it("shows catalog errors with retry", async () => {
    const user = userEvent.setup();
    listMock.mockRejectedValueOnce(new Error("Database unavailable"));
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Database unavailable")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "No books yet" })).toBeInTheDocument(),
    );
  });

  it("removes a confirmed book through the accessible actions button", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce([catalogBook]);
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "A Quiet Book" });

    await user.click(screen.getByRole("button", { name: "More actions for A Quiet Book" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from library" }));

    expect(screen.getByRole("alertdialog")).toHaveAccessibleName("Remove this book from Komori?");
    expect(screen.getByText(/original EPUB file will not be deleted/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove from library" }));

    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("book-1"));
    expect(await screen.findByRole("heading", { name: "No books yet" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "A Quiet Book" })).not.toBeInTheDocument();
  });

  it("marks an opened book unread after confirmation and lists the Library again", async () => {
    const user = userEvent.setup();
    const opened = {
      ...catalogBook,
      progress: { unit: "words" as const, current: 300, total: 300 },
      lastReadAt: "2026-09-01T00:00:00Z",
    };
    const fresh = { ...catalogBook, id: "book-2", title: "A Fresh Book" };
    listMock.mockResolvedValueOnce([opened, fresh]).mockResolvedValueOnce([catalogBook, fresh]);
    vi.mocked(markBookUnread).mockResolvedValueOnce(true);
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "A Fresh Book" });
    // A book never opened has nothing to reset.
    await user.click(screen.getByRole("button", { name: "More actions for A Fresh Book" }));
    expect(screen.queryByRole("menuitem", { name: "Mark as unread" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await screen.findAllByRole("heading", { name: "A Quiet Book" });
    await user.click(screen.getAllByRole("button", { name: "More actions for A Quiet Book" })[0]);
    await user.click(screen.getByRole("menuitem", { name: "Mark as unread" }));
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName("Mark this book as unread?");
    await user.click(screen.getByRole("button", { name: "Mark as unread" }));
    await waitFor(() => expect(markBookUnread).toHaveBeenCalledWith("book-1"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });

  it("opens on right-click and cancellation leaves the catalog untouched", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce([catalogBook]);
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "A Quiet Book" });

    fireEvent.contextMenu(screen.getByRole("article"), { clientX: 80, clientY: 120 });
    await user.click(screen.getByRole("menuitem", { name: "Remove from library" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(removeMock).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "A Quiet Book" })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("keeps the book and dialog visible when native removal fails", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce([catalogBook]);
    removeMock.mockRejectedValueOnce(new Error("Library storage unavailable"));
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "A Quiet Book" });

    await user.click(screen.getByRole("button", { name: "More actions for A Quiet Book" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from library" }));
    await user.click(screen.getByRole("button", { name: "Remove from library" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Library storage unavailable");
    expect(screen.getByRole("heading", { name: "A Quiet Book" })).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("offers explicit keyboard-accessible selection with select all, Escape, and card toggling", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce([catalogBook, secondCatalogBook]);
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "A Quiet Book" });

    // There is no Select button; each card's box takes the keyboard and starts selecting.
    expect(screen.queryByRole("button", { name: "Select" })).not.toBeInTheDocument();
    const firstCheckbox = screen.getByRole("checkbox", { name: "Select A Quiet Book" });
    firstCheckbox.focus();
    await user.keyboard(" ");
    expect(firstCheckbox).toBeChecked();
    expect(screen.getByText("1 book selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("2 books selected")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /More actions/ })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select A Quiet Book" })).not.toBeChecked();
    expect(screen.getAllByRole("button", { name: /More actions/ })).toHaveLength(2);

    await user.click(screen.getByRole("checkbox", { name: "Select A Quiet Book" }));
    await user.click(screen.getAllByRole("article")[1]);
    expect(screen.getByText("2 books selected")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Another Quiet Book" })).toBeChecked();
  });

  it("scopes Ctrl+A to active selection, leaving editing, dialogs and menus alone", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([catalogBook, secondCatalogBook]);
    const unguard = guardDocument(document);
    try {
      renderPage(
        <MemoryRouter>
          <LibraryPage />
        </MemoryRouter>,
      );
      const box = await screen.findByRole("checkbox", { name: "Select A Quiet Book" });
      expect(fireEvent.keyDown(document.body, { key: "a", ctrlKey: true })).toBe(false);
      expect(screen.queryByRole("toolbar", { name: "Library selection" })).not.toBeInTheDocument();
      await user.click(box);
      for (const init of [
        { shiftKey: true },
        { altKey: true },
        { repeat: true },
        { isComposing: true },
        { metaKey: true },
      ])
        fireEvent.keyDown(box, { key: "a", ctrlKey: true, ...init });
      const handled = new KeyboardEvent("keydown", {
        key: "a",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      handled.preventDefault();
      fireEvent(box, handled);
      const search = screen.getByRole("searchbox", { name: "Search books" });
      expect(fireEvent.keyDown(search, { key: "a", ctrlKey: true })).toBe(true);
      await user.click(screen.getByRole("button", { name: "Filters" }));
      fireEvent.keyDown(screen.getAllByRole("menuitemradio")[0], { key: "a", ctrlKey: true });
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "Series…" }));
      fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
      expect(
        fireEvent.keyDown(screen.getByLabelText("Series name"), {
          key: "a",
          ctrlKey: true,
        }),
      ).toBe(true);
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.getByText("1 book selected")).toBeInTheDocument();
      fireEvent.keyDown(box, { key: "a", metaKey: true });
      expect(screen.getByText("2 books selected")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Done selecting" }));
      expect(fireEvent.keyDown(document.body, { key: "a", ctrlKey: true })).toBe(false);
      expect(removeManyMock).not.toHaveBeenCalled();
    } finally {
      unguard();
    }
  });

  it("preserves selection when a card is right-clicked in selection mode", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce([catalogBook, secondCatalogBook]);
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "A Quiet Book" });

    await user.click(screen.getByRole("checkbox", { name: "Select A Quiet Book" }));
    fireEvent.contextMenu(screen.getAllByRole("article")[1], { clientX: 80, clientY: 120 });

    expect(screen.getByText("1 book selected")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select A Quiet Book" })).toBeChecked();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps successful bulk removals and precisely reports failed catalog IDs", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce([catalogBook, secondCatalogBook]);
    removeManyMock.mockResolvedValueOnce([
      { id: "book-1", status: "removed", message: null },
      { id: "book-2", status: "failed", message: "This book is no longer in the library." },
    ]);
    renderPage(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "A Quiet Book" });

    await user.click(screen.getByRole("checkbox", { name: "Select A Quiet Book" }));
    await user.click(screen.getByRole("button", { name: "Select all" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(screen.getByRole("alertdialog")).toHaveAccessibleName("Remove 2 books from Komori?");
    expect(screen.getByText(/original EPUB files will not be deleted/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove 2 books" }));

    await waitFor(() => expect(removeManyMock).toHaveBeenCalledWith(["book-1", "book-2"]));
    expect(screen.queryByRole("heading", { name: "A Quiet Book" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Another Quiet Book" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "1 book could not be removed. Successful removals were kept.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Another Quiet Book");
    expect(screen.getByText("1 book selected")).toBeInTheDocument();
  });

  describe("layout", () => {
    const shelfBooks = [
      {
        ...catalogBook,
        id: "reading",
        title: "Halfway Book",
        author: "Reader Author",
        progress: { unit: "characters" as const, current: 500, total: 2_000 },
        lastReadAt: "2026-09-28T00:00:00Z",
        characters: 2_000,
      },
      {
        ...catalogBook,
        id: "finished",
        title: "Finished Book",
        progress: { unit: "words" as const, current: 30, total: 30 },
        lastReadAt: "2026-09-27T00:00:00Z",
      },
      {
        ...catalogBook,
        id: "unread",
        title: "Unread Book",
        fileName: "unread-file.epub",
        characters: 1_500,
      },
    ];

    // The Library's books, without Continue reading and the All books heading above them.
    function titles() {
      const collection = screen.getByRole("region", { name: "Library" });
      return within(collection)
        .getAllByRole("heading", { level: 3 })
        .filter(
          (heading) =>
            !heading.closest(".reading-shelf") && !heading.matches(".library-all-heading"),
        )
        .map((heading) => heading.textContent);
    }

    it("shows the summary and continues books in progress with their counted progress", async () => {
      // Opened (to look at its pictures) with no reading done: not continued.
      const opened = {
        ...catalogBook,
        id: "opened",
        title: "Opened Book",
        progress: { unit: "characters" as const, current: 0, total: 1_000 },
        lastReadAt: "2026-09-29T00:00:00Z",
      };
      listMock.mockResolvedValueOnce([...shelfBooks, opened]);
      renderPage(
        <MemoryRouter>
          <LibraryPage />
        </MemoryRouter>,
      );
      await screen.findAllByRole("heading", { name: "Halfway Book" });
      expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
      const library = screen.getByRole("region", { name: "Library" });
      expect(within(library).getByText("4 books")).toBeInTheDocument();
      // The whole Library's characters, not characters read.
      expect(within(library).getByText("3.5K characters")).toBeInTheDocument();
      expect(within(library).queryByText(/read$/)).not.toBeInTheDocument();
      const shelf = screen.getByRole("region", { name: "Continue reading" });
      // Only the book in progress, as the same card as the Library's, with no See all.
      expect(
        within(shelf)
          .getAllByRole("link")
          .map((link) => link.getAttribute("aria-label")),
      ).toEqual(["Open Halfway Book in reader"]);
      expect(within(shelf).getByText("1 book in progress")).toBeInTheDocument();
      expect(within(shelf).queryByRole("button", { name: "See all" })).not.toBeInTheDocument();
      expect(within(shelf).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
      expect(
        within(shelf).getByText(
          `${(500).toLocaleString()} / ${(2000).toLocaleString()} characters`,
        ),
      ).toBeInTheDocument();
      expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
      // A CJK book not yet opened shows the characters Komori counted, as books in progress do.
      expect(screen.getByText(`0 / ${(1500).toLocaleString()} characters`)).toBeInTheDocument();
      expect(screen.queryByText("Not started")).not.toBeInTheDocument();
      // Searching counts only the books it shows.
      fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
      const search = await screen.findByRole("searchbox", { name: "Search books" });
      fireEvent.change(search, { target: { value: "Unread" } });
      expect(await within(library).findByText("1 of 4 books")).toBeInTheDocument();
      expect(within(library).getByText("1.5K characters")).toBeInTheDocument();
    });

    it("keeps Continue reading while selecting, so chosen books stay where they are", async () => {
      const user = userEvent.setup();
      const second = {
        ...shelfBooks[0],
        id: "second",
        title: "Second Book",
        lastReadAt: "2026-09-26T00:00:00Z",
      };
      listMock.mockResolvedValueOnce([...shelfBooks, second]);
      renderPage(
        <MemoryRouter>
          <LibraryPage />
        </MemoryRouter>,
      );
      await screen.findAllByRole("heading", { name: "Halfway Book" });
      const shelf = screen.getByRole("region", { name: "Continue reading" });
      await user.click(within(shelf).getByRole("checkbox", { name: "Select Halfway Book" }));
      // The shelf stays, and a book chosen there is chosen below too.
      expect(screen.getByRole("region", { name: "Continue reading" })).toBe(shelf);
      expect(screen.getAllByRole("checkbox", { name: "Select Halfway Book" })).toHaveLength(2);
      for (const box of screen.getAllByRole("checkbox", { name: "Select Halfway Book" }))
        expect(box).toBeChecked();
      // Shift+click ranges over the shelf's own books.
      await user.keyboard("{Shift>}");
      await user.click(within(shelf).getByRole("checkbox", { name: "Select Second Book" }));
      await user.keyboard("{/Shift}");
      expect(screen.getByText("2 books selected")).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "Select Unread Book" })).not.toBeChecked();
      await user.click(screen.getByRole("button", { name: "Done selecting" }));
      expect(screen.getByRole("region", { name: "Continue reading" })).toBeInTheDocument();
    });

    it("marks books completed from a card's menu or the selection", async () => {
      const user = userEvent.setup();
      const completed = (book: (typeof shelfBooks)[number], total: number) => ({
        ...book,
        progress: { unit: "characters" as const, current: total, total },
      });
      listMock
        .mockResolvedValueOnce(shelfBooks)
        .mockResolvedValueOnce([completed(shelfBooks[0], 2_000), ...shelfBooks.slice(1)])
        .mockResolvedValueOnce([
          completed(shelfBooks[0], 2_000),
          shelfBooks[1],
          completed(shelfBooks[2], 1_500),
        ]);
      vi.mocked(markBooksCompleted)
        .mockResolvedValueOnce(["reading"])
        .mockResolvedValueOnce(["unread"]);
      renderPage(
        <MemoryRouter>
          <LibraryPage />
        </MemoryRouter>,
      );
      await screen.findAllByRole("heading", { name: "Halfway Book" });
      // A finished book has nothing to complete.
      await user.click(screen.getByRole("button", { name: "More actions for Finished Book" }));
      expect(screen.queryByRole("menuitem", { name: "Mark as completed" })).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
      await user.click(screen.getAllByRole("button", { name: "More actions for Halfway Book" })[0]);
      await user.click(screen.getByRole("menuitem", { name: "Mark as completed" }));
      await waitFor(() => expect(markBooksCompleted).toHaveBeenCalledWith(["reading"]));
      // Finished, it leaves Continue reading.
      await waitFor(() =>
        expect(screen.queryByRole("region", { name: "Continue reading" })).not.toBeInTheDocument(),
      );
      await user.click(screen.getByRole("checkbox", { name: "Select Unread Book" }));
      await user.click(screen.getByRole("button", { name: "Mark as completed" }));
      await waitFor(() => expect(markBooksCompleted).toHaveBeenLastCalledWith(["unread"]));
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Done selecting" })).not.toBeInTheDocument(),
      );
      expect(screen.getAllByText("Completed")).toHaveLength(3);
    });

    it("shows Continue reading inside the Library, under its heading, until searching or filtering", async () => {
      const user = userEvent.setup();
      listMock.mockResolvedValueOnce(shelfBooks);
      renderPage(
        <MemoryRouter>
          <LibraryPage />
        </MemoryRouter>,
      );
      await screen.findAllByRole("heading", { name: "Halfway Book" });
      const library = screen.getByRole("region", { name: "Library" });
      const shelf = within(library).getByRole("region", { name: "Continue reading" });
      const heading = within(library).getByRole("heading", { level: 2, name: "Library" });
      const allBooks = within(library).getByRole("heading", { level: 3, name: "All books" });
      // Library heading and toolbar, then Continue reading, then All books.
      expect(
        heading.compareDocumentPosition(shelf) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        shelf.compareDocumentPosition(allBooks) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      await user.type(screen.getByRole("searchbox", { name: "Search books" }), "halfway");
      expect(screen.queryByRole("region", { name: "Continue reading" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "All books" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Clear search" }));
      expect(screen.getByRole("region", { name: "Continue reading" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Filters" }));
      await user.click(screen.getByRole("menuitemradio", { name: /Not started/ }));
      expect(screen.queryByRole("region", { name: "Continue reading" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Filters" }));
      await user.click(screen.getByRole("menuitemradio", { name: /All books/ }));

      // Grouped, the groups' own headings follow it.
      await user.click(screen.getByRole("button", { name: /^(Group by|No grouping)/ }));
      await user.click(screen.getByRole("menuitemradio", { name: /Language/ }));
      expect(screen.getByRole("region", { name: "Continue reading" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "All books" })).not.toBeInTheDocument();
    });

    it("imports new books from the book folders on each visit and lists them", async () => {
      vi.mocked(scanLibraryFolders).mockResolvedValueOnce([
        { fileName: "new.epub", status: "imported", message: null },
      ]);
      listMock.mockResolvedValueOnce([]).mockResolvedValue([catalogBook]);
      renderPage(
        <MemoryRouter>
          <LibraryPage />
        </MemoryRouter>,
      );
      expect(await screen.findByRole("heading", { name: "A Quiet Book" })).toBeInTheDocument();
      expect(screen.getByText("1 imported")).toBeInTheDocument();
      expect(scanLibraryFolders).toHaveBeenCalledTimes(1);
    });

    it("clears an import result once the Library that showed it is left", async () => {
      const user = userEvent.setup();
      vi.mocked(scanLibraryFolders).mockResolvedValueOnce([
        { fileName: "new.epub", status: "imported", message: null },
      ]);
      listMock.mockResolvedValue([catalogBook]);
      renderPage(
        <MemoryRouter initialEntries={["/library"]}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/statistics" element={<h1>Elsewhere</h1>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );
      expect(await screen.findByText("1 imported")).toBeInTheDocument();
      await user.click(screen.getByRole("link", { name: "Statistics" }));
      await screen.findByRole("heading", { name: "Elsewhere" });
      await act(() => new Promise((done) => setTimeout(done, 0)));
      await user.click(screen.getByRole("link", { name: "Library" }));
      expect(await screen.findByRole("heading", { name: "A Quiet Book" })).toBeInTheDocument();
      expect(screen.queryByText("1 imported")).not.toBeInTheDocument();
    });

    it("searches, filters, sorts, reverses, and lists books, saving the view choices", async () => {
      const user = userEvent.setup();
      listMock.mockResolvedValueOnce(shelfBooks);
      renderPage(
        <MemoryRouter>
          <LibraryPage />
        </MemoryRouter>,
      );
      await screen.findAllByRole("heading", { name: "Halfway Book" });
      expect(titles()).toEqual(["Finished Book", "Halfway Book", "Unread Book"]);

      await user.type(screen.getByRole("searchbox", { name: "Search books" }), "unread-file");
      expect(titles()).toEqual(["Unread Book"]);
      await user.type(screen.getByRole("searchbox", { name: "Search books" }), " nothing");
      expect(screen.getByText("No books found")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Clear search" }));

      await user.click(screen.getByRole("button", { name: "Filters" }));
      await user.click(screen.getByRole("menuitemradio", { name: /Completed/ }));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(titles()).toEqual(["Finished Book"]);
      await user.click(screen.getByRole("button", { name: "Filters" }));
      await user.click(screen.getByRole("menuitemradio", { name: /All books/ }));

      await user.click(screen.getByRole("button", { name: "Sort by Title" }));
      await user.click(screen.getByRole("menuitemradio", { name: /Title/ }));
      expect(titles()).toEqual(["Finished Book", "Halfway Book", "Unread Book"]);
      await user.click(screen.getByRole("button", { name: "Reverse sort direction" }));
      expect(titles()).toEqual(["Unread Book", "Halfway Book", "Finished Book"]);

      // Cards shows as changed only once a detail differs from what a new Library shows.
      const cards = screen.getByRole("button", { name: "Cards" });
      expect(cards).not.toHaveClass("toolbar-pill--active");
      await user.click(cards);
      const lastRead = screen.getByRole("menuitemcheckbox", { name: /Last read/ });
      expect(lastRead).toHaveAttribute("aria-checked", "true");
      await user.click(lastRead);
      expect(lastRead).toHaveAttribute("aria-checked", "false");
      expect(cards).toHaveClass("toolbar-pill--active");
      await user.click(lastRead);
      expect(lastRead).toHaveAttribute("aria-checked", "true");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      // The finished book, and the book in progress in both sections.
      expect(screen.getAllByText(/^Last read /).length).toBe(3);

      await user.click(screen.getByRole("button", { name: "List view" }));
      expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      // Continue reading keeps grid cards; the Library's own books are listed.
      expect(document.querySelectorAll(".library-books--list article")).toHaveLength(3);
      expect(document.querySelectorAll(".reading-shelf .library-books--grid article")).toHaveLength(
        1,
      );
    });

    it("shows every book in progress, adding rows rather than a separate page", async () => {
      listMock.mockResolvedValueOnce(
        Array.from({ length: 12 }, (_, index) => ({ ...shelfBooks[0], id: `reading-${index}` })),
      );
      renderPage(
        <MemoryRouter>
          <LibraryPage />
        </MemoryRouter>,
      );
      const shelf = await screen.findByRole("region", { name: "Continue reading" });
      expect(within(shelf).getByText("12 books in progress")).toBeInTheDocument();
      expect(within(shelf).getAllByRole("article")).toHaveLength(12);
    });

    it("supports menu keyboard navigation and returns focus to its trigger", async () => {
      const user = userEvent.setup();
      listMock.mockResolvedValueOnce(shelfBooks);
      renderPage(
        <MemoryRouter>
          <LibraryPage />
        </MemoryRouter>,
      );
      await screen.findAllByRole("heading", { name: "Halfway Book" });
      const trigger = screen.getByRole("button", { name: "Filters" });
      await user.click(trigger);
      expect(screen.getByRole("menuitemradio", { name: /All books/ })).toHaveFocus();
      await user.keyboard("{End}");
      expect(screen.getByRole("menuitemradio", { name: /Not started/ })).toHaveFocus();
      await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
      expect(titles()).toEqual(["Halfway Book"]);
      expect(trigger).toHaveFocus();
      await user.click(trigger);
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });

    describe("details, groups, and selection", () => {
      const detailed = [
        {
          ...catalogBook,
          id: "vol-2",
          title: "Cat Tales 2",
          language: "ja",
          series: "Cat Tales",
          seriesIndex: 2,
          characters: 120_000,
          uniqueKanji: 1_889,
        },
        {
          ...catalogBook,
          id: "vol-1",
          title: "Cat Tales 1",
          language: "ja",
          series: "Cat Tales",
          seriesIndex: 1,
          characters: 100_000,
          uniqueKanji: 1_700,
        },
        { ...catalogBook, id: "english", title: "English Book", language: "en" },
        { ...catalogBook, id: "plain", title: "Plain Book" },
      ];

      function libraryTitles() {
        return within(screen.getByRole("region", { name: "Library" }))
          .getAllByRole("article")
          .map((article) => within(article).getByRole("heading").textContent);
      }

      async function showLibrary(user: ReturnType<typeof userEvent.setup>) {
        listMock.mockResolvedValue(detailed);
        renderPage(
          <MemoryRouter>
            <LibraryPage />
          </MemoryRouter>,
        );
        await screen.findByRole("heading", { name: "Cat Tales 1" });
        // Title order makes the shown order predictable.
        await user.click(screen.getByRole("button", { name: /^Sort by/ }));
        await user.click(screen.getByRole("menuitemradio", { name: /Title/ }));
      }

      it("shows series, language, and unique kanji on cards from the Cards menu", async () => {
        const user = userEvent.setup();
        await showLibrary(user);
        const first = screen.getAllByRole("article")[0];
        // The series chip names the series, never a number.
        expect(within(first).getByTitle("Series: Cat Tales")).toHaveTextContent(/^Cat Tales$/);
        expect(within(first).getByTitle(`${(1700).toLocaleString()} unique kanji`)).toBeVisible();
        // Language and Unique kanji are on by default.
        expect(within(first).getByTitle("Language: Japanese")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Cards" }));
        await user.click(screen.getByRole("menuitemcheckbox", { name: /Language/ }));
        await user.click(screen.getByRole("menuitemcheckbox", { name: /Unique kanji/ }));
        await user.keyboard("{Escape}");
        expect(within(first).queryByTitle("Language: Japanese")).not.toBeInTheDocument();
        expect(within(first).queryByTitle(/unique kanji/)).not.toBeInTheDocument();
        // A book without counts shows no kanji detail.
        expect(screen.queryByText("Not in the catalog yet")).not.toBeInTheDocument();
      });

      it("groups by series or by language in the chosen order, books without one last", async () => {
        const user = userEvent.setup();
        await showLibrary(user);
        expect(screen.getByRole("button", { name: "No grouping" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /^(Group by|No grouping)/ }));
        await user.click(screen.getByRole("menuitemradio", { name: /Series/ }));
        const groups = () =>
          Array.from(document.querySelectorAll(".library-group-heading")).map(
            (heading) => heading.textContent,
          );
        // Each group's books and the characters they hold, as the Library's summary.
        expect(groups()).toEqual(["Cat Tales2 books · 220K characters", "No series2 books"]);
        expect(screen.getByRole("link", { name: "See all of Cat Tales" })).toHaveAttribute(
          "href",
          "/library?group=series%3ACat%20Tales",
        );
        // Arrows show only where the row can move, which needs layout (LibraryCarousel.test).
        expect(screen.queryByRole("button", { name: "Previous books in Cat Tales" })).toBeNull();
        expect(libraryTitles()).toEqual([
          "Cat Tales 1",
          "Cat Tales 2",
          "English Book",
          "Plain Book",
        ]);

        // A series's books follow the sort and its direction too.
        await user.click(screen.getByRole("button", { name: "Reverse sort direction" }));
        expect(libraryTitles().slice(0, 2)).toEqual(["Cat Tales 2", "Cat Tales 1"]);

        // Groups follow the sort and its direction: Title reversed, from Z.
        await user.click(screen.getByRole("button", { name: /^(Group by|No grouping)/ }));
        await user.click(screen.getByRole("menuitemradio", { name: /Language/ }));
        expect(groups()).toEqual([
          "Japanese2 books · 220K characters",
          "English1 book",
          "Unknown language1 book",
        ]);
        await user.click(screen.getByRole("button", { name: "Use normal sort direction" }));
        expect(groups()).toEqual([
          "English1 book",
          "Japanese2 books · 220K characters",
          "Unknown language1 book",
        ]);
      });

      it("opens a group's own page from See all, with only its books and a way back", async () => {
        const user = userEvent.setup();
        listMock.mockResolvedValue(detailed);
        renderPage(
          <MemoryRouter initialEntries={["/library"]}>
            <Routes>
              <Route path="/library" element={<LibraryPage />} />
            </Routes>
          </MemoryRouter>,
        );
        await screen.findByRole("heading", { name: "Cat Tales 1" });
        await user.click(screen.getByRole("button", { name: /^(Group by|No grouping)/ }));
        await user.click(screen.getByRole("menuitemradio", { name: /Series/ }));
        await user.click(screen.getByRole("link", { name: "See all of Cat Tales" }));

        const library = await screen.findByRole("region", { name: "Cat Tales" });
        expect(
          within(library)
            .getAllByRole("article")
            .map((article) => within(article).getByRole("heading").textContent),
        ).toEqual(["Cat Tales 1", "Cat Tales 2"]);
        expect(within(library).getByText("2 books")).toBeInTheDocument();
        expect(within(library).getByText("220K characters")).toBeInTheDocument();
        // Its books show as one collection, without Continue reading, carousels, or Group.
        expect(screen.queryByRole("region", { name: "Continue reading" })).not.toBeInTheDocument();
        expect(screen.queryByRole("link", { name: /^See all/ })).not.toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: /^(Group by|No grouping)/ }),
        ).not.toBeInTheDocument();
        // Selection covers only the group's books.
        await user.click(screen.getByRole("checkbox", { name: "Select Cat Tales 2" }));
        await user.keyboard("{Control>}a{/Control}");
        expect(screen.getByText("2 books selected")).toBeInTheDocument();
        // Escape first ends selecting, then goes back to the whole Library; so does Alt+Left.
        await user.keyboard("{Escape}");
        expect(screen.getByRole("region", { name: "Cat Tales" })).toBeInTheDocument();
        await user.keyboard("{Escape}");
        expect(await screen.findByRole("region", { name: "Library" })).toBeInTheDocument();
        await user.click(screen.getByRole("link", { name: "See all of Cat Tales" }));
        await screen.findByRole("region", { name: "Cat Tales" });
        await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
        expect(await screen.findByRole("region", { name: "Library" })).toBeInTheDocument();

        await user.click(screen.getByRole("link", { name: "See all of Cat Tales" }));
        await screen.findByRole("region", { name: "Cat Tales" });
        await user.click(screen.getByRole("link", { name: "Library" }));
        expect(await screen.findByRole("region", { name: "Library" })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "See all of Cat Tales" })).toBeInTheDocument();
      });

      it("keeps a sort of its own on group pages, saved apart from the Library's", async () => {
        const user = userEvent.setup();
        const saved: Partial<AppearancePreferences>[] = [];
        listMock.mockResolvedValue(detailed);
        render(
          <AppearanceProvider
            store={{
              load: async () => ({ librarySort: "added" }),
              save: async (preferences) => void saved.push(preferences),
            }}
          >
            <MemoryRouter initialEntries={["/library"]}>
              <Routes>
                <Route path="/library" element={<LibraryPage />} />
              </Routes>
            </MemoryRouter>
          </AppearanceProvider>,
        );
        const card = (title: string) =>
          within(screen.getByRole("heading", { name: title }).closest("article")!);
        await screen.findByRole("heading", { name: "Cat Tales 1" });
        await screen.findByRole("button", { name: "Sort by Date added" });

        // A group's page starts from its own default, and its changes stay there.
        await user.click(card("Cat Tales 1").getByRole("link", { name: "Cat Tales" }));
        const series = await screen.findByRole("region", { name: "Cat Tales" });
        await user.click(screen.getByRole("button", { name: "Sort by Title" }));
        await user.click(screen.getByRole("menuitemradio", { name: /Date added/ }));
        await user.click(screen.getByRole("button", { name: "Reverse sort direction" }));
        expect(screen.getByRole("button", { name: "Sort by Date added" })).toBeInTheDocument();
        await waitFor(() =>
          expect(saved.at(-1)).toMatchObject({
            librarySort: "added",
            librarySortReversed: false,
            libraryGroupSort: "added",
            libraryGroupSortReversed: true,
          }),
        );
        expect(within(series).getAllByRole("article")).toHaveLength(2);

        // The Library keeps its own sort, and changing it leaves the group's alone.
        await user.click(screen.getByRole("link", { name: "Library" }));
        await screen.findByRole("region", { name: "Library" });
        expect(screen.getByRole("button", { name: "Sort by Date added" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Reverse sort direction" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Sort by Date added" }));
        await user.click(screen.getByRole("menuitemradio", { name: /Title/ }));
        await waitFor(() =>
          expect(saved.at(-1)).toMatchObject({
            librarySort: "title",
            libraryGroupSort: "added",
            libraryGroupSortReversed: true,
          }),
        );
        await user.click(card("Cat Tales 1").getByRole("link", { name: "Cat Tales" }));
        await screen.findByRole("region", { name: "Cat Tales" });
        expect(screen.getByRole("button", { name: "Sort by Date added" })).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: "Use normal sort direction" }),
        ).toBeInTheDocument();
      });

      it("opens a card's series or language from its chip, which selects while selecting", async () => {
        const user = userEvent.setup();
        listMock.mockResolvedValue(detailed);
        renderPage(
          <MemoryRouter initialEntries={["/library"]}>
            <Routes>
              <Route path="/library" element={<LibraryPage />} />
            </Routes>
          </MemoryRouter>,
        );
        await screen.findByRole("heading", { name: "Cat Tales 1" });
        const card = (title: string) =>
          within(screen.getByRole("heading", { name: title }).closest("article")!);
        expect(card("Cat Tales 1").getByRole("link", { name: "Cat Tales" })).toHaveAttribute(
          "href",
          "/library?group=series%3ACat%20Tales",
        );
        expect(card("Cat Tales 1").getByRole("link", { name: "Japanese" })).toHaveAttribute(
          "href",
          "/library?group=language%3Aja",
        );
        // Unique kanji only shows.
        expect(
          card("Cat Tales 1").getByTitle(`${(1700).toLocaleString()} unique kanji`).closest("a"),
        ).toBeNull();

        await user.click(card("Cat Tales 1").getByRole("link", { name: "Cat Tales" }));
        const series = await screen.findByRole("region", { name: "Cat Tales" });
        expect(within(series).getAllByRole("article")).toHaveLength(2);
        // On its own page the series chip only shows; the language chip still opens.
        expect(within(series).queryByRole("link", { name: "Cat Tales" })).toBeNull();
        await user.click(card("Cat Tales 2").getByRole("link", { name: "Japanese" }));
        const japanese = await screen.findByRole("region", { name: "Japanese" });
        expect(
          within(japanese)
            .getAllByRole("article")
            .map((article) => within(article).getByRole("heading").textContent)
            .sort(),
        ).toEqual(["Cat Tales 1", "Cat Tales 2"]);
        expect(within(japanese).queryByRole("link", { name: "Japanese" })).toBeNull();

        // Ctrl+click on a chip selects its book, and while selecting a chip click selects.
        await user.click(screen.getByRole("link", { name: "Library" }));
        await screen.findByRole("region", { name: "Library" });
        await user.keyboard("{Control>}");
        await user.click(card("Cat Tales 1").getByRole("link", { name: "Cat Tales" }));
        await user.keyboard("{/Control}");
        expect(screen.getByText("1 book selected")).toBeInTheDocument();
        expect(card("Cat Tales 2").queryByRole("link", { name: "Japanese" })).toBeNull();
        await user.click(card("Cat Tales 2").getByTitle("Language: Japanese"));
        expect(screen.getByText("2 books selected")).toBeInTheDocument();
        expect(screen.getByRole("region", { name: "Library" })).toBeInTheDocument();
      });

      it("makes the books one Tab stop that the arrows move through, with Space and Shift+F10", async () => {
        const user = userEvent.setup();
        await showLibrary(user);
        const books = document.querySelector<HTMLElement>(".library-sections")!;
        const links = () => within(books).getAllByRole("link", { name: /^Open .* in reader$/ });
        const stops = () =>
          Array.from(books.querySelectorAll<HTMLElement>("a, button, input")).filter(
            (control) => control.tabIndex >= 0,
          );
        expect(links()).toHaveLength(4);
        expect(stops()).toEqual([links()[0]]);

        links()[0].focus();
        await user.keyboard("{ArrowRight}");
        expect(links()[1]).toHaveFocus();
        expect(stops()).toEqual([links()[1]]);
        await user.keyboard("{ArrowDown}");
        expect(links()[2]).toHaveFocus();
        await user.keyboard("{ArrowUp}{ArrowLeft}{ArrowLeft}");
        expect(links()[0]).toHaveFocus();
        expect(stops()).toEqual([links()[0]]);

        await user.keyboard("{Shift>}{F10}{/Shift}");
        const menu = screen.getByRole("menu", { name: "Actions for Cat Tales 1" });
        expect(within(menu).getAllByRole("menuitem")[0]).toHaveFocus();
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(links()[0]).toHaveFocus();

        // Space selects the book and leaves focus on its box, which the arrows then move.
        await user.keyboard(" ");
        const first = screen.getByRole("checkbox", { name: "Select Cat Tales 1" });
        expect(first).toBeChecked();
        expect(first).toHaveFocus();
        expect(stops()).toEqual([first]);
        await user.keyboard("{ArrowRight} ");
        const second = screen.getByRole("checkbox", { name: "Select Cat Tales 2" });
        expect(second).toHaveFocus();
        expect(second).toBeChecked();
        expect(screen.getByText("2 books selected")).toBeInTheDocument();
      });

      it("selects ranges with Shift+click, toggles with Ctrl+click, and handles Ctrl+A and Delete", async () => {
        const user = userEvent.setup();
        await showLibrary(user);
        const articles = () => screen.getAllByRole("article");
        // Ctrl+click on a book starts selecting instead of opening it.
        await user.keyboard("{Control>}");
        await user.click(within(articles()[0]).getByRole("link", { name: /^Open / }));
        await user.keyboard("{/Control}");
        expect(screen.getByText("1 book selected")).toBeInTheDocument();

        await user.keyboard("{Shift>}");
        await user.click(articles()[2]);
        await user.keyboard("{/Shift}");
        expect(screen.getByText("3 books selected")).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: "Select Plain Book" })).not.toBeChecked();

        await user.click(articles()[1]);
        expect(screen.getByText("2 books selected")).toBeInTheDocument();

        await user.keyboard("{Control>}a{/Control}");
        expect(screen.getByText("4 books selected")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Clear" }));
        expect(screen.getByText("0 books selected")).toBeInTheDocument();
        await user.click(articles()[3]);
        await user.keyboard("{Delete}");
        expect(screen.getByRole("alertdialog")).toHaveAccessibleName("Remove 1 book from Komori?");
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        // Select all covers only the books shown.
        await user.click(screen.getByRole("button", { name: "Done selecting" }));
        fireEvent.change(screen.getByRole("searchbox", { name: "Search books" }), {
          target: { value: "cat" },
        });
        await user.click(screen.getByRole("checkbox", { name: "Select Cat Tales 1" }));
        await user.click(screen.getByRole("button", { name: "Select all" }));
        expect(screen.getByText("2 books selected")).toBeInTheDocument();
      });

      it("sets a series by hand in the order shown, or none, or back to the books' own", async () => {
        const user = userEvent.setup();
        vi.mocked(setBookSeries).mockResolvedValue(2);
        vi.mocked(resetBookSeries).mockResolvedValue(2);
        await showLibrary(user);
        await user.click(screen.getByRole("checkbox", { name: "Select Plain Book" }));
        await user.click(screen.getAllByRole("article")[2]);
        await user.click(screen.getByRole("button", { name: "Series…" }));
        const dialog = screen.getByRole("dialog", { name: "Series" });
        const name = within(dialog).getByRole("combobox", { name: "Series name" });
        expect(name).toHaveValue("");
        expect(within(dialog).getByRole("button", { name: "Save series" })).toBeDisabled();
        await user.type(name, "  Two   Books ");
        await user.click(within(dialog).getByRole("button", { name: "Save series" }));
        // Numbered in the order shown, not the order clicked.
        await waitFor(() =>
          expect(setBookSeries).toHaveBeenCalledWith(["english", "plain"], "Two Books"),
        );
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();

        await user.click(screen.getByRole("checkbox", { name: "Select Cat Tales 1" }));
        await user.click(screen.getByRole("button", { name: "Series…" }));
        const again = screen.getByRole("dialog", { name: "Series" });
        expect(within(again).getByRole("combobox", { name: "Series name" })).toHaveValue(
          "Cat Tales",
        );
        await user.click(within(again).getByRole("radio", { name: /From each book/ }));
        await user.click(within(again).getByRole("button", { name: "Save series" }));
        await waitFor(() => expect(resetBookSeries).toHaveBeenCalledWith(["vol-1"]));

        await user.click(screen.getByRole("checkbox", { name: "Select Cat Tales 2" }));
        await user.click(screen.getByRole("button", { name: "Series…" }));
        await user.click(screen.getByRole("radio", { name: /No series/ }));
        await user.click(screen.getByRole("button", { name: "Save series" }));
        await waitFor(() => expect(setBookSeries).toHaveBeenLastCalledWith(["vol-2"], null));
      });
    });
  });
});

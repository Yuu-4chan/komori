import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";

import { AppearanceProvider } from "../features/appearance/AppearanceProvider";
import {
  editBooks,
  listLibrary,
  markBooksCompleted,
  removeBooks,
  setBookSeries,
  type LibraryBook,
} from "../features/library/libraryApi";
import { libraryCache } from "../features/library/libraryCache";
import { MobileLibraryPage } from "./MobileLibraryPage";

vi.mock("../features/library/libraryApi", () => ({
  importBooks: vi.fn(),
  importDroppedBooks: vi.fn(),
  listLibrary: vi.fn(),
  relinkBook: vi.fn(),
  markBooksCompleted: vi.fn(async (ids: string[]) => ids),
  removeBook: vi.fn(async () => true),
  removeBooks: vi.fn(async (ids: string[]) =>
    ids.map((id) => ({ id, status: "removed", message: null })),
  ),
  setBookSeries: vi.fn(async () => 1),
  resetBookSeries: vi.fn(async () => 1),
  editBooks: vi.fn(async () => {}),
  scanLibraryFolders: vi.fn(async () => []),
}));

const reading: LibraryBook = {
  id: "book-1",
  title: "羅生門",
  author: "芥川龍之介",
  fileName: "rashomon.epub",
  importedAt: "2026-09-21T00:00:00Z",
  lastReadAt: "2026-11-01T00:00:00Z",
  availability: "available",
  hasCover: false,
  language: "ja",
  progress: { unit: "characters", current: 2_500, total: 10_000 },
} as LibraryBook;
const finished: LibraryBook = {
  ...reading,
  id: "book-2",
  title: "こころ",
  author: "夏目漱石",
  series: "漱石全集",
  progress: { unit: "characters", current: 10_000, total: 10_000 },
} as LibraryBook;
const gone: LibraryBook = {
  ...reading,
  id: "book-3",
  title: "人間失格",
  author: "太宰治",
  availability: "missing",
  lastReadAt: null,
  progress: null,
} as LibraryBook;

function ReaderRoute() {
  return <p>Reading {useParams().id}</p>;
}

function library(books: LibraryBook[] = [reading, finished, gone]) {
  vi.mocked(listLibrary).mockResolvedValue(books);
  render(
    <AppearanceProvider store={null}>
      <MemoryRouter>
        <Routes>
          <Route element={<MobileLibraryPage />} path="/" />
          <Route element={<MobileLibraryPage />} path="/library" />
          <Route element={<ReaderRoute />} path="/reader/:id" />
        </Routes>
      </MemoryRouter>
    </AppearanceProvider>,
  );
}

const allBooks = () => screen.findByRole("region", { name: "All" });

async function tile(title: string) {
  const books = await allBooks();
  const titles = [...books.querySelectorAll(".mobile-tile__title")];
  return titles.find((each) => each.textContent === title)!.closest("a, button")!;
}

function titles(region: HTMLElement) {
  return [...region.querySelectorAll(".mobile-tile__title")].map((each) => each.textContent);
}

/**
 * A long press, as Android reports it, and the click that follows it on what is there once the
 * press has selected the book. The clock then moves on, as a person's next tap would.
 */
async function longPress(
  element: Element,
  again: () => Element | Promise<Element> = () => element,
) {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  fireEvent.contextMenu(element);
  fireEvent.click(await again());
  vi.spyOn(Date, "now").mockReturnValue(now + 1_000);
}

const closeSheet = () => fireEvent.click(document.querySelector(".mobile-sheet-layer")!);

function bar() {
  return within(screen.getByRole("toolbar", { name: "Library selection" }));
}

function actions() {
  return bar()
    .getAllByRole("button")
    .map((each) => each.textContent);
}

async function view(group: string, choice: string | RegExp) {
  await userEvent.click(screen.getByRole("button", { name: "Library view" }));
  const sheet = screen.getByRole("dialog", { name: "Library view" });
  await userEvent.click(
    within(within(sheet).getByRole("region", { name: group })).getByRole("button", {
      name: choice,
    }),
  );
}

beforeEach(() => libraryCache.reset());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("selecting books on the phone", () => {
  it("selects a book on a long press, not opening it, and more with taps", async () => {
    library();
    await longPress(await tile("羅生門"), () => tile("羅生門"));
    expect(screen.queryByText(/^Reading/)).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("1 book selected");
    expect(actions()).toEqual(["Information", "Series…", "Edit…", "Mark as completed", "Remove"]);

    await userEvent.click(await tile("こころ"));
    expect(screen.queryByText(/^Reading/)).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("2 books selected");
    expect((await tile("こころ")).getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("3 books selected");
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("0 books selected");
    expect(screen.queryByRole("toolbar")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Done selecting" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Library");
    await userEvent.click(await tile("羅生門"));
    expect(screen.getByText("Reading book-1")).toBeTruthy();
  });

  it("marks the books selected completed and lists the Library again", async () => {
    library();
    await longPress(await tile("羅生門"), () => tile("羅生門"));
    await userEvent.click(bar().getByRole("button", { name: "Mark as completed" }));
    expect(markBooksCompleted).toHaveBeenCalledWith(["book-1"]);
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
    expect(listLibrary).toHaveBeenCalledTimes(2);
  });

  it("offers no Mark as completed for a finished book, and renames its series", async () => {
    library();
    await longPress(await tile("こころ"), () => tile("こころ"));
    expect(actions()).toEqual(["Information", "Series…", "Edit…", "Remove"]);
    await userEvent.click(bar().getByRole("button", { name: "Series…" }));
    const dialog = screen.getByRole("dialog", { name: "Series" });
    const name = within(dialog).getByRole("combobox", { name: "Series name" }) as HTMLInputElement;
    expect(name.value).toBe("漱石全集");
    await userEvent.clear(name);
    await userEvent.type(name, "夏目漱石");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save series" }));
    expect(setBookSeries).toHaveBeenCalledWith(["book-2"], "夏目漱石");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("edits the title and author, and removes the books selected after asking", async () => {
    library();
    await longPress(await tile("羅生門"), () => tile("羅生門"));
    await userEvent.click(bar().getByRole("button", { name: "Edit…" }));
    const edit = screen.getByRole("dialog", { name: "Title and author" });
    const title = within(edit).getByRole("textbox", { name: "Title" });
    await userEvent.type(title, "（改）");
    await userEvent.click(within(edit).getByRole("button", { name: "Save" }));
    expect(vi.mocked(editBooks).mock.calls[0]?.[0]?.[0]).toMatchObject({
      id: "book-1",
      title: "羅生門（改）",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await longPress(await tile("羅生門"), () => tile("羅生門"));
    await userEvent.click(await tile("人間失格"));
    await userEvent.click(bar().getByRole("button", { name: "Remove" }));
    const confirm = screen.getByRole("alertdialog", { name: "Remove 2 books from Komori?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove 2 books" }));
    expect(removeBooks).toHaveBeenCalledWith(["book-3", "book-1"]);
    await waitFor(() =>
      expect(titles(screen.getByRole("region", { name: "All" }))).toEqual(["こころ"]),
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("offers Relink and Remove for a book whose file is gone, and selects it on a long press", async () => {
    library();
    await userEvent.click(await tile("人間失格"));
    expect(screen.getByRole("button", { name: "Relink EPUB…" })).toBeTruthy();
    closeSheet();
    await longPress(await tile("人間失格"), () => tile("人間失格"));
    expect(screen.queryByRole("button", { name: "Relink EPUB…" })).toBeNull();
    expect(actions()).toEqual(["Information", "Series…", "Edit…", "Remove"]);
  });
});

describe("the phone Library's view", () => {
  it("filters by status, sorts either way and shows a list, saved as chosen", async () => {
    library();
    const books = await allBooks();
    await waitFor(() => expect(titles(books)).toHaveLength(3));
    expect(screen.getByRole("button", { name: "Library view" }).className).not.toContain(
      "--active",
    );

    await view("Status filter", "Completed");
    expect(titles(books)).toEqual(["こころ"]);
    expect(books.textContent).toContain("1 book");
    expect(screen.queryByRole("region", { name: "Continue reading" })).toBeNull();
    expect(screen.getByRole("button", { name: "Library view" }).className).toContain("--active");
    await userEvent.click(
      within(screen.getByRole("region", { name: "Status filter" })).getByRole("button", {
        name: "All books",
      }),
    );

    const sorted = titles(books);
    await userEvent.click(
      within(screen.getByRole("region", { name: "Sort books" })).getByRole("button", {
        name: "Reverse order",
      }),
    );
    expect(titles(books)).toEqual([...sorted].reverse());

    await userEvent.click(
      within(screen.getByRole("region", { name: "Library layout" })).getByRole("button", {
        name: "List view",
      }),
    );
    expect(books.querySelectorAll(".mobile-book-row")).toHaveLength(3);
    expect(books.querySelector(".mobile-tile")).toBeNull();
  });

  it("shows the characters read beside each book's percentage, short on a tile", async () => {
    library();
    const books = await allBooks();
    await waitFor(() => expect(titles(books)).toHaveLength(3));
    const counts = [...books.querySelectorAll(".mobile-progress__count")].map(
      (each) => each.textContent,
    );
    expect(counts).toEqual(expect.arrayContaining(["2,500 / 10,000 Ch.", "10,000 / 10,000 Ch."]));
    // The list has the room for the whole word.
    await view("Library layout", "List view");
    expect(books.querySelector(".mobile-progress__count")!.textContent).toMatch(/ characters$/);
    expect(books.textContent).not.toContain("漱石全集");
  });

  it("shows Information for one selected book, whose series opens the series' page", async () => {
    library();
    await longPress(await tile("こころ"), () => tile("こころ"));
    expect(actions()[0]).toBe("Information");
    await userEvent.click(await tile("羅生門"));
    expect(actions()).not.toContain("Information");
    await userEvent.click(await tile("羅生門"));

    await userEvent.click(bar().getByRole("button", { name: "Information" }));
    const sheet = within(screen.getByRole("dialog", { name: "Information" }));
    expect(sheet.getByText("夏目漱石")).toBeTruthy();
    expect(sheet.getByText("Japanese")).toBeTruthy();
    expect(sheet.getByText("Completed · 10,000 / 10,000 characters")).toBeTruthy();

    await userEvent.click(sheet.getByRole("button", { name: "漱石全集" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("漱石全集"),
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.queryByRole("region", { name: "Continue reading" })).toBeNull();
    expect(titles(await allBooks())).toEqual(["こころ"]);
    expect((await allBooks()).textContent).toContain("1 book");
    // Its view has no grouping, as on the PC.
    await userEvent.click(screen.getByRole("button", { name: "Library view" }));
    const viewSheet = screen.getByRole("dialog", { name: "Library view" });
    expect(within(viewSheet).queryByRole("region", { name: "Group books" })).toBeNull();
    expect(within(viewSheet).getByRole("region", { name: "Sort books" })).toBeTruthy();
  });

  it("groups by series under headings, and a heading selects its books", async () => {
    library();
    await allBooks();
    await view("Group books", "Series");
    closeSheet();
    const books = await allBooks();
    const headings = [...books.querySelectorAll(".mobile-group-heading")].map(
      (each) => each.textContent,
    );
    expect(headings).toEqual(["漱石全集1 book", "No series2 books"]);
    // Each group's books are a row of their own, its heading a link to the group's page.
    const rows = [...books.querySelectorAll(".mobile-carousel")].map((row) =>
      titles(row as HTMLElement),
    );
    expect(rows).toEqual([["こころ"], expect.arrayContaining(["羅生門", "人間失格"])]);
    expect(books.querySelector(".mobile-group-heading__link")!.getAttribute("href")).toBe(
      `/library?group=${encodeURIComponent("series:漱石全集")}`,
    );

    await longPress(
      books.querySelectorAll(".mobile-group-heading__link")[1]!,
      () => books.querySelectorAll(".mobile-group-heading")[1]!,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("2 books selected");
    const series = screen.getByRole("button", { name: /^漱石全集/ });
    await userEvent.click(series);
    expect(series.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("3 books selected");
    await userEvent.click(series);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("2 books selected");

    // Removing a group: the books selected leave their series.
    await userEvent.click(series);
    await userEvent.click(bar().getByRole("button", { name: "Series…" }));
    const dialog = screen.getByRole("dialog", { name: "Series" });
    await userEvent.click(within(dialog).getByRole("radio", { name: /No series/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save series" }));
    expect(setBookSeries).toHaveBeenCalledWith(
      expect.arrayContaining(["book-1", "book-2", "book-3"]),
      null,
    );
  });
});

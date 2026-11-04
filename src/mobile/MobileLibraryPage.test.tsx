import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";

import { AppearanceProvider } from "../features/appearance/AppearanceProvider";
import {
  editBooks,
  listLibrary,
  markBooksCompleted,
  removeBook,
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
  progress: { unit: "characters", current: 2_500, total: 10_000 },
} as LibraryBook;
const finished: LibraryBook = {
  ...reading,
  id: "book-2",
  title: "こころ",
  series: "漱石",
  progress: { unit: "characters", current: 10_000, total: 10_000 },
} as LibraryBook;
const gone: LibraryBook = {
  ...reading,
  id: "book-3",
  title: "人間失格",
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
          <Route element={<ReaderRoute />} path="/reader/:id" />
        </Routes>
      </MemoryRouter>
    </AppearanceProvider>,
  );
}

async function tile(title: string) {
  const books = await screen.findByRole("region", { name: "All books" });
  const titles = [...books.querySelectorAll(".mobile-tile__title")];
  return titles.find((each) => each.textContent === title)!.closest("a, button")!;
}

beforeEach(() => libraryCache.reset());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("a long press on a book on the phone", () => {
  it("opens its sheet, under its cover and progress, and not the book", async () => {
    library();
    const book = await tile("羅生門");
    fireEvent.contextMenu(book);
    fireEvent.click(book);
    const sheet = screen.getByRole("dialog", { name: "羅生門" });
    expect(screen.queryByText(/^Reading/)).toBeNull();
    expect(sheet.textContent).toContain("芥川龍之介");
    expect(sheet.textContent).toContain("25% · 2,500 / 10,000");
    expect(
      within(sheet)
        .getAllByRole("button")
        .concat(within(sheet).getAllByRole("link"))
        .map((action) => action.textContent),
    ).toEqual(
      expect.arrayContaining([
        "Continue reading",
        "Edit…",
        "SeriesNo series",
        "Mark as completed",
        "Remove from library",
      ]),
    );
    await userEvent.click(within(sheet).getByRole("link", { name: "Continue reading" }));
    expect(screen.getByText("Reading book-1")).toBeTruthy();
  });

  it("marks a book completed and lists the Library again", async () => {
    library();
    fireEvent.contextMenu(await tile("羅生門"));
    await userEvent.click(screen.getByRole("button", { name: "Mark as completed" }));
    expect(markBooksCompleted).toHaveBeenCalledWith(["book-1"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(listLibrary).toHaveBeenCalledTimes(2);
  });

  it("offers Read again and the series for a finished book, without Mark as completed", async () => {
    library();
    fireEvent.contextMenu(await tile("こころ"));
    const sheet = screen.getByRole("dialog", { name: "こころ" });
    expect(within(sheet).getByRole("link").textContent).toBe("Read again");
    expect(within(sheet).queryByRole("button", { name: "Mark as completed" })).toBeNull();
    await userEvent.click(within(sheet).getByRole("button", { name: /^Series/ }));
    const dialog = screen.getByRole("dialog", { name: "Series" });
    const name = within(dialog).getByRole("combobox", { name: "Series name" }) as HTMLInputElement;
    expect(name.value).toBe("漱石");
    await userEvent.clear(name);
    await userEvent.type(name, "夏目漱石");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save series" }));
    expect(setBookSeries).toHaveBeenCalledWith(["book-2"], "夏目漱石");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("edits the title and author, and removes the book after asking", async () => {
    library();
    fireEvent.contextMenu(await tile("羅生門"));
    await userEvent.click(screen.getByRole("button", { name: "Edit…" }));
    const edit = screen.getByRole("dialog", { name: "Title and author" });
    const title = within(edit).getByRole("textbox", { name: "Title" });
    await userEvent.type(title, "（改）");
    await userEvent.click(within(edit).getByRole("button", { name: "Save" }));
    expect(vi.mocked(editBooks).mock.calls[0]?.[0]?.[0]).toMatchObject({
      id: "book-1",
      title: "羅生門（改）",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.contextMenu(await tile("羅生門"));
    await userEvent.click(screen.getByRole("button", { name: "Remove from library" }));
    const confirm = screen.getByRole("alertdialog", { name: "Remove this book from Komori?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove from library" }));
    expect(removeBook).toHaveBeenCalledWith("book-1");
  });

  it("offers Relink and Remove for a book whose file is gone", async () => {
    library();
    fireEvent.contextMenu(await tile("人間失格"));
    expect(screen.getByRole("button", { name: "Relink EPUB…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
  });
});

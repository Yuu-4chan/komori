import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../features/appearance/AppearanceProvider";
import { listLibrary, type LibraryBook } from "../features/library/libraryApi";
import { libraryCache } from "../features/library/libraryCache";
import { pcSession } from "./pcLibrarySession";
import * as api from "./pcLinkApi";

vi.mock("../features/library/libraryApi", () => ({
  importBooks: vi.fn(),
  importDroppedBooks: vi.fn(),
  listLibrary: vi.fn(),
  scanLibraryFolders: vi.fn(async () => []),
}));
vi.mock("./pcLinkApi", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  usePcLink: vi.fn(),
  listPcLibrary: vi.fn(),
  cachedPcLibrary: vi.fn(async () => null),
  openPcBook: vi.fn(),
  keepPcBook: vi.fn(),
  removePcBook: vi.fn(async () => {}),
  onPcTransfer: vi.fn(async () => () => {}),
  syncPc: vi.fn(),
  autoSync: vi.fn(async () => null),
}));

const { MobileLibraryPage } = await import("./MobileLibraryPage");

const own: LibraryBook = {
  id: "phone-1",
  title: "羅生門",
  author: "芥川龍之介",
  fileName: "rashomon.epub",
  importedAt: "2026-09-21T00:00:00Z",
  availability: "available",
  hasCover: false,
};
const copied: LibraryBook = { ...own, id: "phone-2", title: "三四郎", fromPc: true };

const remote: api.PcBook = {
  id: "pc-1",
  title: "それから",
  author: "夏目漱石",
  fileName: "sorekara.epub",
  size: 1000,
  cover: null,
  coverUrl: null,
  progress: null,
  lastReadAt: null,
  series: null,
  seriesIndex: null,
  language: "ja",
  localId: null,
  onPhone: false,
  kept: false,
};
const kept: api.PcBook = {
  ...remote,
  id: "pc-2",
  title: "三四郎",
  progress: { unit: "characters", current: 1200, total: 10_000 },
  lastReadAt: "2026-11-02T00:00:00Z",
  localId: "phone-2",
  onPhone: true,
  kept: true,
};

function ReaderRoute() {
  return <p>Reading {useParams().id}</p>;
}

function page() {
  return render(
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

function library(link: api.PcLink | null, books: LibraryBook[] = [own, copied]) {
  vi.mocked(api.usePcLink).mockReturnValue(link);
  vi.mocked(listLibrary).mockResolvedValue(books);
  vi.mocked(api.listPcLibrary).mockResolvedValue([remote, kept]);
  return page();
}

const paired: api.PcLink = {
  address: "192.168.0.10",
  port: 39_217,
  paired: true,
  pcName: "KOMORI-PC",
  syncOn: true,
  lastSynced: null,
};

const allBooks = () => screen.findByRole("region", { name: "All books" });

function titles(region: HTMLElement) {
  return [...region.querySelectorAll(".mobile-tile__title")].map((each) => each.textContent);
}

function tile(region: HTMLElement, title: string) {
  return [...region.querySelectorAll(".mobile-tile__title")]
    .find((each) => each.textContent === title)!
    .closest("button")!;
}

beforeEach(() => {
  libraryCache.reset();
  pcSession.reset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the Library on a phone paired with a PC", () => {
  it("lists the PC's books with the phone's own, each copy once, with pills to choose", async () => {
    library(paired);
    const books = await allBooks();
    await waitFor(() => expect(titles(books)).toEqual(["それから", "三四郎", "羅生門"]));
    expect(within(books).getByRole("img", { name: "On this phone" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "KOMORI-PC" })).toBeNull();
    expect(screen.getByRole("searchbox").getAttribute("placeholder")).not.toContain("KOMORI-PC");

    await userEvent.click(within(books).getByRole("button", { name: "On PC · 2" }));
    expect(titles(books)).toEqual(["それから", "三四郎"]);
    await userEvent.click(within(books).getByRole("button", { name: "On this phone · 2" }));
    expect(titles(books)).toEqual(["三四郎", "羅生門"]);
    await userEvent.click(within(books).getByRole("button", { name: "All · 3" }));
    expect(titles(books)).toEqual(["それから", "三四郎", "羅生門"]);
  });

  it("sums the books and their characters and words of the chosen pill under the title", async () => {
    vi.mocked(api.usePcLink).mockReturnValue(paired);
    vi.mocked(listLibrary).mockResolvedValue([{ ...own, characters: 500 }, copied]);
    vi.mocked(api.listPcLibrary).mockResolvedValue([
      { ...remote, characters: 1000 },
      { ...kept, characters: 2000 },
      { ...remote, id: "pc-3", title: "Kokoro", language: "en", words: 300 },
    ]);
    page();
    const summary = () => document.querySelector(".mobile-header__summary")!;
    await waitFor(() => expect(summary().textContent).toBe("4 books3.5K characters300 words"));
    expect(summary().closest(".mobile-header__row")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "On this phone · 2" }));
    expect(summary().textContent).toBe("2 books2.5K characters");
    await userEvent.click(screen.getByRole("button", { name: "On PC · 3" }));
    expect(summary().textContent).toBe("3 books3K characters300 words");
  });

  it("shows the saved listing at once, and Connected once the PC answers", async () => {
    const minutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    vi.mocked(api.cachedPcLibrary).mockResolvedValueOnce([remote, kept]);
    let answer: (books: api.PcBook[]) => void = () => {};
    library({ ...paired, lastSynced: minutesAgo });
    vi.mocked(api.listPcLibrary).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const books = await allBooks();
    await waitFor(() => expect(titles(books)).toEqual(["それから", "三四郎", "羅生門"]));
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getByText("Synced 5 minutes ago")).toBeTruthy();
    expect(screen.queryByText("Connecting…")).toBeNull();

    await act(async () => answer([remote, kept, { ...remote, id: "pc-3", title: "門" }]));
    const status = await screen.findByText("Connected");
    expect(status.parentElement!.textContent).toBe("Connected · Synced 5 minutes ago");
    expect(titles(books)).toEqual(["それから", "三四郎", "羅生門", "門"]);
  });

  it("shows the books at once on returning, without listing the PC again", async () => {
    const first = library(paired);
    await waitFor(async () => expect(titles(await allBooks())).toHaveLength(3));
    first.unmount();

    page();
    // The first render already has every book: nothing loads on returning.
    expect(titles(screen.getByRole("region", { name: "All books" }))).toHaveLength(3);
    expect(screen.getByText("Connected")).toBeTruthy();
    await waitFor(() => expect(listLibrary).toHaveBeenCalledTimes(2));
    expect(api.listPcLibrary).toHaveBeenCalledTimes(1);
  });

  it("keeps the books and says why when the PC does not answer", async () => {
    vi.mocked(api.cachedPcLibrary).mockResolvedValueOnce([remote, kept]);
    library(paired);
    vi.mocked(api.listPcLibrary).mockRejectedValueOnce(new Error("unreachable"));
    const books = await allBooks();
    await screen.findByRole("button", { name: "Try again" });
    expect(titles(books)).toEqual(["それから", "三四郎", "羅生門"]);

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Connected")).toBeTruthy();
  });

  it("syncs now, listing both Libraries again", async () => {
    const minutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    library({ ...paired, lastSynced: minutesAgo });
    vi.mocked(api.syncPc).mockImplementation(async () => {
      const result = { ...paired, lastSynced: minutesAgo, changed: true, moved: [] };
      window.dispatchEvent(new CustomEvent(api.pcSynced, { detail: result }));
      return result;
    });
    await screen.findByText("Connected");
    expect(listLibrary).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(api.syncPc).toHaveBeenCalled();
    await waitFor(() => expect(api.listPcLibrary).toHaveBeenCalledTimes(2));
    expect(listLibrary).toHaveBeenCalledTimes(2);
  });

  it("continues every book in progress, read last first", async () => {
    const reading: LibraryBook = {
      ...own,
      progress: { unit: "characters", current: 100, total: 1000 },
      lastReadAt: "2026-11-03T00:00:00Z",
    };
    library(paired, [reading, copied]);
    const shelf = await screen.findByRole("region", { name: "Continue reading" });
    await waitFor(() =>
      expect([...shelf.querySelectorAll("strong")].map((each) => each.textContent)).toEqual([
        "羅生門",
        "三四郎",
      ]),
    );
    expect(within(shelf).getByText("2 books in progress")).toBeTruthy();
    // The PC's book shows how much was read as the phone's own does.
    expect(
      [...shelf.querySelectorAll(".mobile-continue__count")].map((each) => each.textContent),
    ).toEqual(["100 / 1,000 characters", "1,200 / 10,000 characters"]);
  });

  it("is only the phone's books unpaired or with Sync with PC off", async () => {
    library({ ...paired, syncOn: false });
    const books = await allBooks();
    await waitFor(() => expect(titles(books)).toEqual(["三四郎", "羅生門"]));
    expect(screen.queryByRole("button", { name: /^All · / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
    expect(api.listPcLibrary).not.toHaveBeenCalled();
  });

  it("opens a book tapped once it is here, and keeps one from its badge", async () => {
    library(paired);
    vi.mocked(api.openPcBook).mockResolvedValue("phone-9");
    vi.mocked(api.keepPcBook).mockResolvedValue("phone-9");
    vi.mocked(api.cachedPcLibrary).mockResolvedValue([{ ...remote, localId: "phone-9" }, kept]);
    const books = await allBooks();
    await waitFor(() => expect(titles(books)).toHaveLength(3));

    await userEvent.click(within(books).getByRole("button", { name: "Keep on this phone" }));
    expect(api.keepPcBook).toHaveBeenCalledWith(remote);
    // The copies are read again from the phone, without asking the PC.
    await waitFor(() => expect(api.cachedPcLibrary).toHaveBeenCalled());
    expect(api.listPcLibrary).toHaveBeenCalledTimes(1);

    vi.mocked(api.autoSync).mockClear();
    await userEvent.click(tile(books, "それから"));
    expect(api.openPcBook).toHaveBeenCalled();
    expect(await screen.findByText("Reading phone-9")).toBeTruthy();
  });

  it("syncs a copy made just now before opening it", async () => {
    library(paired);
    vi.mocked(api.openPcBook).mockResolvedValue("phone-9");
    const books = await allBooks();
    await waitFor(() => expect(titles(books)).toHaveLength(3));
    await userEvent.click(tile(books, "それから"));
    expect(await screen.findByText("Reading phone-9")).toBeTruthy();
    expect(api.autoSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.autoSync).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(api.openPcBook).mock.invocationCallOrder[0],
    );
  });

  it("renders only the books near the view of a large PC Library, following the scroll", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    // jsdom has no layout: the grid moves up as its scroll container scrolls.
    let scroller: HTMLElement | null = null;
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const top = this.classList.contains("mobile-library__grid")
          ? -(scroller?.scrollTop ?? 0)
          : 0;
        return { top, bottom: top, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
      });
    try {
      vi.mocked(api.usePcLink).mockReturnValue(paired);
      vi.mocked(listLibrary).mockResolvedValue([own]);
      vi.mocked(api.listPcLibrary).mockResolvedValue(
        Array.from({ length: 600 }, (_, index) => ({
          ...remote,
          id: `pc-${index}`,
          title: `Book ${String(index).padStart(3, "0")}`,
        })),
      );
      render(
        <AppearanceProvider store={null}>
          <MemoryRouter>
            <div style={{ overflowY: "auto" }}>
              <MobileLibraryPage />
            </div>
          </MemoryRouter>
        </AppearanceProvider>,
      );
      expect(await screen.findByRole("button", { name: "All · 601" })).toBeTruthy();
      const books = await allBooks();
      await waitFor(() => expect(titles(books)[0]).toBe("Book 000"));
      expect(titles(books).length).toBeLessThan(60);
      expect(titles(books)).not.toContain("Book 599");

      scroller = books
        .querySelector<HTMLElement>(".mobile-library__grid")!
        .closest<HTMLElement>("[style*=overflow]")!;
      scroller.scrollTop = 54_000;
      fireEvent.scroll(scroller);
      await waitFor(() => expect(titles(books)).toContain("羅生門"));
      expect(titles(books)).not.toContain("Book 000");
      expect(titles(books).length).toBeLessThan(60);
    } finally {
      height.mockRestore();
      rect.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("offers opening, keeping and removing the copy here on a long press", async () => {
    library(paired);
    const books = await allBooks();
    await waitFor(() => expect(titles(books)).toHaveLength(3));
    const book = tile(books, "三四郎");
    fireEvent.contextMenu(book);
    fireEvent.click(book);
    expect(api.openPcBook).not.toHaveBeenCalled();
    const sheet = screen.getByRole("dialog", { name: "三四郎" });
    expect(
      within(sheet)
        .getAllByRole("button")
        .map((each) => each.textContent),
    ).toEqual(["Continue reading", "Remove from this phone"]);
    await userEvent.click(within(sheet).getByRole("button", { name: "Remove from this phone" }));
    expect(api.removePcBook).toHaveBeenCalledWith(kept);
  });
});

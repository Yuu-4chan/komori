import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../features/appearance/AppearanceProvider";
import { listLibrary, type LibraryBook } from "../features/library/libraryApi";
import { libraryCache } from "../features/library/libraryCache";
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

function library(link: api.PcLink | null) {
  vi.mocked(api.usePcLink).mockReturnValue(link);
  vi.mocked(listLibrary).mockResolvedValue([own, copied]);
  vi.mocked(api.listPcLibrary).mockResolvedValue([remote, kept]);
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

const paired: api.PcLink = {
  address: "192.168.0.10",
  port: 39_217,
  paired: true,
  pcName: "KOMORI-PC",
  syncOn: true,
  lastSynced: null,
};

async function pcTab() {
  await userEvent.click(await screen.findByRole("button", { name: "KOMORI-PC" }));
  return screen.findByRole("region", { name: "KOMORI-PC" });
}

function titles(region: HTMLElement) {
  return [...region.querySelectorAll(".mobile-tile__title")].map((each) => each.textContent);
}

beforeEach(() => libraryCache.reset());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the PC's Library on the phone", () => {
  it("is a tab of its own while paired with Sync with PC on", async () => {
    library(paired);
    const phone = await screen.findByRole("region", { name: "All books" });
    // Books copied from the PC stay in its tab.
    expect(titles(phone)).toEqual(["羅生門"]);
    expect(api.listPcLibrary).not.toHaveBeenCalled();

    const pc = await pcTab();
    expect(titles(pc)).toEqual(["それから", "三四郎"]);
    expect(within(pc).getByRole("button", { name: "All · 2" })).toBeTruthy();
    expect(within(pc).getByRole("img", { name: "On this phone" })).toBeTruthy();
    expect(screen.getByText("Last read on KOMORI-PC")).toBeTruthy();
    expect(screen.getByRole("searchbox").getAttribute("placeholder")).toBe("Search KOMORI-PC");

    await userEvent.click(within(pc).getByRole("button", { name: "On this phone · 1" }));
    expect(titles(pc)).toEqual(["三四郎"]);
  });

  it("shows when it last synced, and syncs now, listing both Libraries again", async () => {
    const minutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    library({ ...paired, lastSynced: minutesAgo });
    vi.mocked(api.syncPc).mockImplementation(async () => {
      const result = { ...paired, lastSynced: minutesAgo, changed: true, moved: [] };
      window.dispatchEvent(new CustomEvent(api.pcSynced, { detail: result }));
      return result;
    });
    await pcTab();
    const status = await screen.findByText("Connected");
    expect(status.parentElement!.textContent).toBe("Connected · Synced 5 minutes ago");
    expect(listLibrary).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(api.syncPc).toHaveBeenCalled();
    await waitFor(() => expect(api.listPcLibrary).toHaveBeenCalledTimes(2));
    expect(listLibrary).toHaveBeenCalledTimes(2);
  });

  it("is not there unpaired or with Sync with PC off", async () => {
    library({ ...paired, syncOn: false });
    const phone = await screen.findByRole("region", { name: "All books" });
    expect(titles(phone)).toEqual(["三四郎", "羅生門"]);
    expect(screen.queryByRole("button", { name: "KOMORI-PC" })).toBeNull();
  });

  it("opens a book tapped once it is here, and keeps one from its badge", async () => {
    library(paired);
    vi.mocked(api.openPcBook).mockResolvedValue("phone-9");
    vi.mocked(api.keepPcBook).mockResolvedValue("phone-9");
    const pc = await pcTab();

    await userEvent.click(within(pc).getByRole("button", { name: "Keep on this phone" }));
    expect(api.keepPcBook).toHaveBeenCalledWith(remote);
    await waitFor(() => expect(api.listPcLibrary).toHaveBeenCalledTimes(2));

    const book = [...pc.querySelectorAll(".mobile-tile__title")]
      .find((each) => each.textContent === "それから")!
      .closest("button")!;
    await userEvent.click(book);
    expect(api.openPcBook).toHaveBeenCalledWith(remote);
    expect(await screen.findByText("Reading phone-9")).toBeTruthy();
    // Each copy made just now syncs, so it opens at the PC's place.
    expect(api.autoSync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.autoSync).mock.invocationCallOrder[1]).toBeGreaterThan(
      vi.mocked(api.openPcBook).mock.invocationCallOrder[0],
    );
  });

  it("offers opening, keeping and removing the copy here on a long press", async () => {
    library(paired);
    const pc = await pcTab();
    const book = [...pc.querySelectorAll(".mobile-tile__title")]
      .find((each) => each.textContent === "三四郎")!
      .closest("button")!;
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listLibrary, type LibraryBook } from "../features/library/libraryApi";
import { libraryCache } from "../features/library/libraryCache";
import { listLibraryKanji, listPcLibraryKanji } from "../features/statistics/statisticsApi";
import { mobileStatisticsSource } from "./mobileStatisticsSource";
import * as api from "./pcLinkApi";
import { pcSession } from "./pcLibrarySession";

vi.mock("../features/library/libraryApi", () => ({ listLibrary: vi.fn() }));
vi.mock("../features/statistics/statisticsApi", () => ({
  listLibraryKanji: vi.fn().mockResolvedValue([]),
  listPcLibraryKanji: vi.fn().mockResolvedValue([]),
}));
vi.mock("./pcLinkApi", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getPcLink: vi.fn(),
  cachedPcLibrary: vi.fn(),
}));

const own: LibraryBook = {
  id: "phone-1",
  title: "羅生門",
  author: null,
  fileName: "rashomon.epub",
  importedAt: "2026-09-21T00:00:00Z",
  availability: "available",
  hasCover: false,
  language: "ja",
  characters: 500,
};
const copy: LibraryBook = {
  ...own,
  id: "phone-2",
  title: "三四郎",
  fromPc: true,
  characters: 2000,
};
const pcBook: api.PcBook = {
  id: "pc-1",
  title: "それから",
  author: null,
  fileName: "sorekara.epub",
  size: 1000,
  cover: null,
  coverUrl: null,
  progress: null,
  lastReadAt: null,
  series: null,
  seriesIndex: null,
  language: "ja",
  characters: 1000,
  localId: null,
  onPhone: false,
  kept: false,
};
const kept: api.PcBook = { ...pcBook, id: "pc-2", title: "三四郎", localId: "phone-2", kept: true };
const link = (syncOn: boolean): api.PcLink => ({
  address: "192.168.0.2",
  port: 7461,
  paired: true,
  pcName: "KOMORI-PC",
  syncOn,
  lastSynced: null,
});

beforeEach(() => {
  libraryCache.reset();
  pcSession.reset();
  vi.mocked(listLibrary).mockResolvedValue([own, copy]);
  vi.mocked(api.cachedPcLibrary).mockResolvedValue([pcBook, kept]);
});
afterEach(() => vi.clearAllMocks());

describe("Statistics on the phone", () => {
  it("counts the PC's books with the phone's, each copy once, as the PC's", async () => {
    vi.mocked(api.getPcLink).mockResolvedValue(link(true));
    const books = await mobileStatisticsSource.books();
    expect(books.map((book) => [book.id, book.characters])).toEqual([
      ["phone-1", 500],
      ["pc-1", 1000],
      ["pc-2", 1000],
    ]);
    // The Library keeps only the phone's own catalog.
    expect(libraryCache.books()?.map((book) => book.id)).toEqual(["phone-1", "phone-2"]);
    await mobileStatisticsSource.kanji();
    expect(listPcLibraryKanji).toHaveBeenCalled();
    expect(listLibraryKanji).not.toHaveBeenCalled();
  });

  it("counts the phone's books alone with Sync with PC off", async () => {
    vi.mocked(api.getPcLink).mockResolvedValue(link(false));
    const books = await mobileStatisticsSource.books();
    expect(books.map((book) => book.id)).toEqual(["phone-1", "phone-2"]);
    expect(api.cachedPcLibrary).not.toHaveBeenCalled();
    await mobileStatisticsSource.kanji();
    expect(listLibraryKanji).toHaveBeenCalled();
    expect(listPcLibraryKanji).not.toHaveBeenCalled();
  });
});

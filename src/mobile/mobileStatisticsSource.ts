import { listLibrary } from "../features/library/libraryApi";
import { libraryCache } from "../features/library/libraryCache";
import { listLibraryKanji, listPcLibraryKanji } from "../features/statistics/statisticsApi";
import type { StatisticsSource } from "../features/statistics/statisticsSource";
import { asLibraryBook, cachedPcLibrary, getPcLink } from "./pcLinkApi";
import { pcSession } from "./pcLibrarySession";
import { mergePcLibrary } from "./pcLibraryMerge";

const syncing = async () => {
  const link = await getPcLink().catch(() => null);
  return link?.paired === true && link.syncOn;
};

/**
 * Statistics on the phone counts the books the Library's All lists: paired with Sync with PC on,
 * the phone's and the PC's (from its last listing), each copy of a PC book once, as the PC's.
 */
export const mobileStatisticsSource: StatisticsSource = {
  async books() {
    const [own, withPc] = await Promise.all([listLibrary(), syncing()]);
    libraryCache.setBooks(own);
    if (!withPc) return own;
    const listed = pcSession.get().books ?? (await cachedPcLibrary().catch(() => null));
    const entries = listed?.map((pc) => ({ pc, book: asLibraryBook(pc) })) ?? null;
    return mergePcLibrary(own, entries).map((item) => item.book);
  },
  async kanji() {
    return (await syncing()) ? listPcLibraryKanji() : listLibraryKanji();
  },
};

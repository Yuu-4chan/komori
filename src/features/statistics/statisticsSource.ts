import { createContext } from "react";

import { listLibrary, type LibraryBook } from "../library/libraryApi";
import { libraryCache } from "../library/libraryCache";
import { listLibraryKanji, type LibraryKanji } from "./statisticsApi";

/** The books and kanji Statistics counts. */
export interface StatisticsSource {
  books(): Promise<LibraryBook[]>;
  kanji(): Promise<LibraryKanji[]>;
}

/** The Library's books and their kanji, as on the PC. */
export const libraryStatisticsSource: StatisticsSource = {
  async books() {
    const books = await listLibrary();
    libraryCache.setBooks(books);
    return books;
  },
  kanji: listLibraryKanji,
};

/** What Statistics counts; the phone's frame adds the paired PC's books. */
export const StatisticsSourceContext = createContext<StatisticsSource>(libraryStatisticsSource);

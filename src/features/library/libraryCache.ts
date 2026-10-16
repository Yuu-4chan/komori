import type { LibraryBook } from "./libraryApi";

/**
 * Where a scrolled list was left: its scroll offset, and the row at the top of the view with
 * how far above the view's top that row began. Returning restores the row, so books or a
 * shelf that grew above it meanwhile do not move the books the reader was looking at.
 */
export interface ScrollPlace {
  scrollTop: number;
  anchor?: { key: string; offset: number };
}

/** Navigation state of a return to the Library (the Reader's Back to Library). */
export const libraryReturn = { libraryReturn: true } as const;
export const isLibraryReturn = (state: unknown) =>
  typeof state === "object" && state !== null && "libraryReturn" in state;

/**
 * The last catalog the Library listed, where each of its pages (the whole Library and each
 * group's page) was scrolled and how far each group's row of books was scrolled sideways, and
 * which Library page was shown last, all kept for the session so returning to the Library (from
 * the Reader or another page) shows it at once, where it was left, while it lists the catalog
 * again.
 */
let books: LibraryBook[] | null = null;
let places = new Map<string, ScrollPlace>();
let rowOffsets = new Map<string, number>();
let lastPage = "/library";

export const libraryCache = {
  books: () => books,
  setBooks(value: LibraryBook[]) {
    books = value;
  },
  /** `page` is the group's key, or "" for the whole Library. */
  place: (page: string) => places.get(page),
  setPlace(page: string, place: ScrollPlace) {
    places.set(page, place);
  },
  rowOffset: (key: string) => rowOffsets.get(key),
  setRowOffset(key: string, offset: number) {
    rowOffsets.set(key, offset);
  },
  /** The Library page shown last, which the Reader's Back to Library returns to. */
  lastPage: () => lastPage,
  setLastPage(path: string) {
    lastPage = path;
  },
  /** For tests, which each start from an empty session. */
  reset() {
    books = null;
    places = new Map();
    rowOffsets = new Map();
    lastPage = "/library";
  },
};

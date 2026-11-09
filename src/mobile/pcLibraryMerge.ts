import type { LibraryBook } from "../features/library/libraryApi";
import type { PcEntry } from "./MobilePcLibrary";

/** A book the phone lists: its own, or the paired PC's (with its copy here, if any). */
export type MergedBook =
  { kind: "phone"; book: LibraryBook } | { kind: "pc"; book: LibraryBook; entry: PcEntry };

export const phoneItem = (book: LibraryBook): MergedBook => ({ kind: "phone", book });

/** A PC book with the later of its two places: the PC's, or its copy's on this phone. */
function pcItem(entry: PcEntry, copy: LibraryBook | undefined): MergedBook {
  const later = copy && (copy.lastReadAt ?? "") > (entry.book.lastReadAt ?? "");
  const book = later
    ? { ...entry.book, progress: copy.progress, lastReadAt: copy.lastReadAt }
    : entry.book;
  return { kind: "pc", book, entry: { ...entry, book } };
}

/**
 * The phone's books with the PC's: a PC book's copy here is listed once, as the PC's book; a copy
 * of a book the PC no longer lists stays the phone's while its file is here. Until the PC's
 * listing is known (`entries` null), its copies wait.
 */
export function mergePcLibrary(
  books: readonly LibraryBook[],
  entries: readonly PcEntry[] | null,
): MergedBook[] {
  const copies = new Map(books.filter((book) => book.fromPc).map((book) => [book.id, book]));
  const fromPc = (entries ?? []).map((entry) => {
    const copy = entry.pc.localId === null ? undefined : copies.get(entry.pc.localId);
    if (copy) copies.delete(copy.id);
    return pcItem(entry, copy);
  });
  const own = books.filter(
    (book) =>
      !book.fromPc ||
      (entries !== null && copies.has(book.id) && book.availability === "available"),
  );
  return [...own.map(phoneItem), ...fromPc];
}

import type { LibraryBook } from "../library/libraryApi";

type ReaderBook = Pick<
  LibraryBook,
  "id" | "title" | "author" | "availability" | "hasCover" | "language" | "series" | "seriesIndex"
>;

export type ReaderIdentity =
  | { status: "empty" }
  | { status: "loading" }
  | {
      status: "book";
      book: ReaderBook;
      cover: string | null;
      /** Opened from a folder, outside the Library: the Reader keeps nothing about it. */
      opened?: boolean;
    }
  | { status: "unknown" }
  | { status: "error" };

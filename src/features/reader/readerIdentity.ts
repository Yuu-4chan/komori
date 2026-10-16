import type { LibraryBook } from "../library/libraryApi";

type ReaderBook = Pick<
  LibraryBook,
  "id" | "title" | "author" | "availability" | "hasCover" | "series" | "seriesIndex"
>;

export type ReaderIdentity =
  | { status: "empty" }
  | { status: "loading" }
  | { status: "book"; book: ReaderBook; cover: string | null }
  | { status: "unknown" }
  | { status: "error" };

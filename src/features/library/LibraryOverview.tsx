import { compactCount } from "./LibraryCollection";
import { useI18n } from "../../i18n/i18n";
import { useRef, type ReactNode } from "react";

import { CardTabStop, useCardRoving } from "./cardRoving";
import type { LibraryBook } from "./libraryApi";
import { libraryCharacters, libraryWords } from "./libraryView";

/**
 * The Library's one-line summary under its title: its books (or how many match while searching
 * or filtering), then how many characters the whole Library holds, across every Chinese,
 * Japanese, and Korean book Komori counted, and the words of every other book.
 */
export function LibrarySummary({ books, shown }: { books: readonly LibraryBook[]; shown: number }) {
  const characters = libraryCharacters(books);
  const words = libraryWords(books);
  const { t, tp } = useI18n();
  return (
    <p className="library-summary">
      <span>
        {shown === books.length
          ? tp("librarySummary.books", books.length)
          : tp("librarySummary.shownOf", books.length, { shown })}
      </span>
      {characters > 0 ? (
        <span title={t("librarySummary.charactersTitle", { count: characters })}>
          {t("librarySummary.characters", { count: compactCount(characters) })}
        </span>
      ) : null}
      {words > 0 ? (
        <span title={t("librarySummary.wordsTitle", { count: words })}>
          {t("librarySummary.words", { count: compactCount(words) })}
        </span>
      ) : null}
    </p>
  );
}

/**
 * Every book in progress, most recently read first, as the same cards as the Library around it,
 * under a group heading at the top of the Library's books. More books add rows rather than a
 * separate page.
 */
export function ContinueReading({
  books,
  renderBook,
}: {
  books: readonly LibraryBook[];
  renderBook: (book: LibraryBook) => ReactNode;
}) {
  const { t, tp } = useI18n();
  const gridRef = useRef<HTMLDivElement>(null);
  const cards = useCardRoving(gridRef, books, "measure");
  if (books.length === 0) return null;
  return (
    <section className="reading-shelf" aria-labelledby="reading-shelf-title">
      <h3 className="library-group-heading">
        <span id="reading-shelf-title">{t("libraryCard.continue")}</span>
        <small>{tp("librarySummary.inProgress", books.length)}</small>
      </h3>
      <CardTabStop stop={cards.stop}>
        <div className="library-books library-books--grid" ref={gridRef} {...cards.props}>
          {books.map(renderBook)}
        </div>
      </CardTabStop>
    </section>
  );
}

/** Heads the ungrouped Library's books when Continue reading is above them. */
export function AllBooksHeading() {
  const { t } = useI18n();
  return (
    <h3 className="library-group-heading library-all-heading">
      <span>{t("libraryToolbar.filter.all")}</span>
    </h3>
  );
}

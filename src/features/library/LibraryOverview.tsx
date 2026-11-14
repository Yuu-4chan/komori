import { compactCount } from "./LibraryCollection";
import { useI18n } from "../../i18n/i18n";
import type { LibraryBook } from "./libraryApi";
import { libraryCharacters, libraryWords } from "./libraryView";
import { spelledAmount } from "../../i18n/amounts";

/**
 * The Library's one-line summary under its title: its books (or how many match while searching
 * or filtering), then how many characters the books shown hold, across every Chinese,
 * Japanese, and Korean book Komori counted, and the words of every other book.
 */
export function LibrarySummary({
  books,
  shown,
}: {
  books: readonly LibraryBook[];
  shown: readonly LibraryBook[];
}) {
  const characters = libraryCharacters(shown);
  const words = libraryWords(shown);
  const { t, tp } = useI18n();
  return (
    <p className="library-summary">
      <span>
        {shown.length === books.length
          ? tp("librarySummary.books", books.length)
          : tp("librarySummary.shownOf", books.length, { shown: shown.length })}
      </span>
      {characters > 0 ? (
        <span title={t("librarySummary.charactersTitle", { count: characters })}>
          {spelledAmount("characters", compactCount(characters))}
        </span>
      ) : null}
      {words > 0 ? (
        <span title={t("librarySummary.wordsTitle", { count: words })}>
          {spelledAmount("words", compactCount(words))}
        </span>
      ) : null}
    </p>
  );
}

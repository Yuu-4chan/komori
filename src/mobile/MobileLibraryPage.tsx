import {
  BookOpenIcon,
  BooksIcon,
  CaretRightIcon,
  CheckCircleIcon,
  LinkSimpleIcon,
  PencilSimpleIcon,
  PlusIcon,
  StackIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Link } from "react-router-dom";

import { Button } from "../components/ui/Button";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { EmptyState } from "../components/ui/EmptyState";
import { NoticeClose } from "../components/ui/NoticeClose";
import { BookCover } from "../features/library/BookCover";
import { BookEditDialog } from "../features/library/BookEditDialog";
import {
  editBooks,
  listLibrary,
  markBooksCompleted,
  relinkBook,
  removeBook,
  resetBookSeries,
  setBookSeries,
  type BookEdit,
  type LibraryBook,
} from "../features/library/libraryApi";
import { libraryCache } from "../features/library/libraryCache";
import { useLibraryImport } from "../features/library/libraryImport";
import {
  ImportNotice,
  RelinkNotice,
  relinkNoticeFor,
  type RelinkNoticeState,
} from "../features/library/LibraryNotices";
import { LibrarySummary } from "../features/library/LibraryOverview";
import { LibrarySearch } from "../features/library/LibraryToolbar";
import { SeriesDialog, type SeriesChoice } from "../features/library/SeriesDialog";
import {
  bookTitle,
  canMarkCompleted,
  hasReadingProgress,
  languageName,
  lastReadLabel,
  matchesQuery,
  progressLabel,
  progressPercent,
  readTotalLabel,
  readingStatus,
  seriesFromTitles,
  sortBooks,
} from "../features/library/libraryView";
import { failureText } from "../i18n/failure";
import { i18n, useI18n } from "../i18n/i18n";
import { MobilePageHeader } from "./MobileShell";

import { MobileSheet } from "./MobileSheet";

type Listing =
  | { status: "loading"; books: LibraryBook[] }
  | { status: "ready"; books: LibraryBook[] }
  | { status: "error"; books: LibraryBook[]; message: string };

/**
 * The Library on the phone: its count of books, search, Add books, the book read last to
 * continue, and every book as a cover with its progress. Tapping a book opens it; a long press
 * shows what can be done with it. A book whose file is gone offers Relink and Remove instead.
 */
export function MobileLibraryPage() {
  const { t, tp } = useI18n();
  const imports = useLibraryImport();
  const cached = libraryCache.books();
  const [listing, setListing] = useState<Listing>(
    cached ? { status: "ready", books: cached } : { status: "loading", books: [] },
  );
  const [query, setQuery] = useState("");
  const [missing, setMissing] = useState<LibraryBook | null>(null);
  const [removing, setRemoving] = useState<LibraryBook | null>(null);
  const [busy, setBusy] = useState(false);
  const [relinkNotice, setRelinkNotice] = useState<RelinkNoticeState | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // The book a long press chose, and what was opened from its sheet.
  const [chosen, setChosen] = useState<LibraryBook | null>(null);
  const [editing, setEditing] = useState<LibraryBook | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [inSeries, setInSeries] = useState<LibraryBook | null>(null);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const requests = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requests.current;
    try {
      const books = await listLibrary();
      if (request !== requests.current) return false;
      libraryCache.setBooks(books);
      setListing({ status: "ready", books });
      return true;
    } catch (error) {
      if (request === requests.current)
        setListing((current) => ({
          status: "error",
          books: current.books,
          message: errorMessage(error),
        }));
      return false;
    }
  }, []);

  // Import results show while the Library is open and are cleared once it is left.
  const { view: viewImports } = imports;
  useEffect(() => viewImports(), [viewImports]);
  // Lists again on every visit and after each import that added to the catalog.
  useEffect(() => {
    void refresh();
  }, [refresh, imports.version]);

  const books = listing.books;
  const shown = useMemo(
    () => sortBooks(books, "title", false).filter((book) => matchesQuery(book, query)),
    [books, query],
  );
  const inProgress = books.filter(
    (book) => book.availability === "available" && hasReadingProgress(book),
  );
  const continueBook = sortBooks(inProgress, "recent", false)[0];
  const seriesNames = useMemo(
    () =>
      [...new Set(books.flatMap((book) => (book.series ? [book.series] : [])))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [books],
  );

  // A long press on a book whose file is gone offers what a tap does.
  const choose = useCallback((book: LibraryBook) => {
    if (book.availability === "available") setChosen(book);
    else setMissing(book);
  }, []);

  async function saveEdits(edits: BookEdit[]) {
    setBusy(true);
    setEditError(null);
    try {
      await editBooks(edits);
      await refresh();
      setEditing(null);
    } catch (error) {
      setEditError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveSeries(book: LibraryBook, choice: SeriesChoice) {
    setBusy(true);
    setSeriesError(null);
    try {
      if (choice.kind === "metadata") await resetBookSeries([book.id]);
      else await setBookSeries([book.id], choice.kind === "name" ? choice.name : null);
      await refresh();
      setInSeries(null);
    } catch (error) {
      setSeriesError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  // Marking completed asks nothing, as on the PC: reading on undoes it.
  async function markCompleted(book: LibraryBook) {
    setBusy(true);
    setCompleteError(null);
    try {
      await markBooksCompleted([book.id]);
      await refresh();
      setChosen(null);
    } catch (error) {
      setChosen(null);
      setCompleteError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function relink(book: LibraryBook) {
    setMissing(null);
    setBusy(true);
    setRelinkNotice(null);
    try {
      const result = await relinkBook(book.id);
      if (result.status === "relinked") {
        setRelinkNotice(
          (await refresh())
            ? {
                kind: "success",
                title: t("library.relinked"),
                message: t("library.relinkedMessage", { title: book.title ?? book.fileName }),
              }
            : {
                kind: "error",
                title: t("library.relinkedNoRefresh"),
                message: t("library.relinkedNoRefreshMessage"),
              },
        );
      } else setRelinkNotice(relinkNoticeFor(result));
    } catch {
      setRelinkNotice({
        kind: "error",
        title: t("library.relinkFailed"),
        message: t("library.relinkFailedNative"),
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove(book: LibraryBook) {
    setBusy(true);
    setRemoveError(null);
    try {
      if (!(await removeBook(book.id))) throw new Error(t("library.notInLibrary"));
      setListing((current) => ({
        ...current,
        books: current.books.filter((each) => each.id !== book.id),
      }));
      setRemoving(null);
    } catch (error) {
      setRemoveError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const addBooks = (
    <button
      aria-label={imports.busy ? imports.label : t("shell.addBooks")}
      className="mobile-round-button mobile-round-button--accent"
      disabled={imports.busy}
      onClick={() => void imports.run()}
      type="button"
    >
      <PlusIcon aria-hidden="true" weight="bold" />
    </button>
  );

  return (
    <div className="mobile-page mobile-library">
      <MobilePageHeader
        actions={addBooks}
        summary={
          listing.status === "loading" ? null : <LibrarySummary books={books} shown={books} />
        }
        title={t("shell.library")}
      />

      <div className="mobile-notices">
        {imports.error ? (
          <div className="library-notice" role="alert">
            <span>{t("library.importFailed", { error: failureText(imports.error, t) })}</span>
            <NoticeClose onClose={imports.dismiss} />
          </div>
        ) : null}
        {imports.result ? <ImportNotice result={imports.result} onClose={imports.dismiss} /> : null}
        {relinkNotice ? (
          <RelinkNotice notice={relinkNotice} onClose={() => setRelinkNotice(null)} />
        ) : null}
        {completeError ? (
          <div className="library-notice" role="alert">
            <span>{completeError}</span>
            <NoticeClose onClose={() => setCompleteError(null)} />
          </div>
        ) : null}
      </div>

      {listing.status === "error" && books.length === 0 ? (
        <EmptyState
          description={listing.message}
          icon={WarningCircleIcon}
          title={t("library.unavailable")}
        />
      ) : listing.status === "ready" && books.length === 0 ? (
        <EmptyState
          action={
            <Button
              disabled={imports.busy}
              icon={<PlusIcon aria-hidden="true" weight="bold" />}
              onClick={() => void imports.run()}
            >
              {imports.busy ? imports.label : t("shell.addBooks")}
            </Button>
          }
          description={t("library.emptyDescription")}
          icon={BooksIcon}
          title={t("library.empty")}
        />
      ) : books.length > 0 ? (
        <>
          <div className="mobile-search">
            <LibrarySearch onQueryChange={setQuery} query={query} />
          </div>

          {continueBook && !query ? (
            <section className="mobile-library__section" aria-labelledby="mobile-continue">
              <h2 className="mobile-section-heading">
                <span id="mobile-continue">{t("libraryCard.continue")}</span>
                <small>{tp("librarySummary.inProgress", inProgress.length)}</small>
              </h2>
              <ContinueCard book={continueBook} onChoose={choose} />
            </section>
          ) : null}

          <section className="mobile-library__section" aria-labelledby="mobile-all-books">
            <h2 className="mobile-section-heading" id="mobile-all-books">
              {t("libraryToolbar.filter.all")}
            </h2>
            {shown.length === 0 ? (
              <p className="mobile-library__none">{t("library.noneFound")}</p>
            ) : (
              <ul className="mobile-library__grid">
                {shown.map((book) => (
                  <li key={book.id}>
                    <BookTile book={book} onChoose={choose} onMissing={setMissing} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}

      <MobileSheet
        label={t("libraryCard.missing")}
        onClose={() => setMissing(null)}
        open={missing !== null}
      >
        {missing ? (
          <div className="mobile-missing">
            <div className="mobile-missing__book">
              <BookCover book={missing} size="small" />
              <div>
                <strong>{missing.title ?? missing.fileName}</strong>
                <span>
                  {t(
                    missing.availability === "missing"
                      ? "libraryCard.missing"
                      : "libraryCard.unreadable",
                  )}
                </span>
              </div>
            </div>
            <button
              className="mobile-sheet-row"
              disabled={busy}
              onClick={() => void relink(missing)}
              type="button"
            >
              <LinkSimpleIcon aria-hidden="true" weight="bold" />
              {t("libraryCard.relinkMenu")}
            </button>
            <button
              className="mobile-sheet-row mobile-sheet-row--danger"
              disabled={busy}
              onClick={() => {
                setRemoveError(null);
                setRemoving(missing);
                setMissing(null);
              }}
              type="button"
            >
              <TrashIcon aria-hidden="true" weight="bold" />
              {t("library.removeConfirm")}
            </button>
          </div>
        ) : null}
      </MobileSheet>

      <BookSheet
        book={chosen}
        busy={busy}
        onClose={() => setChosen(null)}
        onEdit={(book) => {
          setEditError(null);
          setEditing(book);
          setChosen(null);
        }}
        onMarkCompleted={(book) => void markCompleted(book)}
        onRemove={(book) => {
          setRemoveError(null);
          setRemoving(book);
          setChosen(null);
        }}
        onSeries={(book) => {
          setSeriesError(null);
          setInSeries(book);
          setChosen(null);
        }}
      />

      <BookEditDialog
        books={editing ? [editing] : null}
        busy={busy}
        error={editError}
        onCancel={() => setEditing(null)}
        onConfirm={(edits) => void saveEdits(edits)}
      />
      <SeriesDialog
        busy={busy}
        count={1}
        error={seriesError}
        initialName={inSeries ? (inSeries.series ?? seriesFromTitles([bookTitle(inSeries)])) : ""}
        onCancel={() => setInSeries(null)}
        onConfirm={(choice) => {
          if (inSeries) void saveSeries(inSeries, choice);
        }}
        open={inSeries !== null}
        suggestions={seriesNames}
      />

      <ConfirmDialog
        busy={busy}
        busyLabel={t("library.removing")}
        confirmLabel={t("library.removeConfirm")}
        description={t("library.removeDescription")}
        error={removeError}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) void remove(removing);
        }}
        open={removing !== null}
        title={t("library.removeDialogTitle")}
      />
    </div>
  );
}

function errorMessage(error: unknown): string {
  return failureText(error instanceof Error ? error.message : String(error), i18n().t);
}

// How long after a long press its own click is ignored, so the book does not open too.
const longPressClick = 800;

/** A long press (Android's contextmenu) on a book, which then does not open it. */
function useLongPress(onLongPress: () => void) {
  const pressed = useRef(0);
  return {
    onContextMenu: (event: ReactMouseEvent) => {
      event.preventDefault();
      pressed.current = Date.now();
      onLongPress();
    },
    onClickCapture: (event: ReactMouseEvent) => {
      if (Date.now() - pressed.current >= longPressClick) return;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

const openLabel = {
  "not-started": "libraryCard.start",
  reading: "libraryCard.continue",
  completed: "libraryCard.again",
} as const;

/**
 * What a long press on a book offers: reading it, its title and author, its series, marking it
 * completed and removing it, under its cover and progress.
 */
function BookSheet({
  book,
  busy,
  onClose,
  onEdit,
  onSeries,
  onMarkCompleted,
  onRemove,
}: {
  book: LibraryBook | null;
  busy: boolean;
  onClose: () => void;
  onEdit: (book: LibraryBook) => void;
  onSeries: (book: LibraryBook) => void;
  onMarkCompleted: (book: LibraryBook) => void;
  onRemove: (book: LibraryBook) => void;
}) {
  const { t } = useI18n();
  const title = book?.title ?? t("library.untitled");
  const total = book ? readTotalLabel(book) : null;
  return (
    <MobileSheet
      className="mobile-sheet--floating"
      label={title}
      onClose={onClose}
      open={book !== null}
    >
      {book ? (
        <div className="mobile-book-sheet">
          <div className="mobile-book-sheet__book">
            <BookCover book={book} size="small" />
            <div>
              <strong>{title}</strong>
              <span>{book.author ?? t("libraryCard.unknownAuthor")}</span>
              <span>{total ? `${progressLabel(book)} · ${total}` : progressLabel(book)}</span>
            </div>
          </div>
          <div className="mobile-book-sheet__actions">
            <Link className="mobile-book-sheet__action" onClick={onClose} to={`/reader/${book.id}`}>
              <BookOpenIcon aria-hidden="true" />
              {t(openLabel[readingStatus(book)])}
            </Link>
            <button
              className="mobile-book-sheet__action"
              disabled={busy}
              onClick={() => onEdit(book)}
              type="button"
            >
              <PencilSimpleIcon aria-hidden="true" />
              {t("libraryCard.editMenu")}
            </button>
            <button
              className="mobile-book-sheet__action"
              disabled={busy}
              onClick={() => onSeries(book)}
              type="button"
            >
              <StackIcon aria-hidden="true" />
              <span className="mobile-book-sheet__label">{t("series.title")}</span>
              <span className="mobile-book-sheet__value">
                {book.series ?? t("libraryCard.noSeries")}
              </span>
              <CaretRightIcon aria-hidden="true" className="mobile-book-sheet__caret" />
            </button>
            {canMarkCompleted(book) ? (
              <button
                className="mobile-book-sheet__action"
                disabled={busy}
                onClick={() => onMarkCompleted(book)}
                type="button"
              >
                <CheckCircleIcon aria-hidden="true" />
                {t("library.markCompleted")}
              </button>
            ) : null}
            <button
              className="mobile-book-sheet__action mobile-book-sheet__action--danger"
              disabled={busy}
              onClick={() => onRemove(book)}
              type="button"
            >
              <TrashIcon aria-hidden="true" />
              {t("library.removeConfirm")}
            </button>
          </div>
        </div>
      ) : null}
    </MobileSheet>
  );
}

/** The book read last, large, with how far it is read and when. */
function ContinueCard({
  book,
  onChoose,
}: {
  book: LibraryBook;
  onChoose: (book: LibraryBook) => void;
}) {
  const { t } = useI18n();
  const percent = progressPercent(book);
  const lastRead = lastReadLabel(book);
  const longPress = useLongPress(() => onChoose(book));
  return (
    <Link className="mobile-continue" to={`/reader/${book.id}`} {...longPress}>
      <BookCover book={book} size="small" />
      <div className="mobile-continue__copy">
        <div>
          <strong>{book.title ?? t("library.untitled")}</strong>
          <span>{book.author ?? t("libraryCard.unknownAuthor")}</span>
        </div>
        <div className="mobile-chips">
          {book.language ? <span>{languageName(book.language)}</span> : null}
          {lastRead ? <span>{lastRead}</span> : null}
        </div>
        <div className="mobile-progress">
          <span
            aria-label={t("libraryCard.percentRead", { percent })}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percent}
            className="mobile-progress__bar"
            role="progressbar"
          >
            <span style={{ width: `${percent}%` }} />
          </span>
          <span className="mobile-progress__percent">{progressLabel(book)}</span>
        </div>
        <span className="mobile-continue__count">{readTotalLabel(book)}</span>
      </div>
    </Link>
  );
}

/** A book in the grid: its cover, title, author and progress. */
function BookTile({
  book,
  onChoose,
  onMissing,
}: {
  book: LibraryBook;
  onChoose: (book: LibraryBook) => void;
  onMissing: (book: LibraryBook) => void;
}) {
  const { t } = useI18n();
  const longPress = useLongPress(() => onChoose(book));
  const percent = progressPercent(book);
  const available = book.availability === "available";
  const content = (
    <>
      <BookCover book={book}>
        {available ? null : (
          <span className="mobile-tile__missing">
            <WarningCircleIcon aria-hidden="true" weight="fill" />
          </span>
        )}
      </BookCover>
      <strong className="mobile-tile__title">{book.title ?? t("library.untitled")}</strong>
      <span className="mobile-tile__author">
        {available
          ? (book.author ?? t("libraryCard.unknownAuthor"))
          : t(book.availability === "missing" ? "libraryCard.missing" : "libraryCard.unreadable")}
      </span>
      <span className="mobile-progress">
        <span
          aria-label={t("libraryCard.percentRead", { percent })}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent}
          className="mobile-progress__bar"
          role="progressbar"
        >
          <span style={{ width: `${percent}%` }} />
        </span>
        <span className="mobile-progress__percent">{progressLabel(book)}</span>
      </span>
    </>
  );
  return available ? (
    <Link className="mobile-tile" to={`/reader/${book.id}`} {...longPress}>
      {content}
    </Link>
  ) : (
    <button
      className="mobile-tile mobile-tile--missing"
      onClick={() => onMissing(book)}
      type="button"
      {...longPress}
    >
      {content}
    </button>
  );
}

import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  BooksIcon,
  CheckCircleIcon,
  LinkSimpleIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  UploadSimpleIcon,
  StackIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { commandTarget, shortcutCommand } from "../features/reader/shortcuts";
import { failureText } from "../i18n/failure";
import { i18n, useI18n } from "../i18n/i18n";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { useShellSearchSlot } from "../components/layout/shellSlots";
import { EmptyState } from "../components/ui/EmptyState";
import { NoticeClose } from "../components/ui/NoticeClose";
import { useAppearance } from "../features/appearance/AppearanceProvider";
import {
  LibraryBookCard,
  type CardDetails,
  type SelectGesture,
} from "../features/library/LibraryBookCard";
import { LibraryCollection } from "../features/library/LibraryCollection";
import {
  AllBooksHeading,
  ContinueReading,
  LibrarySummary,
} from "../features/library/LibraryOverview";
import { useLibraryImport } from "../features/library/libraryImport";
import { useLibraryDrop } from "../features/library/useLibraryDrop";
import { useBulkOperation, operationLabel } from "../features/operations/bulkOperation";
import { OperationNotice } from "../features/operations/OperationNotice";
import { LibrarySearch, LibraryToolbar } from "../features/library/LibraryToolbar";
import { isLibraryReturn, libraryCache, type ScrollPlace } from "../features/library/libraryCache";
import { SeriesDialog, type SeriesChoice } from "../features/library/SeriesDialog";
import {
  groupBooks,
  matchesQuery,
  hasReadingProgress,
  readingStatus,
  sectionGroup,
  sortBooks,
  type LibrarySection,
  type LibraryView,
} from "../features/library/libraryView";
import {
  listLibrary,
  onLibraryDetailsUpdated,
  relinkBook,
  markBookUnread,
  removeBook,
  removeBooks,
  resetBookSeries,
  setBookSeries,
  type ImportBatch,
  type LibraryBook,
  type RelinkResult,
} from "../features/library/libraryApi";
import { useSelection } from "../features/selection/useSelection";
import { selectAllKey, selectionKeyTarget } from "../features/selection/selectionKeyboard";

type LibraryState =
  | { status: "loading"; books: LibraryBook[] }
  | { status: "ready"; books: LibraryBook[] }
  | { status: "error"; books: LibraryBook[]; message: string };

interface BulkFailure {
  id: string;
  title: string;
  message: string;
}

interface RelinkNoticeState {
  kind: "success" | "canceled" | "invalid" | "duplicate" | "error";
  title: string;
  message: string;
}

/** `/library?group=<section key>` is one group's own page, opened from its See all. */
const groupPageLink = (section: Pick<LibrarySection, "key">) =>
  `/library?group=${encodeURIComponent(section.key)}`;

export function LibraryPage() {
  const [params] = useSearchParams();
  const group = params.get("group");
  // Each group's page starts afresh; the whole Library returns where it was left.
  return <LibraryContent group={group} key={group ?? ""} />;
}

function LibraryContent({ group }: { group: string | null }) {
  const { t, tp, language } = useI18n();
  const navigate = useNavigate();
  // A Library listed earlier this session shows at once, where it was left, while it refreshes.
  const [library, setLibrary] = useState<LibraryState>(() => {
    const cached = libraryCache.books();
    return cached ? { status: "ready", books: cached } : { status: "loading", books: [] };
  });
  const groupKind = group === null ? null : sectionGroup(group);
  const onGroupPage = group !== null;
  const page = group ?? "";
  const location = useLocation();
  // The whole Library returns where it was left; a group's page does when the Reader returns
  // to it, and otherwise (from See all) starts at its top.
  const [restore] = useState<ScrollPlace | undefined>(() =>
    onGroupPage && !isLibraryReturn(location.state)
      ? { scrollTop: 0 }
      : libraryCache.books()
        ? (libraryCache.place(page) ?? { scrollTop: 0 })
        : undefined,
  );
  const savePlace = useCallback((place: ScrollPlace) => libraryCache.setPlace(page, place), [page]);
  useEffect(() => {
    libraryCache.setLastPage(onGroupPage ? groupPageLink({ key: page }) : "/library");
  }, [onGroupPage, page]);
  const imports = useLibraryImport();
  const operation = useBulkOperation("library");
  const loadSequence = useRef(0);
  useEffect(
    () => () => {
      loadSequence.current += 1;
    },
    [],
  );
  const [relinkingId, setRelinkingId] = useState<string | null>(null);
  const [relinkNotice, setRelinkNotice] = useState<RelinkNoticeState | null>(null);
  const [removeTarget, setRemoveTarget] = useState<LibraryBook | null>(null);
  const [unreadTarget, setUnreadTarget] = useState<LibraryBook | null>(null);
  const [markingUnread, setMarkingUnread] = useState(false);
  const [unreadError, setUnreadError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [bulkRemoveOpen, setBulkRemoveOpen] = useState(false);
  const [bulkRemoving, setBulkRemoving] = useState(false);
  const [bulkDialogError, setBulkDialogError] = useState<string | null>(null);
  const [bulkFailures, setBulkFailures] = useState<BulkFailure[]>([]);
  const availableBookIds = useMemo(() => library.books.map((book) => book.id), [library.books]);
  const selection = useSelection(availableBookIds);
  const { library: display, updateLibrary } = useAppearance();
  const [query, setQuery] = useState("");
  const searchSlot = useShellSearchSlot();
  const details: CardDetails = useMemo(
    () => ({
      series: display.cardSeries,
      language: display.cardLanguage,
      kanji: display.cardKanji,
      lastRead: display.cardLastRead,
    }),
    [display.cardSeries, display.cardLanguage, display.cardKanji, display.cardLastRead],
  );
  const [seriesOpen, setSeriesOpen] = useState(false);
  const [seriesBusy, setSeriesBusy] = useState(false);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const dropBusy =
    imports.busy ||
    Boolean(relinkingId) ||
    removing ||
    bulkRemoving ||
    markingUnread ||
    seriesBusy ||
    Boolean(removeTarget || unreadTarget || bulkRemoveOpen || seriesOpen);
  const dragging = useLibraryDrop(dropBusy, imports.drop, imports.failDrop);

  useEffect(() => {
    if (library.status === "ready") libraryCache.setBooks(library.books);
  }, [library]);

  const readingBooks = useMemo(
    () => sortBooks(library.books.filter(hasReadingProgress), "recent", false),
    [library.books],
  );
  const shownBooks = useMemo(
    () =>
      sortBooks(
        library.books.filter(
          (book) =>
            matchesQuery(book, query) &&
            (display.filter === "all" || readingStatus(book) === display.filter),
        ),
        display.sort,
        display.sortReversed,
      ),
    [library.books, query, display.filter, display.sort, display.sortReversed],
  );
  // A group's page shows only that group's books, in the order its carousel shows them.
  const groupSection = useMemo(
    () =>
      groupKind && group !== null
        ? (groupBooks(shownBooks, groupKind).find((section) => section.key === group) ?? null)
        : null,
    // Group names follow the interface language.
    [group, groupKind, shownBooks, language],
  );
  // The whole group, whatever the search or filters, for its title and summary.
  const wholeGroup = useMemo(
    () =>
      groupKind && group !== null
        ? (groupBooks(library.books, groupKind).find((section) => section.key === group) ?? null)
        : null,
    [group, groupKind, library.books, language],
  );
  const sections = useMemo<LibrarySection[]>(
    () =>
      onGroupPage
        ? groupSection
          ? [{ key: groupSection.key, title: null, books: groupSection.books }]
          : []
        : groupBooks(shownBooks, display.group),
    [display.group, groupSection, onGroupPage, shownBooks, language],
  );
  const sectionBooks = useMemo(() => sections.flatMap((section) => section.books), [sections]);
  // The books in the order they are shown, which Shift+click ranges and series numbers follow.
  const orderedIds = useMemo(() => sectionBooks.map((book) => book.id), [sectionBooks]);
  const orderedIdsRef = useRef(orderedIds);
  orderedIdsRef.current = orderedIds;
  const anchorRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const books = await listLibrary();
      if (sequence !== loadSequence.current) return false;
      setLibrary({ status: "ready", books });
      return true;
    } catch (error) {
      if (sequence !== loadSequence.current) return false;
      setLibrary((current) => ({
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

  // Each visit (and a reload) also looks for new books in the book folders; any it imports
  // count as an import, so the Library lists again.
  const { scanFolders } = imports;
  useEffect(() => {
    void scanFolders();
  }, [scanFolders]);

  // Languages, series, and counts of older books arrive in the background after startup.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onLibraryDetailsUpdated(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 300);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [refresh]);

  const { active: selecting, add: addToSelection, toggle: toggleSelected } = selection;
  const enterSelection = selection.enter;
  // A plain or Ctrl/Cmd+click flips one book and becomes the anchor; Shift+click adds every
  // book shown between the anchor and this one. Either starts selecting.
  const selectBook = useCallback(
    (id: string, gesture: SelectGesture) => {
      if (operation?.active) return;
      if (!selecting) {
        setBulkFailures([]);
        enterSelection();
      }
      const ids = orderedIdsRef.current;
      const from = anchorRef.current ? ids.indexOf(anchorRef.current) : -1;
      const to = ids.indexOf(id);
      if (gesture === "range" && from >= 0 && to >= 0) {
        addToSelection(ids.slice(Math.min(from, to), Math.max(from, to) + 1));
        return;
      }
      toggleSelected(id);
      anchorRef.current = id;
    },
    [addToSelection, enterSelection, selecting, toggleSelected, operation?.active],
  );

  const dialogOpen = bulkRemoveOpen || removeTarget !== null || unreadTarget !== null || seriesOpen;
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (
        dialogOpen ||
        document.querySelector("dialog[open]") ||
        (event.target as Element | null)?.closest?.(
          '[role="menu"], [role="listbox"], [role="dialog"]',
        )
      )
        return;
      const command = shortcutCommand(event, "Library");
      if (!command) return;
      event.preventDefault();
      if (command === "library-search") {
        requestAnimationFrame(() =>
          document.querySelector<HTMLInputElement>(".book-search input")?.focus(),
        );
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [dialogOpen]);
  // A group's page goes back to the whole Library with Escape or Alt+Left, as its back link does,
  // also from a book's selection box but not from a text field.
  useEffect(() => {
    const choice = 'input[type="checkbox"], input[type="radio"]';
    if (!onGroupPage || selection.active || dialogOpen) return;
    function handleKey(event: KeyboardEvent) {
      const back =
        (event.key === "Escape" && !event.altKey) || (event.key === "ArrowLeft" && event.altKey);
      if (
        !back ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        document.querySelector("dialog[open]") ||
        !(commandTarget(event.target, true) || (event.target as Element).matches?.(choice))
      )
        return;
      event.preventDefault();
      navigate("/library");
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [dialogOpen, navigate, onGroupPage, selection.active]);
  useEffect(() => {
    if (!selection.active || dialogOpen || operation?.active) return;
    function handleKey(event: KeyboardEvent) {
      if (!selectionKeyTarget(event, ".page--library, .library-selection-bar")) return;
      if (event.key === "Escape" && !event.ctrlKey && !event.metaKey) {
        selection.cancel();
        setBulkFailures([]);
        anchorRef.current = null;
      } else if (selectAllKey(event)) {
        event.preventDefault();
        selection.replace(orderedIdsRef.current);
      } else if (
        event.key === "Delete" &&
        !event.ctrlKey &&
        !event.metaKey &&
        selection.selectedCount > 0
      ) {
        event.preventDefault();
        setBulkDialogError(null);
        setBulkRemoveOpen(true);
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [dialogOpen, selection, operation?.active]);

  // A ref guards against a second picker even before the relinking state re-renders.
  const relinkingRef = useRef(false);
  const handleRelink = useCallback(
    async (book: LibraryBook) => {
      if (relinkingRef.current) return;
      relinkingRef.current = true;
      setRelinkingId(book.id);
      setRelinkNotice(null);
      try {
        const result = await relinkBook(book.id);
        if (result.status === "relinked") {
          // The refreshed record names the new cover revision, so its card shows the new cover.
          const refreshed = await refresh();
          setRelinkNotice(
            refreshed
              ? {
                  kind: "success",
                  title: i18n().t("library.relinked"),
                  message: i18n().t("library.relinkedMessage", {
                    title: book.title ?? book.fileName,
                  }),
                }
              : {
                  kind: "error",
                  title: i18n().t("library.relinkedNoRefresh"),
                  message: i18n().t("library.relinkedNoRefreshMessage"),
                },
          );
        } else {
          setRelinkNotice(relinkNoticeFor(result));
        }
      } catch {
        setRelinkNotice({
          kind: "error",
          title: i18n().t("library.relinkFailed"),
          message: i18n().t("library.relinkFailedNative"),
        });
      } finally {
        relinkingRef.current = false;
        setRelinkingId(null);
      }
    },
    [refresh],
  );
  const relink = useCallback((book: LibraryBook) => void handleRelink(book), [handleRelink]);

  const requestRemoval = useCallback((book: LibraryBook) => {
    setRemoveError(null);
    setRemoveTarget(book);
  }, []);

  async function confirmRemoval() {
    if (!removeTarget || removing || operation?.active) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      const removed = await removeBook(removeTarget.id);
      if (!removed) throw new Error(i18n().t("library.notInLibrary"));
      setLibrary((current) => ({
        ...current,
        books: current.books.filter((book) => book.id !== removeTarget.id),
      }));
      setRemoveTarget(null);
    } catch (error) {
      setRemoveError(errorMessage(error));
    } finally {
      setRemoving(false);
    }
  }

  const requestUnread = useCallback((book: LibraryBook) => {
    setUnreadError(null);
    setUnreadTarget(book);
  }, []);

  async function confirmUnread() {
    if (!unreadTarget) return;
    setMarkingUnread(true);
    setUnreadError(null);
    try {
      const marked = await markBookUnread(unreadTarget.id);
      if (!marked) throw new Error(i18n().t("library.notInLibrary"));
      await refresh();
      setUnreadTarget(null);
    } catch (error) {
      setUnreadError(errorMessage(error));
    } finally {
      setMarkingUnread(false);
    }
  }

  function cancelSelection() {
    selection.cancel();
    setBulkFailures([]);
    anchorRef.current = null;
  }

  const seriesNames = useMemo(
    () =>
      [...new Set(library.books.flatMap((book) => (book.series ? [book.series] : [])))].sort(
        (a, b) => a.localeCompare(b),
      ),
    [library.books],
  );
  const sharedSeries = useMemo(() => {
    const chosen = library.books.filter((book) => selection.selectedIds.has(book.id));
    const first = chosen[0]?.series ?? "";
    return chosen.every((book) => (book.series ?? "") === first) ? first : "";
  }, [library.books, selection.selectedIds]);

  async function saveSeries(choice: SeriesChoice) {
    // Numbered in the order shown; any selected book no longer shown follows.
    const shown = orderedIds.filter((id) => selection.selectedIds.has(id));
    const shownSet = new Set(shown);
    const ids = [...shown, ...[...selection.selectedIds].filter((id) => !shownSet.has(id))];
    if (ids.length === 0) return;
    setSeriesBusy(true);
    setSeriesError(null);
    try {
      if (choice.kind === "metadata") await resetBookSeries(ids);
      else await setBookSeries(ids, choice.kind === "name" ? choice.name : null);
      await refresh();
      setSeriesOpen(false);
      cancelSelection();
    } catch (error) {
      setSeriesError(errorMessage(error));
    } finally {
      setSeriesBusy(false);
    }
  }

  function requestBulkRemoval() {
    if (selection.selectedCount === 0) return;
    setBulkDialogError(null);
    setBulkRemoveOpen(true);
  }

  async function confirmBulkRemoval() {
    const requestedIds = [...selection.selectedIds];
    if (requestedIds.length === 0 || bulkRemoving || operation?.active) return;
    setBulkRemoving(true);
    setBulkDialogError(null);
    setBulkFailures([]);
    try {
      const results = await removeBooks(requestedIds);
      const byId = new Map(results.map((result) => [result.id, result]));
      const removedIds = new Set(requestedIds.filter((id) => byId.get(id)?.status === "removed"));
      const failed = requestedIds
        .filter((id) => !removedIds.has(id))
        .map((id) => {
          const book = library.books.find((item) => item.id === id);
          return {
            id,
            title: book?.title ?? book?.fileName ?? i18n().t("library.untitled"),
            message: byId.get(id)?.message ?? i18n().t("library.noRemovalResult"),
          };
        });

      setLibrary((current) => ({
        ...current,
        books: current.books.filter((book) => !removedIds.has(book.id)),
      }));
      setBulkRemoveOpen(false);
      if (failed.length > 0) {
        selection.replace(failed.map((item) => item.id));
        setBulkFailures(failed);
      } else {
        selection.cancel();
      }
    } catch (error) {
      setBulkDialogError(errorMessage(error));
    } finally {
      setBulkRemoving(false);
    }
  }

  const card = useCallback(
    (book: LibraryBook, view: LibraryView) => (
      <LibraryBookCard
        busy={Boolean(operation?.active)}
        key={book.id}
        book={book}
        view={view}
        details={details}
        onRelink={relink}
        onRemove={requestRemoval}
        onMarkUnread={requestUnread}
        relinkDisabled={relinkingId !== null || Boolean(operation?.active)}
        relinking={relinkingId === book.id}
        onSelect={selectBook}
        selected={selection.isSelected(book.id)}
        selectionMode={selection.active}
      />
    ),
    [
      details,
      relink,
      relinkingId,
      requestRemoval,
      requestUnread,
      selectBook,
      selection.active,
      selection.isSelected,
      operation?.active,
    ],
  );
  const renderBook = useCallback(
    (book: LibraryBook) => card(book, display.view),
    [card, display.view],
  );
  // Books in progress always show as grid cards.
  const renderShelfBook = useCallback((book: LibraryBook) => card(book, "grid"), [card]);

  // The search stays in the top bar even when the Library is empty.
  const search = <LibrarySearch onQueryChange={setQuery} query={query} />;
  const ready = library.status === "ready";
  const hasBooks = ready && library.books.length > 0;
  // Books in progress head the whole Library's books; selecting, searching, or filtering works
  // on the books below, so they step aside then, and a group's page has none.
  const showShelf =
    hasBooks &&
    readingBooks.length > 0 &&
    !selection.active &&
    !onGroupPage &&
    query.trim() === "" &&
    display.filter === "all";

  return (
    <div
      className="page page--library"
      style={{ ["--library-card-min" as string]: `${display.cardSize}px` }}
    >
      {dragging && (
        <div className="library-drop-overlay" role="status" aria-live="polite">
          <div className="library-drop-overlay__card">
            <UploadSimpleIcon size={44} aria-hidden="true" />
            <strong>
              {t(
                dropBusy
                  ? "operation.busy"
                  : dragging === "epub"
                    ? "library.dropEpubs"
                    : "library.epubsOnly",
              )}
            </strong>
          </div>
        </div>
      )}
      {searchSlot ? createPortal(search, searchSlot) : search}
      <h1 className="visually-hidden">{t("shell.library")}</h1>
      <OperationNotice
        operation={operation}
        items={library.books.map((book) => ({ id: book.id, title: book.title ?? book.fileName }))}
      />

      {imports.error ? (
        <div className="library-notice" role="alert">
          <span>{t("library.importFailed", { error: failureText(imports.error, t) })}</span>
          <NoticeClose onClose={imports.dismiss} />
        </div>
      ) : null}
      {imports.result ? <ImportNotice result={imports.result} onClose={imports.dismiss} /> : null}
      {relinkNotice ? <RelinkNotice notice={relinkNotice} /> : null}
      {bulkFailures.length > 0 ? (
        <div className="library-notice library-notice--error" role="alert">
          <WarningCircleIcon aria-hidden="true" />
          <div>
            <strong>{tp("library.removeFailures", bulkFailures.length)}</strong>
            <ul>
              {bulkFailures.map((failure) => (
                <li key={failure.id}>
                  <strong>{failure.title}:</strong> {failureText(failure.message, t)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <section className="library-collection" aria-labelledby="library-collection-title">
        <div className="library-section-heading">
          {onGroupPage ? (
            <div className="library-section-heading__title">
              <Link className="library-back" to="/library">
                <ArrowLeftIcon aria-hidden="true" size={15} weight="bold" />
                {t("shell.library")}
              </Link>
              <h2 id="library-collection-title" title={wholeGroup?.title ?? undefined}>
                {wholeGroup?.title ?? t("library.groupNotFound")}
              </h2>
              {wholeGroup ? (
                <LibrarySummary books={wholeGroup.books} shown={sectionBooks.length} />
              ) : null}
            </div>
          ) : (
            <div className="library-section-heading__title">
              <h2 id="library-collection-title">{t("shell.library")}</h2>
              {hasBooks ? <LibrarySummary books={library.books} shown={shownBooks.length} /> : null}
            </div>
          )}
          {library.status === "error" ? (
            <Button
              tone="secondary"
              icon={<ArrowClockwiseIcon aria-hidden="true" />}
              onClick={() => void refresh()}
            >
              {t("common.tryAgain")}
            </Button>
          ) : hasBooks ? (
            <LibraryToolbar
              display={display}
              grouping={!onGroupPage}
              onDisplayChange={updateLibrary}
            />
          ) : null}
        </div>

        {library.status === "loading" ? (
          <Card className="content-card content-card--fill">
            <div className="library-status" role="status">
              {t("library.loading")}
            </div>
          </Card>
        ) : null}
        {library.status === "error" ? (
          <Card className="content-card content-card--fill">
            <EmptyState
              icon={WarningCircleIcon}
              title={t("library.unavailable")}
              description={library.message}
            />
          </Card>
        ) : null}
        {ready && library.books.length === 0 ? (
          <Card className="content-card content-card--fill">
            <EmptyState
              icon={BooksIcon}
              title={t("library.empty")}
              description={t("library.emptyDescription")}
              action={
                <Button
                  disabled={imports.busy}
                  icon={<PlusIcon aria-hidden="true" />}
                  onClick={() => void imports.run()}
                >
                  {imports.busy ? imports.label : t("shell.addBooks")}
                </Button>
              }
            />
          </Card>
        ) : null}
        {hasBooks && sectionBooks.length === 0 ? (
          <div className="book-library__empty" role="status">
            <MagnifyingGlassIcon aria-hidden="true" />
            <strong>{t("library.noneFound")}</strong>
            <span>{t("library.noneFoundHint")}</span>
          </div>
        ) : null}
        {showShelf ? <ContinueReading books={readingBooks} renderBook={renderShelfBook} /> : null}
        {showShelf && display.group === "none" && sectionBooks.length > 0 ? (
          <AllBooksHeading />
        ) : null}
        {ready && sectionBooks.length > 0 ? (
          <LibraryCollection
            groupLink={onGroupPage ? undefined : groupPageLink}
            sections={sections}
            onRowOffset={libraryCache.setRowOffset}
            onScroll={savePlace}
            renderBook={renderBook}
            restore={restore}
            rowOffset={libraryCache.rowOffset}
            view={display.view}
          />
        ) : null}
      </section>
      {/* On the body, so the page's own arrival animation never moves it. */}
      {hasBooks && selection.active
        ? createPortal(
            <div
              className="library-selection-bar"
              aria-label={t("library.selection")}
              role="toolbar"
            >
              <output aria-live="polite" className="library-selection-bar__count">
                {tp("library.selected", selection.selectedCount)}
              </output>
              <span className="library-selection-bar__hint">{t("library.rangeHint")}</span>
              <span aria-hidden="true" className="library-selection-bar__divider" />
              <button
                className="library-selection-bar__button"
                disabled={Boolean(operation?.active)}
                onClick={() => selection.replace(orderedIds)}
                title={t("library.selectAllTitle")}
                type="button"
              >
                {t("library.selectAll")}
              </button>
              <button
                className="library-selection-bar__button"
                disabled={selection.selectedCount === 0 || Boolean(operation?.active)}
                onClick={() => {
                  selection.replace([]);
                  anchorRef.current = null;
                }}
                type="button"
              >
                {t("library.clear")}
              </button>
              <button
                className="library-selection-bar__button"
                disabled={selection.selectedCount === 0 || Boolean(operation?.active)}
                onClick={() => {
                  setSeriesError(null);
                  setSeriesOpen(true);
                }}
                type="button"
              >
                <StackIcon aria-hidden="true" size={16} />
                {t("library.series")}
              </button>
              <button
                className="library-selection-bar__button library-selection-bar__button--danger"
                disabled={selection.selectedCount === 0 || Boolean(operation?.active)}
                onClick={requestBulkRemoval}
                title={t("library.removeTitle")}
                type="button"
              >
                <TrashIcon aria-hidden="true" size={16} />
                {t("common.remove")}
              </button>
              <button
                aria-label={t("library.doneSelecting")}
                disabled={Boolean(operation?.active)}
                className="library-selection-bar__close"
                onClick={cancelSelection}
                title={t("library.doneTitle")}
                type="button"
              >
                <XIcon aria-hidden="true" size={16} weight="bold" />
              </button>
            </div>,
            document.body,
          )
        : null}
      <SeriesDialog
        busy={seriesBusy}
        count={selection.selectedCount}
        error={seriesError}
        initialName={sharedSeries}
        onCancel={() => setSeriesOpen(false)}
        onConfirm={(choice) => void saveSeries(choice)}
        open={seriesOpen}
        suggestions={seriesNames}
      />
      <ConfirmDialog
        busy={removing}
        busyLabel={operation?.active ? operationLabel(operation) : t("library.removing")}
        confirmDisabled={Boolean(operation?.active)}
        confirmLabel={t("library.removeConfirm")}
        description={t("library.removeDescription")}
        error={removeError}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => void confirmRemoval()}
        open={removeTarget !== null}
        title={t("library.removeDialogTitle")}
      />
      <ConfirmDialog
        busy={markingUnread}
        busyLabel={t("library.markingUnread")}
        confirmLabel={t("library.markUnread")}
        confirmTone="primary"
        description={t("library.unreadDescription")}
        error={unreadError}
        onCancel={() => setUnreadTarget(null)}
        onConfirm={() => void confirmUnread()}
        open={unreadTarget !== null}
        title={t("library.unreadTitle")}
      />
      <ConfirmDialog
        busy={bulkRemoving}
        busyLabel={operation?.active ? operationLabel(operation) : t("library.removing")}
        confirmDisabled={Boolean(operation?.active)}
        confirmLabel={tp("library.bulkConfirm", selection.selectedCount)}
        description={tp("library.bulkDescription", selection.selectedCount)}
        error={bulkDialogError}
        onCancel={() => setBulkRemoveOpen(false)}
        onConfirm={() => void confirmBulkRemoval()}
        open={bulkRemoveOpen}
        title={tp("library.bulkTitle", selection.selectedCount)}
      />
    </div>
  );
}

function relinkNoticeFor(result: RelinkResult): RelinkNoticeState {
  const { t } = i18n();
  switch (result.status) {
    case "canceled":
      return {
        kind: "canceled",
        title: t("library.relinkCanceled"),
        message: t("library.relinkCanceledMessage"),
      };
    case "invalid":
      return {
        kind: "invalid",
        title: t("library.relinkInvalid"),
        message: result.message
          ? failureText(result.message, t)
          : t("library.relinkInvalidMessage"),
      };
    case "duplicate":
      return {
        kind: "duplicate",
        title: t("library.relinkDuplicate"),
        message: result.message
          ? failureText(result.message, t)
          : t("library.relinkDuplicateMessage"),
      };
    case "readFailed":
      return {
        kind: "error",
        title: t("library.relinkUnreadable"),
        message: result.message
          ? failureText(result.message, t)
          : t("library.relinkUnreadableMessage"),
      };
    case "failed":
    default:
      return {
        kind: "error",
        title: t("library.relinkFailed"),
        message: result.message ? failureText(result.message, t) : t("library.relinkFailedMessage"),
      };
  }
}

function RelinkNotice({ notice }: { notice: RelinkNoticeState }) {
  const isError = ["invalid", "duplicate", "error"].includes(notice.kind);
  return (
    <div
      className={`library-notice${isError ? " library-notice--error" : ""}`}
      role={isError ? "alert" : "status"}
    >
      {notice.kind === "success" ? (
        <CheckCircleIcon aria-hidden="true" />
      ) : notice.kind === "canceled" ? (
        <LinkSimpleIcon aria-hidden="true" />
      ) : (
        <WarningCircleIcon aria-hidden="true" />
      )}
      <div>
        <strong>{notice.title}</strong>
        <p>{notice.message}</p>
      </div>
    </div>
  );
}

function ImportNotice({ result, onClose }: { result: ImportBatch; onClose: () => void }) {
  const imported = result.results.filter((item) => item.status === "imported").length;
  const existing = result.results.filter((item) => item.status === "alreadyImported").length;
  const failures = result.results.filter((item) => item.status === "failed");
  const { t } = useI18n();
  return (
    <div className="library-notice" role="status">
      <div>
        <strong>
          {t("library.imported", { count: imported })}
          {existing > 0 ? ` · ${t("library.alreadyImported", { count: existing })}` : ""}
          {failures.length > 0
            ? ` · ${t("library.importFailures", { count: failures.length })}`
            : ""}
        </strong>
        {failures.length > 0 ? (
          <ul>
            {failures.map((item, index) => (
              <li key={`${item.fileName}-${index}`}>
                <strong>{item.fileName}:</strong> {item.message && failureText(item.message, t)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <NoticeClose onClose={onClose} />
    </div>
  );
}

function errorMessage(error: unknown): string {
  return failureText(error instanceof Error ? error.message : String(error), i18n().t);
}

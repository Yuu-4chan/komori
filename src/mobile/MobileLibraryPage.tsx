import {
  BooksIcon,
  CheckCircleIcon,
  CheckIcon,
  DownloadSimpleIcon,
  FunnelSimpleIcon,
  InfoIcon,
  LinkSimpleIcon,
  PencilSimpleIcon,
  PlusIcon,
  StackIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { Button } from "../components/ui/Button";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { EmptyState } from "../components/ui/EmptyState";
import { NoticeClose } from "../components/ui/NoticeClose";
import { useAppearance } from "../features/appearance/AppearanceProvider";
import { BookCover } from "../features/library/BookCover";
import { BookEditDialog } from "../features/library/BookEditDialog";
import {
  editBooks,
  getLibraryBook,
  listLibrary,
  onLibraryDetailsUpdated,
  markBooksCompleted,
  relinkBook,
  removeBook,
  removeBooks,
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
import { LibrarySearch } from "../features/library/LibraryToolbar";
import { SeriesDialog, type SeriesChoice } from "../features/library/SeriesDialog";
import {
  bookTitle,
  canMarkCompleted,
  groupBooks,
  groupPageLink,
  hasReadingProgress,
  languageName,
  lastReadLabel,
  matchesQuery,
  progressLabel,
  progressPercent,
  readTotalLabel,
  readingStatus,
  sectionGroup,
  seriesFromTitles,
  sortBooks,
  type LibraryPlace,
} from "../features/library/libraryView";
import { useSelection } from "../features/selection/useSelection";
import { failureText } from "../i18n/failure";
import { i18n, useI18n } from "../i18n/i18n";
import { MobilePageHeader } from "./MobileShell";

import { useLongPress } from "./longPress";
import {
  BookInfoSheet,
  GroupHeading,
  itemKey,
  LibraryBooks,
  LibraryItem,
  LibraryViewSheet,
  narrowed,
  PLACE_LABELS,
  SelectionBar,
  SelectionHeader,
  type ItemActions,
  type ItemSection,
  type SelectionAction,
} from "./MobileLibraryView";
import {
  PcContinueCard,
  PcStatusRow,
  usePcBookActions,
  usePcLibrary,
  type PcEntry,
} from "./MobilePcLibrary";
import { MobileSheet } from "./MobileSheet";
import { pcSession } from "./pcLibrarySession";
import { changesPcListing, onPcSynced, syncPc, usePcLinkState } from "./pcLinkApi";
import { mergePcLibrary, phoneItem, type MergedBook } from "./pcLibraryMerge";
import { PullToSync } from "./pullToSync";
import { useBackCloser } from "./system";

type Listing =
  | { status: "loading"; books: LibraryBook[] }
  | { status: "ready"; books: LibraryBook[] }
  | { status: "error"; books: LibraryBook[]; message: string };

/** A book the Library lists: the phone's own, or the paired PC's (with its copy here, if any). */
type Item = MergedBook;

/** How long the Library waits for all it holds before showing what it has (ms). */
const SHOW_WITHIN = 2000;

const onThisPhone = (item: Item) => item.kind === "phone" || item.entry.pc.kept;

/**
 * The Library on the phone: its count of books, search, Add books, the books in progress to
 * continue, and every book with its progress, as the PC's Library chooses them: by reading
 * status, grouped by series, language or author in rows that scroll sideways under headings
 * opening each group's page, sorted either way, as a grid or a list (the Library view button's
 * sheet). Paired with a PC
 * (Sync with PC on), it lists the PC's books with the phone's own, with the PC's status above
 * them and All / On this phone / On PC to choose from; the PC's books show at once from what the
 * phone saved, while the PC is listed again behind them. Tapping a book opens it (a PC book
 * downloads first unless it is here; a missing one offers Relink and Remove). A long press
 * selects a book, or a group's books from its heading; then taps select more, and a bar offers
 * what applies to them: Information for one book, Series…, Edit…, Mark as completed and Remove
 * for the phone's books, Keep on this phone and Remove from this phone for the PC's.
 */
// Wherever the phone is, a sync that changed its books and books' details read in the
// background make the Library's listing old, so its next showing lists the catalog again.
onPcSynced((sync) => {
  if (sync.changed) libraryCache.markStale();
});
onLibraryDetailsUpdated(() => libraryCache.markStale());

export function MobileLibraryPage() {
  const [params] = useSearchParams();
  const group = params.get("group");
  return <LibraryContent group={group} key={group ?? ""} />;
}

/** The Library, or with `group` (a section key such as `series:Name`) that group's own page. */
function LibraryContent({ group }: { group: string | null }) {
  const navigate = useNavigate();
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
  const [editing, setEditing] = useState<LibraryBook[] | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [seriesOpen, setSeriesOpen] = useState(false);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [bulkRemoveOpen, setBulkRemoveOpen] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [info, setInfo] = useState<LibraryBook | null>(null);
  const requests = useRef(0);
  const importVersion = useRef(imports.version);
  importVersion.current = imports.version;

  const refresh = useCallback(async () => {
    const request = ++requests.current;
    const version = importVersion.current;
    try {
      const books = await listLibrary();
      if (request !== requests.current) return false;
      libraryCache.setBooks(books);
      libraryCache.setImportVersion(version);
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
  // Reads the books opened since the last showing again, and nothing else.
  const refreshBooks = useCallback(
    async (ids: string[]) => {
      const request = ++requests.current;
      try {
        const fresh = new Map(
          await Promise.all(ids.map(async (id) => [id, await getLibraryBook(id)] as const)),
        );
        if (request !== requests.current) return;
        const current = libraryCache.books() ?? [];
        const books = current.flatMap((book) =>
          fresh.has(book.id) ? (fresh.get(book.id) ?? []) : [book],
        );
        const known = new Set(current.map((book) => book.id));
        for (const book of fresh.values()) if (book && !known.has(book.id)) books.push(book);
        libraryCache.setBooks(books);
        setListing({ status: "ready", books });
      } catch {
        if (request === requests.current) void refresh();
      }
    },
    [refresh],
  );

  // The catalog is listed whole when the app starts, after an import, a sync or a pull, and
  // when something outside the Library changed it; a showing otherwise keeps the last listing,
  // with the books read since then read again.
  useEffect(() => {
    const touched = libraryCache.takeTouched();
    if (
      !libraryCache.books() ||
      libraryCache.stale() ||
      imports.version !== libraryCache.importVersion()
    )
      void refresh();
    else if (touched.length) void refreshBooks(touched);
  }, [refresh, refreshBooks, imports.version]);
  // The book folders are looked in once a session, and on each sync or pull.
  const { scanFolders } = imports;
  useEffect(() => {
    if (libraryCache.takeFolderScan()) void scanFolders();
  }, [scanFolders]);

  const { link, settled: linkSettled } = usePcLinkState();
  const pcActive = link?.paired === true && link.syncOn;
  const pc = usePcLibrary(pcActive, !linkSettled);
  const pcActions = usePcBookActions();
  const pcName = link?.pcName ?? "";
  const { library: display, updateLibrary } = useAppearance();
  const place: LibraryPlace = pcActive ? display.place : "all";
  // After each sync, the books show where they were read to on both sides. The PC is listed
  // again after a listing already running when the sync changed what it lists; otherwise only
  // once its listing is old, as starting and returning sync too.
  const { refresh: relistPc, refreshIfStale: relistStalePc } = pc;
  useEffect(
    () =>
      onPcSynced((sync) => {
        if (sync.changed) void refresh();
        void scanFolders();
        if (pcActive) void (changesPcListing(sync) ? relistPc() : relistStalePc());
      }),
    [refresh, pcActive, relistPc, relistStalePc, scanFolders],
  );
  const [syncing, setSyncing] = useState(false);
  // Pulling the Library down, or Sync now, syncs with the PC and lists both again.
  const syncNow = useCallback(async () => {
    void scanFolders();
    if (!pcActive) {
      await refresh();
      return;
    }
    setSyncing(true);
    try {
      // Asked for, the PC's books are listed again whatever the sync did.
      pcSession.markStale();
      // …and the phone's, which the sync lists itself when it changed them.
      if (!(await syncPc()).changed) await refresh();
    } catch {
      await Promise.all([refresh(), relistPc()]);
    } finally {
      setSyncing(false);
    }
  }, [pcActive, refresh, relistPc, scanFolders]);

  const allBooks = listing.books;
  const pcEntries = pc.entries;
  // The Library shows once it can show all it holds: the phone's books, whether it is paired,
  // and while paired the PC's books as last saved (or the PC's answer, before any is saved),
  // so books never appear in steps. A pairing that cannot be read waits at most a moment.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setWaited(true), SHOW_WITHIN);
    return () => window.clearTimeout(timer);
  }, []);
  const complete =
    listing.status !== "loading" &&
    (waited || (linkSettled && (!pcActive || pcEntries !== null || pc.connection !== "unknown")));
  const items = useMemo<Item[]>(() => {
    if (!complete) return [];
    // Until the pairing is read, the PC's copies wait, so they never show as the phone's.
    if (link === null) return allBooks.filter((book) => !book.fromPc).map(phoneItem);
    if (!pcActive) return allBooks.map(phoneItem);
    return mergePcLibrary(allBooks, pcEntries);
  }, [allBooks, complete, link, pcActive, pcEntries]);
  const placed = useMemo(
    () =>
      place === "phone"
        ? items.filter(onThisPhone)
        : place === "pc"
          ? items.filter((item) => item.kind === "pc")
          : items,
    [items, place],
  );
  // The place's books of the reading status chosen, which the heading counts.
  const filtered = useMemo(
    () =>
      display.filter === "all"
        ? placed
        : placed.filter((item) => readingStatus(item.book) === display.filter),
    [display.filter, placed],
  );
  const byId = useMemo(() => new Map(placed.map((item) => [item.book.id, item])), [placed]);
  // Grouped, the sort orders the groups and each group's books follow the group sort (Title
  // unless a PC's group page chose another), as the PC's carousels show them; a group's page
  // shows its books in that order too.
  const groupKind = group === null ? null : sectionGroup(group);
  const onGroupPage = groupKind !== null;
  const grouped = !onGroupPage && display.group !== "none";
  const sections = useMemo<ItemSection[]>(() => {
    const books = sortBooks(
      filtered.map((item) => item.book).filter((book) => matchesQuery(book, query)),
      grouped || onGroupPage ? display.groupSort : display.sort,
      grouped || onGroupPage ? display.groupSortReversed : display.sortReversed,
    );
    const toItems = (each: LibraryBook[]) => each.flatMap((book) => byId.get(book.id) ?? []);
    if (groupKind !== null) {
      const own = groupBooks(books, groupKind).find((section) => section.key === group);
      return [{ key: group ?? "", title: null, items: toItems(own?.books ?? []) }];
    }
    return groupBooks(books, display.group, display.sort, display.sortReversed).map((section) => ({
      key: section.key,
      title: section.title,
      items: toItems(section.books),
    }));
  }, [
    byId,
    display.group,
    display.groupSort,
    display.groupSortReversed,
    display.sort,
    display.sortReversed,
    filtered,
    group,
    groupKind,
    grouped,
    onGroupPage,
    query,
  ]);
  const shown = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const placedBooks = useMemo(() => placed.map((item) => item.book), [placed]);
  // A group's page is named as its heading names it, whatever the filters and search.
  const groupTitle = useMemo(() => {
    if (groupKind === null || group === null) return "";
    const whole = groupBooks(placedBooks, groupKind).find((section) => section.key === group);
    return whole?.title ?? group.slice(group.indexOf(":") + 1);
  }, [group, groupKind, placedBooks]);
  // Books in progress head the Library while it shows all its books and nothing is searched.
  const inProgress = useMemo(
    () =>
      sortBooks(
        placedBooks.filter((book) => book.availability === "available" && hasReadingProgress(book)),
        "recent",
        false,
      ).flatMap((book) => byId.get(book.id) ?? []),
    [byId, placedBooks],
  );
  const ownBooks = useMemo(() => allBooks.filter((book) => !book.fromPc), [allBooks]);
  const seriesNames = useMemo(
    () =>
      [...new Set(ownBooks.flatMap((book) => (book.series ? [book.series] : [])))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [ownBooks],
  );

  // Selecting: by a long press on a book or a group's heading, then by taps.
  const keys = useMemo(() => items.map(itemKey), [items]);
  const selection = useSelection(keys);
  const { active: selecting, enter, toggle, add, replace, cancel } = selection;
  const select = useCallback(
    (key: string) => {
      if (!selecting) enter();
      toggle(key);
    },
    [enter, selecting, toggle],
  );
  const shownKeys = useMemo(() => shown.map(itemKey), [shown]);
  const allSelected =
    shownKeys.length > 0 && shownKeys.every((key) => selection.selectedIds.has(key));
  const selectGroup = useCallback(
    (section: ItemSection) => {
      const groupKeys = section.items.map(itemKey);
      if (!selecting) enter();
      if (selecting && groupKeys.every((key) => selection.selectedIds.has(key)))
        replace([...selection.selectedIds].filter((key) => !groupKeys.includes(key)));
      else add(groupKeys);
    },
    [add, enter, replace, selecting, selection.selectedIds],
  );
  // The selected books in the order shown; any selected book no longer shown follows.
  const chosen = useMemo(() => {
    const byKey = new Map(items.map((item) => [itemKey(item), item]));
    const order = [...shownKeys, ...keys.filter((key) => !shownKeys.includes(key))];
    return order.flatMap((key) => (selection.selectedIds.has(key) ? (byKey.get(key) ?? []) : []));
  }, [items, keys, selection.selectedIds, shownKeys]);
  const chosenOwn = useMemo(
    () => chosen.flatMap((item) => (item.kind === "phone" ? [item.book] : [])),
    [chosen],
  );
  const chosenPc = useMemo(
    () => chosen.flatMap((item) => (item.kind === "pc" ? [item.entry] : [])),
    [chosen],
  );
  const dialogOpen =
    editing !== null ||
    seriesOpen ||
    bulkRemoveOpen ||
    removing !== null ||
    viewOpen ||
    info !== null;
  useBackCloser(selecting && !dialogOpen, cancel);
  // The series every chosen book shares or, without one, the name their titles begin with.
  const sharedSeries = useMemo(() => {
    const first = chosenOwn[0]?.series ?? "";
    return first && chosenOwn.every((book) => book.series === first)
      ? first
      : chosenOwn.length === 1
        ? seriesFromTitles([bookTitle(chosenOwn[0]!)])
        : seriesFromTitles(chosenOwn.map(bookTitle));
  }, [chosenOwn]);

  async function saveEdits(edits: BookEdit[]) {
    setBusy(true);
    setEditError(null);
    try {
      await editBooks(edits);
      await refresh();
      setEditing(null);
      cancel();
    } catch (error) {
      setEditError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveSeries(choice: SeriesChoice) {
    const ids = chosenOwn.map((book) => book.id);
    if (ids.length === 0) return;
    setBusy(true);
    setSeriesError(null);
    try {
      if (choice.kind === "metadata") await resetBookSeries(ids);
      else await setBookSeries(ids, choice.kind === "name" ? choice.name : null);
      await refresh();
      setSeriesOpen(false);
      cancel();
    } catch (error) {
      setSeriesError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  // Marking completed asks nothing, as on the PC: reading on undoes it.
  async function markCompleted(books: LibraryBook[]) {
    setBusy(true);
    setCompleteError(null);
    try {
      await markBooksCompleted(books.filter(canMarkCompleted).map((book) => book.id));
      await refresh();
      cancel();
    } catch (error) {
      setCompleteError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function removeChosen() {
    const ids = chosenOwn.map((book) => book.id);
    if (ids.length === 0) return;
    setBusy(true);
    setBulkError(null);
    try {
      const results = await removeBooks(ids);
      const removed = new Set(
        results.flatMap((result) => (result.status === "removed" ? [result.id] : [])),
      );
      setListing((current) => ({
        ...current,
        books: current.books.filter((book) => !removed.has(book.id)),
      }));
      const failed = results.find((result) => result.status !== "removed");
      if (failed) {
        setBulkError(failureText(failed.message ?? t("library.noRemovalResult"), t));
        replace(ids.filter((id) => !removed.has(id)).map((id) => `phone:${id}`));
      } else {
        setBulkRemoveOpen(false);
        cancel();
      }
    } catch (error) {
      setBulkError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  // Each PC book is kept, or its copy here removed, one after another.
  async function keepChosen(entries: PcEntry[]) {
    cancel();
    for (const entry of entries) await pcActions.keep(entry);
  }
  async function removeChosenCopies(entries: PcEntry[]) {
    cancel();
    for (const entry of entries) await pcActions.remove(entry);
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

  const { keep: keepPc, open: openPc, saving } = pcActions;
  const itemActions: ItemActions = useMemo(
    () => ({
      selecting,
      isSelected: selection.isSelected,
      onSelect: select,
      onOpenPc: (entry) => void openPc(entry),
      onKeepPc: (entry) => void keepPc(entry),
      onMissing: setMissing,
      saving,
    }),
    [keepPc, openPc, saving, select, selecting, selection.isSelected],
  );

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

  const status = pcActive ? (
    <PcStatusRow
      connection={pc.connection}
      lastSynced={link?.lastSynced ?? null}
      onOpenSync={() => navigate("/settings?section=sync")}
      onRetry={() => void relistPc()}
      onSync={() => void syncNow()}
      pcName={pcName}
      syncing={syncing}
    />
  ) : null;

  const selectionActions: SelectionAction[] = [
    ...(chosen.length === 1
      ? [
          {
            key: "info",
            label: t("library.information"),
            icon: <InfoIcon aria-hidden="true" />,
            onClick: () => setInfo(chosen[0]!.book),
          },
        ]
      : []),
    ...(chosenOwn.length
      ? [
          {
            key: "series",
            label: t("library.series"),
            icon: <StackIcon aria-hidden="true" />,
            disabled: busy,
            onClick: () => {
              setSeriesError(null);
              setSeriesOpen(true);
            },
          },
          {
            key: "edit",
            label: t("libraryCard.editMenu"),
            icon: <PencilSimpleIcon aria-hidden="true" />,
            disabled: busy,
            onClick: () => {
              setEditError(null);
              setEditing(chosenOwn);
            },
          },
        ]
      : []),
    ...(chosenOwn.some(canMarkCompleted)
      ? [
          {
            key: "completed",
            label: t("library.markCompleted"),
            icon: <CheckCircleIcon aria-hidden="true" />,
            disabled: busy,
            onClick: () => void markCompleted(chosenOwn),
          },
        ]
      : []),
    ...(chosenPc.some((entry) => !entry.pc.kept)
      ? [
          {
            key: "keep",
            label: t("sync.keep"),
            icon: <DownloadSimpleIcon aria-hidden="true" />,
            onClick: () => void keepChosen(chosenPc.filter((entry) => !entry.pc.kept)),
          },
        ]
      : []),
    ...(chosenPc.some((entry) => entry.pc.onPhone)
      ? [
          {
            key: "remove-copy",
            label: t("sync.removeFromPhone"),
            icon: <TrashIcon aria-hidden="true" />,
            onClick: () => void removeChosenCopies(chosenPc.filter((entry) => entry.pc.onPhone)),
          },
        ]
      : []),
    ...(chosenOwn.length
      ? [
          {
            key: "remove",
            label: t("common.remove"),
            icon: <TrashIcon aria-hidden="true" />,
            danger: true,
            disabled: busy,
            onClick: () => {
              setBulkError(null);
              setBulkRemoveOpen(true);
            },
          },
        ]
      : []),
  ];

  return (
    <div className={`mobile-page mobile-library${selecting ? " mobile-library--selecting" : ""}`}>
      <PullToSync enabled={!selecting} onPull={syncNow} />
      {selecting ? (
        <SelectionHeader
          allSelected={allSelected}
          count={selection.selectedCount}
          onClear={() => replace([])}
          onDone={cancel}
          onSelectAll={() => replace(shownKeys)}
        />
      ) : (
        <MobilePageHeader
          actions={onGroupPage ? undefined : addBooks}
          back={onGroupPage}
          title={onGroupPage ? groupTitle : t("shell.library")}
        />
      )}

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
        {pcActions.problem ? (
          <div className="library-notice" role="alert">
            <span>{t(pcActions.problem, { name: pcName })}</span>
            <NoticeClose onClose={pcActions.dismissProblem} />
          </div>
        ) : null}
      </div>

      {items.length === 0 ? (
        listing.status === "error" ? (
          <>
            {status}
            <EmptyState
              description={listing.message}
              icon={WarningCircleIcon}
              title={t("library.unavailable")}
            />
          </>
        ) : complete ? (
          <>
            {status}
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
          </>
        ) : (
          status
        )
      ) : (
        <>
          <div className="mobile-search">
            <LibrarySearch onQueryChange={setQuery} query={query} />
          </div>
          {onGroupPage ? null : status}

          {inProgress.length > 0 && !query && display.filter === "all" && !onGroupPage ? (
            <section className="mobile-library__section" aria-labelledby="mobile-continue">
              <h2 className="mobile-section-heading">
                <span id="mobile-continue">{t("libraryCard.continue")}</span>
                <small>{tp("librarySummary.inProgress", inProgress.length)}</small>
              </h2>
              <ul
                className={
                  inProgress.length > 1
                    ? "mobile-continue-row mobile-continue-row--several"
                    : "mobile-continue-row"
                }
              >
                {inProgress.map((item) => {
                  const key = itemKey(item);
                  const selected = selecting && selection.isSelected(key);
                  return (
                    <li key={key}>
                      {item.kind === "phone" ? (
                        <ContinueCard
                          book={item.book}
                          onSelect={() => select(key)}
                          selected={selected}
                          selecting={selecting}
                        />
                      ) : (
                        <PcContinueCard
                          entry={item.entry}
                          onChoose={() => select(key)}
                          onOpen={(entry) => (selecting ? select(key) : void openPc(entry))}
                          selected={selecting ? selected : undefined}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          <section className="mobile-library__section" aria-labelledby="mobile-all-books">
            <div className="mobile-books-heading">
              <div className="mobile-books-heading__text">
                <h2 className="mobile-section-heading" id="mobile-all-books">
                  {t(PLACE_LABELS[place])}
                </h2>
                {complete ? (
                  <small className="mobile-books-heading__count">
                    {tp("librarySummary.books", onGroupPage ? shown.length : filtered.length)}
                  </small>
                ) : null}
              </div>
              <button
                aria-label={t("libraryToolbar.view")}
                className={`mobile-books-heading__filter${narrowed(display, pcActive, onGroupPage) ? " mobile-books-heading__filter--active" : ""}`}
                onClick={() => setViewOpen(true)}
                type="button"
              >
                <FunnelSimpleIcon aria-hidden="true" weight="bold" />
              </button>
            </div>
            {shown.length === 0 ? (
              <p className="mobile-library__none">{t("library.noneFound")}</p>
            ) : (
              <LibraryBooks
                grouped={grouped}
                renderHeading={(section) => (
                  <GroupHeading
                    allSelected={
                      selecting &&
                      section.items.every((item) => selection.selectedIds.has(itemKey(item)))
                    }
                    onSelect={selectGroup}
                    section={section}
                    selecting={selecting}
                  />
                )}
                renderItem={(item, view) => (
                  <LibraryItem actions={itemActions} item={item} view={view} />
                )}
                sections={sections}
                view={display.view}
              />
            )}
          </section>
        </>
      )}

      {selecting && selectionActions.length ? <SelectionBar actions={selectionActions} /> : null}

      <LibraryViewSheet
        display={display}
        groupPage={onGroupPage}
        onChange={updateLibrary}
        onClose={() => setViewOpen(false)}
        open={viewOpen}
        places={
          pcActive
            ? [
                ["all", items.length],
                ["phone", items.filter(onThisPhone).length],
                ["pc", items.filter((item) => item.kind === "pc").length],
              ]
            : null
        }
      />

      <BookInfoSheet
        book={info}
        onClose={() => setInfo(null)}
        onOpenSeries={(series) => {
          setInfo(null);
          cancel();
          navigate(groupPageLink(`series:${series}`));
        }}
      />

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

      <BookEditDialog
        books={editing}
        busy={busy}
        error={editError}
        onCancel={() => setEditing(null)}
        onConfirm={(edits) => void saveEdits(edits)}
      />
      <SeriesDialog
        busy={busy}
        count={chosenOwn.length}
        error={seriesError}
        initialName={sharedSeries}
        onCancel={() => setSeriesOpen(false)}
        onConfirm={(choice) => void saveSeries(choice)}
        open={seriesOpen}
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
      <ConfirmDialog
        busy={busy}
        busyLabel={t("library.removing")}
        confirmLabel={tp("library.bulkConfirm", chosenOwn.length)}
        description={tp("library.bulkDescription", chosenOwn.length)}
        error={bulkError}
        onCancel={() => setBulkRemoveOpen(false)}
        onConfirm={() => void removeChosen()}
        open={bulkRemoveOpen}
        title={tp("library.bulkTitle", chosenOwn.length)}
      />
    </div>
  );
}

function errorMessage(error: unknown): string {
  return failureText(error instanceof Error ? error.message : String(error), i18n().t);
}

/** The book read last, large, with how far it is read and when; while selecting, a tap selects it. */
function ContinueCard({
  book,
  selecting,
  selected,
  onSelect,
}: {
  book: LibraryBook;
  selecting: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const percent = progressPercent(book);
  const lastRead = lastReadLabel(book, Date.now(), "narrow");
  const longPress = useLongPress(onSelect);
  return (
    <Link
      aria-pressed={selecting ? selected : undefined}
      className={`mobile-continue${selected ? " is-selected" : ""}`}
      onClick={(event: MouseEvent) => {
        if (!selecting) return;
        event.preventDefault();
        onSelect();
      }}
      to={`/reader/${book.id}`}
      {...longPress}
    >
      <BookCover book={book} size="small">
        {selecting ? (
          <span aria-hidden="true" className="mobile-select-mark">
            {selected ? <CheckIcon weight="bold" /> : null}
          </span>
        ) : null}
      </BookCover>
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

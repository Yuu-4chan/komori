import {
  BookOpenIcon,
  BooksIcon,
  CheckIcon,
  DownloadSimpleIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { NoticeClose } from "../components/ui/NoticeClose";
import { BookCover } from "../features/library/BookCover";
import type { LibraryBook } from "../features/library/libraryApi";
import { LibrarySearch } from "../features/library/LibraryToolbar";
import {
  hasReadingProgress,
  lastReadLabel,
  matchesQuery,
  progressLabel,
  progressPercent,
  readingStatus,
  sortBooks,
} from "../features/library/libraryView";
import { useI18n, type MessageKey } from "../i18n/i18n";
import { useLongPress } from "./longPress";
import { MobileSheet } from "./MobileSheet";
import {
  asLibraryBook,
  keepPcBook,
  listPcLibrary,
  onPcTransfer,
  openPcBook,
  pcErrorKey,
  removePcBook,
  transferPercent,
  type PcBook,
} from "./pcLinkApi";

/** A PC book with the shape the Library's covers, progress and search read. */
interface Entry {
  pc: PcBook;
  book: LibraryBook;
}

export type PcListing =
  | { status: "loading"; entries: Entry[] }
  | { status: "ready"; entries: Entry[] }
  | { status: "error"; entries: Entry[]; problem: MessageKey };

/** The paired PC's Library while its tab is shown, listed again on each visit. */
export function usePcLibrary(active: boolean) {
  const [listing, setListing] = useState<PcListing>({ status: "loading", entries: [] });
  const requests = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requests.current;
    try {
      const books = await listPcLibrary();
      if (request !== requests.current) return;
      setListing({
        status: "ready",
        entries: books.map((pc) => ({ pc, book: asLibraryBook(pc) })),
      });
    } catch (error) {
      if (request === requests.current)
        setListing((current) => ({
          status: "error",
          entries: current.entries,
          problem: pcErrorKey(error),
        }));
    }
  }, []);
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  return { listing, refresh };
}

type Filter = "all" | "kept";

/**
 * The paired PC's Library on the phone: whether the PC answers, its search, the book it read
 * last, and every book with whether it is on this phone. Tapping a book downloads it unless it
 * is here and opens it; its badge keeps it on this phone; a long press offers both and removing
 * the copy here.
 */
export function MobilePcLibrary({
  listing,
  onQueryChange,
  pcName,
  query,
  refresh,
  tabs,
}: {
  listing: PcListing;
  onQueryChange: (query: string) => void;
  pcName: string;
  query: string;
  refresh: () => Promise<void>;
  tabs: ReactNode;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("all");
  const [chosen, setChosen] = useState<Entry | null>(null);
  // Books downloading, by PC book ID, with how much has arrived.
  const [saving, setSaving] = useState<Record<string, number>>({});
  const [problem, setProblem] = useState<MessageKey | null>(null);

  useEffect(() => {
    const stop = onPcTransfer((transfer) => {
      if (transfer.kind !== "book") return;
      setSaving((current) =>
        current[transfer.id] === undefined
          ? current
          : { ...current, [transfer.id]: transferPercent(transfer) },
      );
    });
    return () => void stop.then((unlisten) => unlisten());
  }, []);

  const { entries } = listing;
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.pc.id, entry])), [entries]);
  const kept = entries.filter((entry) => entry.pc.kept);
  const shown = useMemo(
    () =>
      sortBooks(
        entries
          .filter((entry) => filter === "all" || entry.pc.kept)
          .map((entry) => entry.book)
          .filter((book) => matchesQuery(book, query)),
        "title",
        false,
      ).flatMap((book) => byId.get(book.id) ?? []),
    [byId, entries, filter, query],
  );
  const continueEntry = useMemo(() => {
    const read = sortBooks(
      entries.map((entry) => entry.book).filter(hasReadingProgress),
      "recent",
      false,
    )[0];
    return read ? byId.get(read.id) : undefined;
  }, [byId, entries]);

  async function download(entry: Entry, action: (book: PcBook) => Promise<string>) {
    const { id } = entry.pc;
    if (saving[id] !== undefined) return null;
    setSaving((current) => ({ ...current, [id]: 0 }));
    setProblem(null);
    try {
      return await action(entry.pc);
    } catch (error) {
      setProblem(pcErrorKey(error));
      return null;
    } finally {
      setSaving(({ [id]: _done, ...rest }) => rest);
    }
  }

  async function open(entry: Entry) {
    setChosen(null);
    const local = await download(entry, openPcBook);
    if (local) navigate(`/reader/${local}`);
  }

  async function keep(entry: Entry) {
    setChosen(null);
    if (await download(entry, keepPcBook)) await refresh();
  }

  async function remove(entry: Entry) {
    setChosen(null);
    setProblem(null);
    try {
      await removePcBook(entry.pc);
      await refresh();
    } catch (error) {
      setProblem(pcErrorKey(error));
    }
  }

  const connected = listing.status === "ready";
  return (
    <>
      <div className="mobile-search">
        <LibrarySearch
          onQueryChange={onQueryChange}
          placeholder={t("sync.searchPc", { name: pcName })}
          query={query}
        />
      </div>
      {tabs}
      <div className="mobile-pc-status" aria-live="polite">
        {listing.status === "error" ? (
          <>
            <WarningCircleIcon aria-hidden="true" weight="fill" />
            <span>{t(listing.problem, { name: pcName })}</span>
            <Button tone="secondary" onClick={() => void refresh()}>
              {t("common.tryAgain")}
            </Button>
          </>
        ) : (
          <>
            <span
              aria-hidden="true"
              className={connected ? "mobile-sync__dot" : "mobile-sync__dot mobile-sync__dot--off"}
            />
            <span>{t(connected ? "sync.connectedShort" : "sync.checking")}</span>
          </>
        )}
      </div>

      {problem ? (
        <div className="mobile-notices">
          <div className="library-notice" role="alert">
            <span>{t(problem, { name: pcName })}</span>
            <NoticeClose onClose={() => setProblem(null)} />
          </div>
        </div>
      ) : null}

      {connected && entries.length === 0 ? (
        <EmptyState
          description={t("sync.pcEmptyDescription", { name: pcName })}
          icon={BooksIcon}
          title={t("library.empty")}
        />
      ) : entries.length > 0 ? (
        <>
          {continueEntry && !query ? (
            <section className="mobile-library__section" aria-labelledby="mobile-pc-continue">
              <h2 className="mobile-section-heading">
                <span id="mobile-pc-continue">{t("libraryCard.continue")}</span>
                <small>{t("sync.lastReadOn", { name: pcName })}</small>
              </h2>
              <PcContinueCard
                entry={continueEntry}
                onChoose={setChosen}
                onOpen={(entry) => void open(entry)}
              />
            </section>
          ) : null}

          <section className="mobile-library__section" aria-label={pcName}>
            <div className="mobile-filter" role="group" aria-label={t("sync.show")}>
              <button
                aria-pressed={filter === "all"}
                onClick={() => setFilter("all")}
                type="button"
              >
                {t("sync.all", { count: entries.length })}
              </button>
              <button
                aria-pressed={filter === "kept"}
                onClick={() => setFilter("kept")}
                type="button"
              >
                {t("sync.onPhoneCount", { count: kept.length })}
              </button>
            </div>
            {shown.length === 0 ? (
              <p className="mobile-library__none">{t("library.noneFound")}</p>
            ) : (
              <ul className="mobile-library__grid">
                {shown.map((entry) => (
                  <li key={entry.pc.id}>
                    <PcTile
                      entry={entry}
                      onChoose={setChosen}
                      onKeep={(each) => void keep(each)}
                      onOpen={(each) => void open(each)}
                      saving={saving[entry.pc.id]}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}

      <PcBookSheet
        entry={chosen}
        onClose={() => setChosen(null)}
        onKeep={(entry) => void keep(entry)}
        onOpen={(entry) => void open(entry)}
        onRemove={(entry) => void remove(entry)}
      />
    </>
  );
}

const openLabel = {
  "not-started": "libraryCard.start",
  reading: "libraryCard.continue",
  completed: "libraryCard.again",
} as const;

/** What a long press on a PC book offers: opening it, and keeping or removing it here. */
function PcBookSheet({
  entry,
  onClose,
  onKeep,
  onOpen,
  onRemove,
}: {
  entry: Entry | null;
  onClose: () => void;
  onKeep: (entry: Entry) => void;
  onOpen: (entry: Entry) => void;
  onRemove: (entry: Entry) => void;
}) {
  const { t } = useI18n();
  const title = entry?.book.title ?? t("library.untitled");
  return (
    <MobileSheet
      className="mobile-sheet--floating"
      label={title}
      onClose={onClose}
      open={entry !== null}
    >
      {entry ? (
        <div className="mobile-book-sheet">
          <div className="mobile-book-sheet__book">
            <BookCover book={entry.book} size="small" />
            <div>
              <strong>{title}</strong>
              <span>{entry.book.author ?? t("libraryCard.unknownAuthor")}</span>
              <span>{progressLabel(entry.book)}</span>
            </div>
          </div>
          <div className="mobile-book-sheet__actions">
            <button
              className="mobile-book-sheet__action"
              onClick={() => onOpen(entry)}
              type="button"
            >
              <BookOpenIcon aria-hidden="true" />
              {t(openLabel[readingStatus(entry.book)])}
            </button>
            {entry.pc.kept ? null : (
              <button
                className="mobile-book-sheet__action"
                onClick={() => onKeep(entry)}
                type="button"
              >
                <DownloadSimpleIcon aria-hidden="true" />
                {t("sync.keep")}
              </button>
            )}
            {entry.pc.onPhone ? (
              <button
                className="mobile-book-sheet__action mobile-book-sheet__action--danger"
                onClick={() => onRemove(entry)}
                type="button"
              >
                <TrashIcon aria-hidden="true" />
                {t("sync.removeFromPhone")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </MobileSheet>
  );
}

/** How far a book is read, as a bar and its label. */
function Progress({ book }: { book: LibraryBook }) {
  const { t } = useI18n();
  const percent = progressPercent(book);
  return (
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
  );
}

/** The book the PC read last, large, with whether it is on this phone. */
function PcContinueCard({
  entry,
  onChoose,
  onOpen,
}: {
  entry: Entry;
  onChoose: (entry: Entry) => void;
  onOpen: (entry: Entry) => void;
}) {
  const { t } = useI18n();
  const longPress = useLongPress(() => onChoose(entry));
  const lastRead = lastReadLabel(entry.book);
  return (
    <button
      className="mobile-continue mobile-continue--button"
      onClick={() => onOpen(entry)}
      type="button"
      {...longPress}
    >
      <BookCover book={entry.book} size="small" />
      <span className="mobile-continue__copy">
        <span>
          <strong>{entry.book.title ?? t("library.untitled")}</strong>
          <span>{entry.book.author ?? t("libraryCard.unknownAuthor")}</span>
        </span>
        <span className="mobile-chips">
          {entry.pc.kept ? (
            <span className="mobile-chips__saved">
              <CheckIcon aria-hidden="true" weight="bold" />
              {t("sync.onPhone")}
            </span>
          ) : null}
          {lastRead ? <span>{lastRead}</span> : null}
        </span>
        <Progress book={entry.book} />
      </span>
    </button>
  );
}

/** A PC book in the grid, with a badge for whether it is on this phone. */
function PcTile({
  entry,
  onChoose,
  onKeep,
  onOpen,
  saving,
}: {
  entry: Entry;
  onChoose: (entry: Entry) => void;
  onKeep: (entry: Entry) => void;
  onOpen: (entry: Entry) => void;
  saving: number | undefined;
}) {
  const { t } = useI18n();
  const longPress = useLongPress(() => onChoose(entry));
  const { book } = entry;
  return (
    <div className="mobile-pc-tile">
      <button className="mobile-tile" onClick={() => onOpen(entry)} type="button" {...longPress}>
        <BookCover book={book} />
        <strong className="mobile-tile__title">{book.title ?? t("library.untitled")}</strong>
        <span className="mobile-tile__author">{book.author ?? t("libraryCard.unknownAuthor")}</span>
        <Progress book={book} />
      </button>
      {saving !== undefined ? (
        <span
          aria-label={t("sync.saving", { percent: saving })}
          className="mobile-pc-tile__badge mobile-pc-tile__badge--saving"
          role="img"
          style={{ "--saved": `${saving}%` } as CSSProperties}
        />
      ) : entry.pc.kept ? (
        <span
          aria-label={t("sync.onPhone")}
          className="mobile-pc-tile__badge mobile-pc-tile__badge--kept"
          role="img"
        >
          <CheckIcon aria-hidden="true" weight="bold" />
        </span>
      ) : (
        <button
          aria-label={t("sync.keep")}
          className="mobile-pc-tile__badge"
          onClick={() => onKeep(entry)}
          type="button"
        >
          <DownloadSimpleIcon aria-hidden="true" weight="bold" />
        </button>
      )}
    </div>
  );
}

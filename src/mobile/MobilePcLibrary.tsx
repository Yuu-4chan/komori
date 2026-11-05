import {
  ArrowsClockwiseIcon,
  BookOpenIcon,
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
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "../components/ui/Button";
import { BookCover } from "../features/library/BookCover";
import type { LibraryBook } from "../features/library/libraryApi";
import {
  lastReadLabel,
  progressLabel,
  progressPercent,
  readingStatus,
  timeAgo,
} from "../features/library/libraryView";
import { useI18n, type MessageKey } from "../i18n/i18n";
import { useLongPress } from "./longPress";
import { MobileSheet } from "./MobileSheet";
import { pcSession, type PcConnection } from "./pcLibrarySession";
import {
  asLibraryBook,
  autoSync,
  cachedPcLibrary,
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
export interface PcEntry {
  pc: PcBook;
  book: LibraryBook;
}

/** How long a listing stays current before showing the Library lists the PC again. */
const STALE_AFTER = 2 * 60_000;

let listing: Promise<void> | null = null;
let listAgain = false;

/**
 * Lists the PC again in the background. A request while one runs lists once more after it,
 * so a listing asked for after a sync shows what the sync did.
 */
export function refreshPcLibrary(): Promise<void> {
  if (listing) {
    listAgain = true;
    return listing;
  }
  listing = (async () => {
    do {
      listAgain = false;
      try {
        const books = await listPcLibrary();
        pcSession.set({ books, connection: "connected", listedAt: Date.now() });
      } catch (error) {
        pcSession.set({ connection: pcErrorKey(error) });
      }
    } while (listAgain);
  })().finally(() => {
    listing = null;
  });
  return listing;
}

/** Reads the copies here again from the saved listing, as after keeping or removing one. */
async function relistCopies() {
  const books = await cachedPcLibrary().catch(() => null);
  if (books) pcSession.set({ books });
}

/**
 * The paired PC's Library while `active`: the saved listing at once, listed again in the
 * background on the first showing in a session, after a sync, or once the listing is old.
 */
export function usePcLibrary(active: boolean) {
  const session = useSyncExternalStore(pcSession.subscribe, pcSession.get);
  useEffect(() => {
    if (!active) return;
    void (async () => {
      if (pcSession.get().books === null) {
        const saved = await cachedPcLibrary().catch(() => null);
        if (saved && pcSession.get().books === null) pcSession.set({ books: saved });
      }
      if (Date.now() - pcSession.get().listedAt > STALE_AFTER) await refreshPcLibrary();
    })();
  }, [active]);
  const entries = useMemo(
    () => session.books?.map((pc) => ({ pc, book: asLibraryBook(pc) })) ?? null,
    [session.books],
  );
  return { entries, connection: session.connection, refresh: refreshPcLibrary };
}

/**
 * Opening, keeping and removing PC books on the phone, with each download's progress and the
 * last problem.
 */
export function usePcBookActions() {
  const navigate = useNavigate();
  // Books downloading, by PC book ID, with how much has arrived.
  const [saving, setSaving] = useState<Record<string, number>>({});
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const downloading = useRef(new Set<string>());

  useEffect(() => {
    const stop = onPcTransfer((transfer) => {
      if (transfer.kind !== "book") return;
      setSaving((current) =>
        current[transfer.id] === undefined
          ? current
          : { ...current, [transfer.id]: transferPercent(transfer) },
      );
    }).catch(() => null);
    return () => void stop.then((unlisten) => unlisten?.());
  }, []);

  const download = useCallback(
    async (entry: PcEntry, action: (book: PcBook) => Promise<string>) => {
      const { id } = entry.pc;
      if (downloading.current.has(id)) return null;
      downloading.current.add(id);
      setSaving((current) => ({ ...current, [id]: 0 }));
      setProblem(null);
      try {
        const local = await action(entry.pc);
        // A copy made just now has no place yet: a sync brings the PC's before it opens.
        if (entry.pc.localId === null) await autoSync();
        return local;
      } catch (error) {
        setProblem(pcErrorKey(error));
        return null;
      } finally {
        downloading.current.delete(id);
        setSaving(({ [id]: _done, ...rest }) => rest);
      }
    },
    [],
  );

  const open = useCallback(
    async (entry: PcEntry) => {
      const local = await download(entry, openPcBook);
      if (local) navigate(`/reader/${local}`);
    },
    [download, navigate],
  );

  const keep = useCallback(
    async (entry: PcEntry) => {
      if (await download(entry, keepPcBook)) await relistCopies();
    },
    [download],
  );

  const remove = useCallback(async (entry: PcEntry) => {
    setProblem(null);
    try {
      await removePcBook(entry.pc);
      await relistCopies();
    } catch (error) {
      setProblem(pcErrorKey(error));
    }
  }, []);

  return { saving, problem, dismissProblem: () => setProblem(null), open, keep, remove };
}

/**
 * The PC's status above the Library: Connected · Synced … with Sync now, the last sync until
 * the PC answers in this session, or why it does not with Try again.
 */
export function PcStatusRow({
  connection,
  lastSynced,
  onRetry,
  onSync,
  pcName,
  syncing,
}: {
  connection: PcConnection;
  lastSynced: string | null;
  onRetry: () => void;
  onSync: () => void;
  pcName: string;
  syncing: boolean;
}) {
  const { t } = useI18n();
  const connected = connection === "connected";
  const synced = timeAgo(lastSynced);
  if (connection !== "connected" && connection !== "unknown")
    return (
      <div className="mobile-pc-status" aria-live="polite">
        <WarningCircleIcon aria-hidden="true" weight="fill" />
        <span>{t(connection, { name: pcName })}</span>
        <Button tone="secondary" onClick={onRetry}>
          {t("common.tryAgain")}
        </Button>
      </div>
    );
  return (
    <div
      className={connected ? "mobile-pc-status mobile-pc-status--synced" : "mobile-pc-status"}
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className={connected ? "mobile-sync__dot" : "mobile-sync__dot mobile-sync__dot--off"}
      />
      <span>
        {connected ? (
          <>
            <span className="mobile-pc-status__label">{t("sync.connectedShort")}</span>
            {synced ? <small>{` · ${t("sync.syncedShort", { time: synced })}`}</small> : null}
          </>
        ) : synced ? (
          <small>{t("sync.syncedShort", { time: synced })}</small>
        ) : (
          <small>{pcName}</small>
        )}
      </span>
      <button
        aria-busy={syncing}
        aria-label={t("sync.syncNow")}
        className="mobile-pc-status__sync"
        disabled={syncing}
        onClick={onSync}
        type="button"
      >
        <ArrowsClockwiseIcon aria-hidden="true" weight="bold" />
      </button>
    </div>
  );
}

const openLabel = {
  "not-started": "libraryCard.start",
  reading: "libraryCard.continue",
  completed: "libraryCard.again",
} as const;

/** What a long press on a PC book offers: opening it, and keeping or removing it here. */
export function PcBookSheet({
  entry,
  onClose,
  onKeep,
  onOpen,
  onRemove,
}: {
  entry: PcEntry | null;
  onClose: () => void;
  onKeep: (entry: PcEntry) => void;
  onOpen: (entry: PcEntry) => void;
  onRemove: (entry: PcEntry) => void;
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
export function Progress({ book }: { book: LibraryBook }) {
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

/** A PC book in Continue reading, with whether it is on this phone. */
export function PcContinueCard({
  entry,
  onChoose,
  onOpen,
}: {
  entry: PcEntry;
  onChoose: (entry: PcEntry) => void;
  onOpen: (entry: PcEntry) => void;
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
export function PcTile({
  entry,
  onChoose,
  onKeep,
  onOpen,
  saving,
}: {
  entry: PcEntry;
  onChoose: (entry: PcEntry) => void;
  onKeep: (entry: PcEntry) => void;
  onOpen: (entry: PcEntry) => void;
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

import { i18n, useI18n } from "../../i18n/i18n";
import {
  ArrowLeftIcon,
  BookOpenTextIcon,
  BookmarkSimpleIcon,
  MagnifyingGlassIcon,
  ImagesIcon,
  PushPinIcon,
  SunIcon,
  NotePencilIcon,
} from "@phosphor-icons/react";
import {
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { Link } from "react-router-dom";

import { IconButton } from "../../components/ui/IconButton";
import { libraryCache, libraryReturn } from "../library/libraryCache";
import { ReaderAppearancePanel, type ReaderAppearancePanelProps } from "./ReaderAppearancePanel";
import { ReaderBookmarksPanel, type ReaderBookmarksPanelProps } from "./ReaderBookmarksPanel";
import { ReaderNotesPanel, type ReaderNotesPanelProps } from "./ReaderNotesPanel";
import { ReaderSearchPanel, type ReaderSearchPanelProps } from "./ReaderSearchPanel";
import { ReaderImagesPanel, type ReaderImagesPanelProps } from "./ReaderImagesPanel";
import type { ReaderIdentity } from "./readerIdentity";
import type { ReaderBookProgress, ReaderContentsEntry, ReaderStatus } from "./renderer";

export type ReaderSidebarView = "main" | "appearance" | "bookmarks" | "search" | "images" | "notes";

interface ReaderSidebarProps {
  identity: ReaderIdentity;
  /** Pinned beside the book, or floating over it. */
  pinned: boolean;
  /** Whether a floating sidebar is shown; a pinned one always is. */
  shown: boolean;
  status: ReaderStatus;
  /** The reading position in the whole book, once it is counted. */
  progress: ReaderBookProgress | null;
  contents: ReaderContentsEntry[];
  currentEntryId: string | null;
  navigationBusy: boolean;
  navigationError: boolean;
  onSelectEntry: (entryId: string) => void;
  view: ReaderSidebarView;
  onToggleAppearance: () => void;
  onCloseAppearance: () => void;
  appearanceRef: Ref<HTMLButtonElement>;
  /** Absent where the window has no room to pin the sidebar beside the book. */
  onTogglePin?: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocus: () => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
  appearance: ReaderAppearancePanelProps;
  bookmarks: ReaderBookmarksPanelProps;
  bookmarksRef: Ref<HTMLButtonElement>;
  onOpenBookmarks: () => void;
  search: ReaderSearchPanelProps;
  searchRef: Ref<HTMLButtonElement>;
  onOpenSearch: () => void;
  images: ReaderImagesPanelProps;
  imagesRef: Ref<HTMLButtonElement>;
  onOpenImages: () => void;
  notes: ReaderNotesPanelProps;
  notesRef: Ref<HTMLButtonElement>;
  onOpenNotes: () => void;
}

/**
 * The Reader sidebar: a top bar with the back arrow, Appearance and pin; the book's card with its
 * cover, title, author and series; the tool bar under it; then the book's contents; and along the
 * bottom, the current chapter and how far it and the book are read. A panel chosen from the tool
 * bar, or Appearance, takes the whole sidebar under the top bar, whose arrow returns to the
 * contents. Floating, it is an inset card over the book; pinned, it sits beside the book.
 */
export function ReaderSidebar({
  identity,
  pinned,
  shown,
  status,
  progress,
  contents,
  currentEntryId,
  navigationBusy,
  navigationError,
  onSelectEntry,
  view,
  onToggleAppearance,
  onCloseAppearance,
  appearanceRef,
  onTogglePin,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  appearance,
  bookmarks,
  bookmarksRef,
  onOpenBookmarks,
  search,
  searchRef,
  onOpenSearch,
  images,
  imagesRef,
  onOpenImages,
  notes,
  notesRef,
  onOpenNotes,
}: ReaderSidebarProps) {
  const book = identity.status === "book" ? identity.book : null;
  const { t } = useI18n();
  const appearanceOpen = view === "appearance";
  const panelOpen = view !== "main";
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [view]);
  // The contents read as a timeline: every entry before the current one is read.
  const { readIds, lastId } = useMemo(() => {
    const order = flattenContents(contents);
    const current = currentEntryId ? order.findIndex((entry) => entry.id === currentEntryId) : -1;
    return {
      readIds: new Set(order.slice(0, Math.max(current, 0)).map((entry) => entry.id)),
      lastId: order.at(-1)?.id ?? null,
    };
  }, [contents, currentEntryId]);
  const chapterId = progress?.chapter.entryId ?? currentEntryId;
  const chapterLabel = useMemo(
    () =>
      chapterId ? flattenContents(contents).find((entry) => entry.id === chapterId)?.label : null,
    [contents, chapterId],
  );
  const panelTitle = t(
    (
      {
        main: "sidebar.reader",
        appearance: "sidebar.appearance",
        bookmarks: "sidebar.bookmarks",
        search: "sidebar.search",
        images: "sidebar.images",
        notes: "sidebar.notes",
      } as const
    )[view],
  );
  return (
    <aside
      className={[
        "reader-sidebar",
        pinned ? "reader-sidebar--pinned" : "reader-sidebar--floating",
        shown ? "reader-sidebar--shown" : "reader-sidebar--hidden",
      ].join(" ")}
      id="reader-sidebar"
      aria-label={t("sidebar.label")}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div className="reader-sidebar__topbar">
        {view !== "main" ? (
          <IconButton
            className="reader-sidebar__control"
            label={t("sidebar.backToControls")}
            onClick={onCloseAppearance}
          >
            <ArrowLeftIcon aria-hidden="true" />
          </IconButton>
        ) : (
          <Link
            className="icon-button reader-sidebar__control"
            to={libraryCache.lastPage()}
            state={libraryReturn}
            aria-label={t("statistics.back")}
            title={t("statistics.back")}
          >
            <ArrowLeftIcon aria-hidden="true" />
          </Link>
        )}
        <span className="reader-sidebar__title visually-hidden">{panelTitle}</span>
        <div className="reader-sidebar__top-actions">
          <IconButton
            ref={appearanceRef}
            className={`reader-sidebar__control${appearanceOpen ? " reader-sidebar__control--active" : ""}`}
            label={t("sidebar.readerAppearance")}
            aria-pressed={appearanceOpen}
            onClick={onToggleAppearance}
          >
            <SunIcon aria-hidden="true" weight={appearanceOpen ? "fill" : "regular"} />
          </IconButton>
          {onTogglePin ? (
            <IconButton
              className={`reader-sidebar__control${pinned ? " reader-sidebar__control--active" : ""}`}
              label={t(pinned ? "sidebar.unpin" : "sidebar.pin")}
              aria-pressed={pinned}
              onClick={onTogglePin}
            >
              <PushPinIcon aria-hidden="true" weight={pinned ? "fill" : "regular"} />
            </IconButton>
          ) : null}
        </div>
      </div>
      {panelOpen ? null : (
        <>
          <BookCard identity={identity} />
          <div className="reader-sidebar__tools" role="group" aria-label={t("sidebar.tools")}>
            <ToolButton
              buttonRef={imagesRef}
              label={t("sidebar.images")}
              onClick={onOpenImages}
              icon={<ImagesIcon aria-hidden="true" />}
            />
            <ToolButton
              buttonRef={bookmarksRef}
              label={t("sidebar.bookmarks")}
              count={
                bookmarks.bookmarks.status === "ready" ? bookmarks.bookmarks.items.length : null
              }
              onClick={onOpenBookmarks}
              icon={<BookmarkSimpleIcon aria-hidden="true" />}
            />
            <ToolButton
              buttonRef={notesRef}
              label={t("sidebar.notes")}
              count={notes.notes.status === "ready" ? notes.notes.items.length : null}
              onClick={onOpenNotes}
              icon={<NotePencilIcon aria-hidden="true" />}
            />
            <ToolButton
              buttonRef={searchRef}
              label={t("sidebar.search")}
              onClick={onOpenSearch}
              icon={<MagnifyingGlassIcon aria-hidden="true" />}
            />
          </div>
        </>
      )}
      <div
        ref={contentRef}
        className={`reader-sidebar__content scroll-safe${view === "main" ? " reader-sidebar__content--contents" : ""}`}
      >
        {appearanceOpen ? (
          <ReaderAppearancePanel {...appearance} />
        ) : view === "bookmarks" ? (
          <ReaderBookmarksPanel key={book?.id ?? "empty"} {...bookmarks} />
        ) : view === "search" ? (
          <ReaderSearchPanel key={book?.id ?? "empty"} {...search} />
        ) : view === "images" ? (
          <ReaderImagesPanel key={book?.id ?? "empty"} {...images} />
        ) : view === "notes" ? (
          <ReaderNotesPanel key={book?.id ?? "empty"} {...notes} />
        ) : (
          <div className="reader-sidebar__section">
            <h3 id="reader-contents-heading">{t("sidebar.chapters")}</h3>
            {navigationError && (
              <p className="reader-sidebar__error" role="alert">
                {t("sidebar.entryFailed")}
              </p>
            )}
            {status === "loading" ? (
              <p>{t("sidebar.loadingContents")}</p>
            ) : contents.length ? (
              <nav aria-labelledby="reader-contents-heading" className="reader-contents">
                <ContentsList
                  entries={contents}
                  currentEntryId={currentEntryId}
                  readIds={readIds}
                  lastId={lastId}
                  navigationBusy={navigationBusy}
                  onSelectEntry={onSelectEntry}
                  depth={0}
                />
              </nav>
            ) : (
              <p>{status === "ready" ? t("sidebar.noContents") : t("sidebar.openBook")}</p>
            )}
          </div>
        )}
      </div>
      {!panelOpen && progress && progress.total ? (
        <ReadingProgress progress={progress} chapterLabel={chapterLabel ?? null} />
      ) : null}
    </aside>
  );
}

/** The open book: cover, title, author and its series (a group, never numbered) when it has one. */
function BookCard({ identity }: { identity: ReaderIdentity }) {
  const book = identity.status === "book" ? identity.book : null;
  const series = book?.series ?? null;
  const { t } = useI18n();
  return (
    <div className="reader-sidebar__identity">
      {identity.status === "book" && identity.cover ? (
        <img className="reader-sidebar__cover" src={identity.cover} alt="" />
      ) : (
        <div className="reader-sidebar__book-icon" aria-hidden="true">
          <BookOpenTextIcon weight="duotone" />
        </div>
      )}
      {/* The title, author and series stay selectable, so they can be copied to search for or
          share the book; a drag from anywhere in the block, its margin included, selects. */}
      <div
        className={
          book ? "reader-sidebar__book reader-sidebar__book--open" : "reader-sidebar__book"
        }
        onMouseDown={book ? freshSelection : undefined}
        onDragStart={book ? (event) => event.preventDefault() : undefined}
      >
        <h2>
          {book?.title ??
            t(
              book
                ? "library.untitled"
                : identity.status === "loading"
                  ? "readerStatus.finding"
                  : identity.status === "unknown"
                    ? "readerStatus.notFound"
                    : "readerStatus.noBook",
            )}
        </h2>
        <p>{book ? (book.author ?? t("libraryCard.unknownAuthor")) : t("sidebar.chooseBook")}</p>
        {series ? <p className="reader-sidebar__series">{series}</p> : null}
        {book && book.availability !== "available" ? (
          <p className="reader-sidebar__availability">
            {t(book.availability === "missing" ? "libraryCard.missing" : "libraryCard.unreadable")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A press in selected text starts a new selection, as a press anywhere else does, instead of
 * dragging the selected text away. Shift still extends it and a second click still picks a word.
 */
function freshSelection(event: MouseEvent) {
  if (event.button !== 0 || event.shiftKey || event.detail > 1) return;
  const selection = event.currentTarget.ownerDocument.getSelection();
  if (selection && !selection.isCollapsed) selection.removeAllRanges();
}

/**
 * Along the sidebar's bottom: the current chapter with how much of it is read, then the book's
 * position and a bar of how far the book is read.
 */
function ReadingProgress({
  progress,
  chapterLabel,
}: {
  progress: ReaderBookProgress;
  chapterLabel: string | null;
}) {
  const { total, chapter } = progress;
  const { t, number } = useI18n();
  const current = Math.min(progress.current, total);
  const percent = Math.floor((current / total) * 100);
  const chapterPercent = chapter.total
    ? Math.floor((Math.min(chapter.current, chapter.total) / chapter.total) * 100)
    : null;
  return (
    <div className="reader-sidebar__status">
      {chapterLabel || chapterPercent !== null ? (
        <div className="reader-sidebar__status-chapter">
          <strong>{chapterLabel ?? t("readerFooter.chapterPrefix")}</strong>
          {chapterPercent === null ? null : (
            <span
              className="reader-sidebar__chapter-percent"
              aria-label={t("sidebar.chapterRead", { percent: chapterPercent })}
            >
              {chapterPercent}%
            </span>
          )}
        </div>
      ) : null}
      <div className="reader-sidebar__progress">
        <small>
          {number(current)} / {number(total)}{" "}
          {t(progress.unit === "words" ? "readerFooter.wo" : "readerFooter.ch")} · {percent}%
        </small>
        <span
          className="reader-sidebar__progress-bar"
          role="progressbar"
          aria-label={t("readerFooter.bookProgress")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${(current / total) * 100}%` }} />
        </span>
      </div>
    </div>
  );
}

/** One of the tool bar's panels: its icon over its name. */
function ToolButton({
  buttonRef,
  label,
  count = null,
  icon,
  onClick,
}: {
  buttonRef: Ref<HTMLButtonElement>;
  label: string;
  count?: number | null;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="reader-sidebar__tool"
      aria-label={count === null ? label : `${label} (${count})`}
      onClick={onClick}
    >
      {icon}
      <span aria-hidden="true">{label}</span>
    </button>
  );
}

function ContentsList({
  entries,
  currentEntryId,
  readIds,
  lastId,
  navigationBusy,
  onSelectEntry,
  depth,
}: {
  entries: ReaderContentsEntry[];
  currentEntryId: string | null;
  readIds: ReadonlySet<string>;
  lastId: string | null;
  navigationBusy: boolean;
  onSelectEntry: (entryId: string) => void;
  depth: number;
}) {
  return (
    <ol className="reader-contents__list">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="reader-contents__item"
          data-progress={
            currentEntryId === entry.id ? "current" : readIds.has(entry.id) ? "read" : undefined
          }
          data-last={lastId === entry.id || undefined}
          style={{ "--contents-depth": Math.min(depth, 6) } as CSSProperties}
        >
          {entry.navigable ? (
            <button
              type="button"
              className="reader-contents__entry"
              aria-label={entry.label}
              aria-describedby={`contents-location-${entry.id}`}
              aria-current={currentEntryId === entry.id ? "location" : undefined}
              // aria-disabled rather than disabled keeps the chosen entry focused while
              // the jump runs, so a failed jump leaves focus where the reader left it.
              aria-disabled={navigationBusy || undefined}
              onClick={() => {
                if (!navigationBusy) onSelectEntry(entry.id);
              }}
            >
              <span className="reader-contents__copy">
                <span>{entry.label}</span>
                <small className="reader-contents__location" aria-hidden="true">
                  {contentsStart(entry)}
                </small>
                <span id={`contents-location-${entry.id}`} className="visually-hidden">
                  {contentsLocation(entry)}
                </span>
              </span>
            </button>
          ) : (
            <span className="reader-contents__group reader-contents__copy">
              <span>{entry.label}</span>
              <small className="reader-contents__location">{contentsStart(entry)}</small>
            </span>
          )}
          {entry.children.length > 0 && (
            <ContentsList
              entries={entry.children}
              currentEntryId={currentEntryId}
              readIds={readIds}
              lastId={lastId}
              navigationBusy={navigationBusy}
              onSelectEntry={onSelectEntry}
              depth={depth + 1}
            />
          )}
        </li>
      ))}
    </ol>
  );
}

/** Where an entry starts, short enough to sit beside its title: `5,250 Ch.`. */
function contentsStart(entry: ReaderContentsEntry): string {
  if (!entry.navigable || entry.location === null) return "—";
  if (!entry.location) return "…";
  const { current, unit } = entry.location;
  const { t, number } = i18n();
  return `${number(current)} ${t(unit === "characters" ? "readerFooter.ch" : "readerFooter.wo")}`;
}

function contentsLocation(entry: ReaderContentsEntry): string {
  const { t, number } = i18n();
  if (!entry.navigable || entry.location === null) return t("sidebar.locationUnavailable");
  if (!entry.location) return t("sidebar.countingLocation");
  const { current, total, unit } = entry.location;
  return `${number(current)} / ${number(total)} ${t(unit === "characters" ? "readerFooter.ch" : "readerFooter.wo")}`;
}

/** Every contents entry in reading order, each before its children. */
export function flattenContents(entries: ReaderContentsEntry[]): ReaderContentsEntry[] {
  return entries.flatMap((entry) => [entry, ...flattenContents(entry.children)]);
}

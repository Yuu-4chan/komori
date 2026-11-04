import {
  ArrowLeftIcon,
  BookmarkSimpleIcon,
  BookOpenIcon,
  CopyIcon,
  HighlighterIcon,
  ImageIcon,
  ListBulletsIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  TextAaIcon,
  TranslateIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";

import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Stepper } from "../components/ui/Stepper";
import { useAppearance } from "../features/appearance/AppearanceProvider";
import {
  readerFontSize,
  readerLineHeight,
  readerSideMargin,
  type ReaderViewMode,
  type ReaderWritingMode,
} from "../features/reader/presentation";
import {
  ReaderBookmarksPanel,
  type ReaderBookmarksPanelProps,
} from "../features/reader/ReaderBookmarksPanel";
import {
  ReaderImagesPanel,
  type ReaderImagesPanelProps,
} from "../features/reader/ReaderImagesPanel";
import { ReaderNotesPanel, type ReaderNotesPanelProps } from "../features/reader/ReaderNotesPanel";
import { ReaderReadingStatus } from "../features/reader/ReaderReadingStatus";
import {
  ReaderSearchPanel,
  type ReaderSearchPanelProps,
} from "../features/reader/ReaderSearchPanel";
import type { ReaderIdentity } from "../features/reader/readerIdentity";
import {
  isLightTheme,
  presetThemeLabel,
  readerPresetThemes,
  resolveReaderTheme,
} from "../features/reader/readerThemes";
import type {
  ReaderBookmarkLocator,
  ReaderBookmarkPlace,
  ReaderBookProgress,
  ReaderContentsEntry,
  ReaderPageTurnAvailability,
} from "../features/reader/renderer";
import type { useBookmarks } from "../features/reader/useBookmarks";
import type { SessionState } from "../features/reader/useReadingSession";
import { i18n, useI18n } from "../i18n/i18n";
import "./mobileReader.css";
import { MobileSheet } from "./MobileSheet";
import { ownBookSelection, showSystemBars, systemBarIcons, useBackCloser } from "./system";

/** The Reader's tools, as the PC's sidebar shows them. */
export interface MobileReaderTools {
  images: ReaderImagesPanelProps;
  search: ReaderSearchPanelProps;
  bookmarks: ReaderBookmarksPanelProps;
  notes: ReaderNotesPanelProps;
}

type Tool = keyof MobileReaderTools;

/** What the selection toolbar asks the Reader to do with the book's selected text. */
export type SelectionAction = "note" | "highlight" | "copy" | "lookUp";

export interface MobileReaderProps {
  identity: ReaderIdentity;
  /** The book is shown and laid out. */
  ready: boolean;
  turning: boolean;
  progress: ReaderBookProgress | null;
  pageTurns: ReaderPageTurnAvailability;
  contents: ReaderContentsEntry[];
  currentEntryId?: string | null;
  session: { readingMs: () => number; state: SessionState };
  bookmarks: ReturnType<typeof useBookmarks>;
  captureBookmark: () => Promise<ReaderBookmarkPlace | null>;
  tools: MobileReaderTools;
  /** Told of every selection change in the book's pages, with the page's document. */
  selectionRef: MutableRefObject<(document: Document) => void>;
  onSelectionAction: (action: SelectionAction, document: Document) => void;
  /** The image viewer over the Reader: whether it shows, its jumps to a page, and closing it. */
  image: { viewing: boolean; jumps: number; close: () => void };
  /** Receives every touch in the book's pages; the Reader hands it the book's documents. */
  touchRef: MutableRefObject<(event: TouchEvent) => void>;
  viewportRef: RefObject<HTMLElement | null>;
  onTurn: (direction: "advance" | "retreat") => void;
  /** Looks up the word at a tapped point of the screen; false when no word is there. */
  onLookUp: (x: number, y: number) => boolean;
  /** A finger is on a continuously displayed book, which the WebView scrolls: reading on. */
  onScroll: () => void;
  onGoToEntry: (id: string) => void;
  onGoToOffset: (offset: number, settled: (succeeded: boolean) => void) => void;
  onBack: () => void;
  onFeedback: (message: string) => void;
}

// A tap moves less than this, in CSS pixels, and lifts within `tapTime` milliseconds.
const tapSlop = 10;
const tapTime = 500;
// The left and right parts of the page that turn it, as a fraction of its width.
const sideZone = 0.3;
const swipeDistance = 40;

const viewModes: {
  value: ReaderViewMode;
  label: "appearancePanel.paginated" | "appearancePanel.continuous";
}[] = [
  { value: "paginated", label: "appearancePanel.paginated" },
  { value: "continuous", label: "appearancePanel.continuous" },
];
const writingModes: {
  value: ReaderWritingMode;
  label: "appearancePanel.horizontal" | "appearancePanel.vertical";
}[] = [
  { value: "horizontal", label: "appearancePanel.horizontal" },
  { value: "vertical", label: "appearancePanel.vertical" },
];

/**
 * The Reader by touch: the side parts of the page turn it, a swipe turns it in paginated view,
 * and the center, the clock or the footer show the controls over the book.
 */
export function MobileReader({
  identity,
  ready,
  turning,
  progress,
  pageTurns,
  contents,
  currentEntryId,
  session,
  bookmarks,
  captureBookmark,
  tools,
  selectionRef,
  onSelectionAction,
  image,
  touchRef,
  viewportRef,
  onTurn,
  onLookUp,
  onScroll,
  onGoToEntry,
  onGoToOffset,
  onBack,
  onFeedback,
}: MobileReaderProps) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [tool, setTool] = useState<Tool | null>(null);
  const [searchRequest, setSearchRequest] = useState<{ query: string }>();
  useBackCloser(shown, () => setShown(false));
  const openTool = (next: Tool) => {
    setChaptersOpen(false);
    setSearchRequest(undefined);
    setTool(next);
  };
  // A jump from a tool returns to the book.
  const backToBook = () => {
    setTool(null);
    setShown(false);
  };

  // The bars show with the controls; reading, the book has the whole screen.
  useEffect(() => showSystemBars(shown), [shown]);
  useEffect(() => () => showSystemBars(true), []);
  const { readerTheme, readerCustomThemes } = useAppearance();
  const lightPage = isLightTheme(resolveReaderTheme(readerTheme, readerCustomThemes));
  useEffect(() => systemBarIcons(lightPage), [lightPage]);

  const latest = useRef({ ready, pageTurns, onTurn, onLookUp, onScroll });
  latest.current = { ready, pageTurns, onTurn, onLookUp, onScroll };
  useEffect(() => {
    let start: { x: number; y: number; at: number } | null = null;
    const touched = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!touch) return;
      const point = screenPoint(event, touch);
      if (event.type === "touchstart") {
        // A long press here selects the book's text, which shows Komori's toolbar.
        ownBookSelection((event.target as Node | null)?.ownerDocument !== document);
        start = event.touches.length === 1 ? { ...point, at: event.timeStamp } : null;
        if (latest.current.pageTurns.scrollAxis) latest.current.onScroll();
        return;
      }
      const began = start;
      start = null;
      const { ready, pageTurns, onTurn, onLookUp } = latest.current;
      if (event.type !== "touchend" || !began || event.touches.length || !ready) return;
      const dx = point.x - began.x;
      const dy = point.y - began.y;
      // Page progression: a right-to-left book advances to the left.
      const leftAdvances = pageTurns.forwardArrow === "ArrowLeft";
      if (Math.hypot(dx, dy) < tapSlop) {
        const target = event.target as Element | null;
        const owner = (target as Node | null)?.ownerDocument ?? document;
        if (event.timeStamp - began.at > tapTime || target?.closest?.("a[href]")) return;
        if (owner.getSelection()?.isCollapsed === false) return;
        // The tap's own click would otherwise land on the controls it shows, and hide them.
        if (event.cancelable) event.preventDefault();
        // A tap on a word looks it up; one on blank space turns the page or shows the controls.
        if (onLookUp(point.x, point.y)) return;
        const across = point.x / window.innerWidth;
        if (across < sideZone) onTurn(leftAdvances ? "advance" : "retreat");
        else if (across > 1 - sideZone) onTurn(leftAdvances ? "retreat" : "advance");
        else setShown(true);
        return;
      }
      // A continuous book scrolls under the finger instead.
      if (pageTurns.scrollAxis || Math.abs(dx) < swipeDistance || Math.abs(dx) < Math.abs(dy) * 1.5)
        return;
      onTurn(leftAdvances === dx > 0 ? "advance" : "retreat");
    };
    touchRef.current = touched;
    const viewport = viewportRef.current;
    const types = ["touchstart", "touchend", "touchcancel"] as const;
    for (const type of types)
      viewport?.addEventListener(type, touched, { passive: type === "touchstart" });
    return () => {
      touchRef.current = () => {};
      for (const type of types) viewport?.removeEventListener(type, touched);
    };
  }, [touchRef, viewportRef]);

  // A long press anywhere but the book keeps Android's own toolbar.
  useEffect(() => {
    const outside = () => ownBookSelection(false);
    document.addEventListener("touchstart", outside, { capture: true, passive: true });
    return () => {
      document.removeEventListener("touchstart", outside, true);
      ownBookSelection(false);
    };
  }, []);

  // The book's selected text, which the toolbar beside it acts on.
  const [selected, setSelected] = useState<SelectedText | null>(null);
  useEffect(() => {
    let frame = 0;
    selectionRef.current = (changed) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setSelected((current) => {
          const next = selectedText(changed);
          if (next) return next;
          return current && current.document !== changed ? current : null;
        }),
      );
    };
    return () => {
      cancelAnimationFrame(frame);
      selectionRef.current = () => {};
    };
  }, [selectionRef]);
  const act = (action: SelectionAction | "search") => {
    if (!selected) return;
    setSelected(null);
    if (action !== "search") {
      onSelectionAction(action, selected.document);
      return;
    }
    selected.document.getSelection()?.removeAllRanges();
    setChaptersOpen(false);
    setSearchRequest({ query: selected.text });
    setTool("search");
  };

  // The viewer's jump to an image's page returns to the book; closing it returns to the images.
  const imageJumps = useRef(image.jumps);
  useEffect(() => {
    if (image.jumps === imageJumps.current) return;
    imageJumps.current = image.jumps;
    setTool(null);
    setShown(false);
  }, [image.jumps]);
  useBackCloser(image.viewing, image.close);

  // The shown page's place, to tell whether it is bookmarked.
  const [place, setPlace] = useState<ReaderBookmarkPlace | null>(null);
  const capture = useRef(captureBookmark);
  capture.current = captureBookmark;
  const shownAt = progress?.current;
  useEffect(() => {
    if (!shown || !ready || turning) return;
    let current = true;
    void capture.current().then(
      (next) => {
        if (current) setPlace(next);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [shown, ready, turning, shownAt]);
  const bookmark = place
    ? bookmarks.items.find((item) => sameLocator(item.locator, place.locator))
    : undefined;
  const toggleBookmark = () => {
    if (bookmark)
      void bookmarks.remove(bookmark.id).then((removed) => {
        if (removed) onFeedback(i18n().t("bookmarks.removed"));
      });
    else if (place) void bookmarks.create(() => Promise.resolve(place), "", onFeedback);
  };

  // The slider shows where it is dragged until the book settles there.
  const [dragged, setDragged] = useState<number | null>(null);
  const total = progress?.total ?? 0;
  const entries = flatEntries(contents);
  const at = Math.min(dragged ?? progress?.current ?? 0, total);
  const chapter =
    dragged === null
      ? entries.find((entry) => entry.id === (progress?.chapter.entryId ?? currentEntryId))
      : chapterAt(entries, at);
  const chapterPercent =
    dragged === null
      ? progress?.chapter.total
        ? percent(progress.chapter.current, progress.chapter.total)
        : null
      : chapter?.location
        ? percent(
            at - chapter.location.current,
            chapterEnd(entries, chapter, total) - chapter.location.current,
          )
        : null;
  const commit = () => {
    if (dragged === null) return;
    onGoToOffset(dragged, () => setDragged(null));
  };
  const title = identity.status === "book" ? (identity.book.title ?? t("library.untitled")) : "";
  const author = identity.status === "book" ? (identity.book.author ?? undefined) : undefined;

  return (
    <>
      {ready && (
        <button
          aria-label={t("mobileReader.showControls")}
          className="mobile-reader__status"
          onClick={() => setShown(true)}
          type="button"
        >
          <ReaderReadingStatus
            clock
            readingTime
            readingMs={session.readingMs}
            session={session.state}
          />
        </button>
      )}
      {ready && progress?.total ? (
        <button
          aria-label={t("mobileReader.showControls")}
          className="mobile-reader__footer"
          onClick={() => setShown(true)}
          type="button"
        >
          {/* One run of text, so the flex button keeps the spaces around the dot. */}
          <span>
            <BookPosition current={progress.current} total={progress.total} unit={progress.unit} />
            {" · "}
            {percent(progress.current, progress.total)}%
          </span>
        </button>
      ) : null}
      {shown && (
        <div className="mobile-reader-controls">
          <button
            aria-label={t("mobileReader.hideControls")}
            className="mobile-reader-controls__backdrop"
            onClick={() => setShown(false)}
            type="button"
          />
          <header className="mobile-reader-controls__header">
            <button
              aria-label={t("statistics.back")}
              className="mobile-reader-controls__button"
              onClick={onBack}
              type="button"
            >
              <ArrowLeftIcon aria-hidden="true" size={20} />
            </button>
            <div className="mobile-reader-controls__title">
              <span lang={bookLanguage(identity)}>{title}</span>
              {author ? <small lang={bookLanguage(identity)}>{author}</small> : null}
            </div>
            <button
              aria-label={t(bookmark ? "mobileReader.removeBookmark" : "mobileReader.bookmark")}
              aria-pressed={!!bookmark}
              className="mobile-reader-controls__button"
              disabled={!place || bookmarks.status !== "ready" || bookmarks.busy}
              onClick={toggleBookmark}
              type="button"
            >
              <BookmarkSimpleIcon
                aria-hidden="true"
                size={20}
                weight={bookmark ? "fill" : "regular"}
              />
            </button>
            <button
              aria-label={t("sidebar.appearance")}
              className="mobile-reader-controls__button"
              onClick={() => {
                setShown(false);
                setAppearanceOpen(true);
              }}
              type="button"
            >
              <TextAaIcon aria-hidden="true" size={20} />
            </button>
          </header>
          <section aria-label={t("mobileReader.tools")} className="mobile-reader-controls__panel">
            <div className="mobile-reader-controls__chapter">
              <span lang={bookLanguage(identity)}>{chapter?.label ?? title}</span>
              {chapterPercent === null ? null : (
                <span className="mobile-reader-chip">{chapterPercent}%</span>
              )}
            </div>
            <input
              aria-label={t("mobileReader.position")}
              className="mobile-reader-controls__slider"
              disabled={!total || turning}
              max={total}
              min={0}
              onChange={(event) => setDragged(Number(event.currentTarget.value))}
              onKeyUp={commit}
              onPointerUp={commit}
              step={1}
              type="range"
              value={at}
            />
            {total ? (
              <div className="mobile-reader-controls__counts">
                <BookPosition current={at} total={total} unit={progress?.unit ?? "characters"} />
                <span>{percent(at, total)}%</span>
              </div>
            ) : null}
            <div className="mobile-reader-controls__tools">
              <button
                className="mobile-reader-tool"
                onClick={() => setChaptersOpen(true)}
                type="button"
              >
                <ListBulletsIcon aria-hidden="true" size={20} />
                <ToolLabel>{t("sidebar.chapters")}</ToolLabel>
              </button>
              <ToolButtons onOpen={openTool} />
            </div>
          </section>
        </div>
      )}
      <ChaptersSheet
        author={author}
        current={chapter?.id}
        entries={entries}
        identity={identity}
        onClose={() => setChaptersOpen(false)}
        onOpenTool={openTool}
        onPick={(id) => {
          setChaptersOpen(false);
          setShown(false);
          onGoToEntry(id);
        }}
        open={chaptersOpen}
        progress={progress}
        title={title}
      />
      <AppearanceSheet onClose={() => setAppearanceOpen(false)} open={appearanceOpen} />
      {selected && ready && !turning && !shown && !tool && !chaptersOpen && !appearanceOpen ? (
        <SelectionToolbar onAct={act} rect={selected.rect} />
      ) : null}
      <ToolSheet
        hidden={image.viewing}
        onClose={() => setTool(null)}
        open={tool === "images"}
        title={t("sidebar.images")}
      >
        <ReaderImagesPanel {...tools.images} />
      </ToolSheet>
      <ToolSheet
        onClose={() => setTool(null)}
        open={tool === "bookmarks"}
        title={t("sidebar.bookmarks")}
      >
        <ReaderBookmarksPanel
          {...tools.bookmarks}
          onJump={(bookmark, settled) =>
            tools.bookmarks.onJump(bookmark, (success) => {
              settled(success);
              if (success) backToBook();
            })
          }
        />
      </ToolSheet>
      <ToolSheet onClose={() => setTool(null)} open={tool === "notes"} title={t("sidebar.notes")}>
        <ReaderNotesPanel
          {...tools.notes}
          onJump={(note, settled) =>
            tools.notes.onJump(note, (success) => {
              settled(success);
              if (success) backToBook();
            })
          }
        />
      </ToolSheet>
      <ToolSheet onClose={() => setTool(null)} open={tool === "search"} title={t("sidebar.search")}>
        <ReaderSearchPanel
          {...tools.search}
          onJump={(id, signal, settled) =>
            tools.search.onJump(id, signal, (success) => {
              settled(success);
              if (success) backToBook();
            })
          }
          searchFor={searchRequest}
        />
      </ToolSheet>
    </>
  );
}

function ChaptersSheet({
  open,
  onClose,
  onOpenTool,
  onPick,
  identity,
  title,
  author,
  entries,
  current,
  progress,
}: {
  open: boolean;
  onClose: () => void;
  onOpenTool: (tool: Tool) => void;
  onPick: (id: string) => void;
  identity: ReaderIdentity;
  title: string;
  author?: string;
  entries: FlatEntry[];
  current?: string;
  progress: ReaderBookProgress | null;
}) {
  const { t, number } = useI18n();
  const currentRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) currentRef.current?.scrollIntoView?.({ block: "center" });
  }, [open]);
  const index = entries.findIndex((entry) => entry.id === current);
  const shown = index >= 0 ? entries[index] : undefined;
  const language = bookLanguage(identity);
  return (
    <MobileSheet
      className="mobile-sheet--tall mobile-chapters"
      label={t("sidebar.chapters")}
      onClose={onClose}
      open={open}
    >
      <div className="mobile-chapters__book">
        <div className="library-book__cover mobile-chapters__cover">
          {identity.status === "book" && identity.cover ? (
            <img alt="" decoding="async" draggable={false} src={identity.cover} />
          ) : (
            <div className="library-book__cover-fallback">
              <BookOpenIcon aria-hidden="true" weight="duotone" />
            </div>
          )}
        </div>
        <div className="mobile-chapters__title">
          <strong lang={language}>{title}</strong>
          {author ? <span lang={language}>{author}</span> : null}
        </div>
        <button
          aria-label={t("common.close")}
          className="mobile-round-button mobile-sheet__close"
          onClick={onClose}
          type="button"
        >
          <XIcon aria-hidden="true" size={18} />
        </button>
      </div>
      <div className="mobile-chapters__tools">
        <ToolButtons onOpen={onOpenTool} />
      </div>
      <h2 className="mobile-chapters__heading">{t("sidebar.chapters")}</h2>
      <ol className="mobile-chapters__list">
        {entries.map((entry, position) => {
          const state = position < index ? "past" : position === index ? "current" : "future";
          return (
            <li key={entry.id}>
              <button
                aria-current={state === "current" ? "location" : undefined}
                className={`mobile-chapter mobile-chapter--${state}`}
                disabled={!entry.navigable}
                onClick={() => onPick(entry.id)}
                ref={state === "current" ? currentRef : undefined}
                style={{ paddingInlineStart: `${entry.depth * 0.875}rem` }}
                type="button"
              >
                <span aria-hidden="true" className="mobile-chapter__dot" />
                <span className="mobile-chapter__label" lang={language}>
                  {entry.label}
                </span>
                {entry.location ? (
                  <span className="mobile-chapter__at">
                    {number(entry.location.current)} {unitShort(entry.location.unit)}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
      {progress?.total ? (
        <div className="mobile-chapters__now">
          <div className="mobile-reader-controls__chapter">
            <span lang={language}>{shown?.label ?? title}</span>
            {progress.chapter.total ? (
              <span className="mobile-reader-chip">
                {percent(progress.chapter.current, progress.chapter.total)}%
              </span>
            ) : null}
          </div>
          <div className="mobile-chapters__progress">
            <span>
              <BookPosition
                current={progress.current}
                total={progress.total}
                unit={progress.unit}
              />
              {" · "}
              {percent(progress.current, progress.total)}%
            </span>
            <span aria-hidden="true" className="mobile-progress__bar">
              <span
                style={{
                  width: `${(Math.min(progress.current, progress.total) / progress.total) * 100}%`,
                }}
              />
            </span>
          </div>
        </div>
      ) : null}
    </MobileSheet>
  );
}

const toolButtons: {
  tool: Tool;
  label: "sidebar.images" | "sidebar.bookmarks" | "sidebar.notes" | "sidebar.search";
  icon: typeof ImageIcon;
}[] = [
  { tool: "images", label: "sidebar.images", icon: ImageIcon },
  { tool: "bookmarks", label: "sidebar.bookmarks", icon: BookmarkSimpleIcon },
  { tool: "notes", label: "sidebar.notes", icon: NotePencilIcon },
  { tool: "search", label: "sidebar.search", icon: MagnifyingGlassIcon },
];

/** Images, Bookmarks, Notes and Search, as the Reader controls and Chapters show them. */
function ToolButtons({ onOpen }: { onOpen: (tool: Tool) => void }) {
  const { t } = useI18n();
  return toolButtons.map(({ tool, label, icon: Icon }) => (
    <button className="mobile-reader-tool" key={tool} onClick={() => onOpen(tool)} type="button">
      <Icon aria-hidden="true" size={20} />
      <ToolLabel>{t(label)}</ToolLabel>
    </button>
  ));
}

/**
 * A tool's name on one line: a word wider than its tile, as ブックマーク is at 360 px, is
 * drawn smaller.
 */
function ToolLabel({ children }: { children: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const label = ref.current;
    const tile = label?.parentElement;
    if (!label || !tile) return;
    label.style.fontSize = "";
    const padding = getComputedStyle(tile);
    const room =
      tile.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight);
    const width = label.scrollWidth;
    if (!(room > 0 && width > room)) return;
    const size = parseFloat(getComputedStyle(label).fontSize);
    label.style.fontSize = `${Math.max(minimumToolLabel, Math.floor(((size * room) / width) * 10) / 10)}px`;
  }, [children]);
  return (
    <span className="mobile-reader-tool__label" ref={ref}>
      {children}
    </span>
  );
}

/** The smallest a tool's name is drawn, in CSS pixels; a longer one ends in an ellipsis. */
const minimumToolLabel = 9;

/** A tool of the PC's sidebar in a tall sheet, under its title and Close. */
function ToolSheet({
  open,
  hidden,
  onClose,
  title,
  children,
}: {
  open: boolean;
  hidden?: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <MobileSheet
      className="mobile-sheet--tall mobile-reader-tool-sheet"
      hidden={hidden}
      label={title}
      onClose={onClose}
      open={open}
    >
      <div className="mobile-reader-appearance__heading">
        <h2>{title}</h2>
        <button
          aria-label={t("common.close")}
          className="mobile-round-button mobile-sheet__close"
          onClick={onClose}
          type="button"
        >
          <XIcon aria-hidden="true" size={18} />
        </button>
      </div>
      {children}
    </MobileSheet>
  );
}

interface SelectedText {
  document: Document;
  text: string;
  /** Where the selection shows on the screen. */
  rect: { top: number; right: number; bottom: number; left: number };
}

/** A book page's selected text and where it shows, or null when nothing is selected. */
function selectedText(document: Document): SelectedText | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const box = selection.getRangeAt(0).getBoundingClientRect();
  const frame = document.defaultView?.frameElement?.getBoundingClientRect();
  const x = frame?.left ?? 0;
  const y = frame?.top ?? 0;
  return {
    document,
    text,
    rect: { top: box.top + y, right: box.right + x, bottom: box.bottom + y, left: box.left + x },
  };
}

// The toolbar's size, as mobileReader.css draws it, and its distance from the selection and
// the screen's edges. Below the selection it clears Android's handles.
const toolbarWidth = 248;
const toolbarHeight = 56;
const toolbarGap = 12;
const handleRoom = 32;
const screenGutter = 8;

/** Note, Highlight, Copy, Look up and Search beside the book's selection, above it where there is room. */
function SelectionToolbar({
  rect,
  onAct,
}: {
  rect: SelectedText["rect"];
  onAct: (action: SelectionAction | "search") => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(onAct);
  latest.current = onAct;
  // A touch on the toolbar must not clear the selection it acts on, as a tap would.
  useEffect(() => {
    const toolbar = ref.current;
    if (!toolbar) return;
    const press = (event: TouchEvent) => event.preventDefault();
    const release = (event: TouchEvent) => {
      event.preventDefault();
      const button = (event.target as Element | null)?.closest?.<HTMLButtonElement>("button");
      const action = button?.dataset.action as SelectionAction | "search" | undefined;
      if (action) latest.current(action);
    };
    toolbar.addEventListener("touchstart", press, { passive: false });
    toolbar.addEventListener("touchend", release, { passive: false });
    return () => {
      toolbar.removeEventListener("touchstart", press);
      toolbar.removeEventListener("touchend", release);
    };
  }, []);
  const above = rect.top - toolbarGap - toolbarHeight;
  const below = rect.bottom + handleRoom;
  const top =
    above >= screenGutter
      ? above
      : below + toolbarHeight <= window.innerHeight - screenGutter
        ? below
        : Math.max(screenGutter, (window.innerHeight - toolbarHeight) / 2);
  const left = Math.min(
    Math.max(screenGutter, (rect.left + rect.right) / 2 - toolbarWidth / 2),
    window.innerWidth - toolbarWidth - screenGutter,
  );
  const actions = [
    { action: "note", label: t("textMenu.note"), icon: NotePencilIcon },
    { action: "highlight", label: t("textMenu.highlight"), icon: HighlighterIcon },
    { action: "copy", label: t("textMenu.copy"), icon: CopyIcon },
    { action: "lookUp", label: t("textMenu.lookUp"), icon: TranslateIcon },
    { action: "search", label: t("sidebar.search"), icon: MagnifyingGlassIcon },
  ] as const;
  return (
    <div
      aria-label={t("textMenu.label")}
      className="mobile-selection-toolbar"
      ref={ref}
      role="toolbar"
      style={{ top, left }}
    >
      {actions.map(({ action, label, icon: Icon }) => (
        <button
          aria-label={label}
          data-action={action}
          key={action}
          onClick={() => onAct(action)}
          type="button"
        >
          <Icon aria-hidden="true" size={22} />
        </button>
      ))}
    </div>
  );
}

function AppearanceSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const appearance = useAppearance();
  return (
    <MobileSheet
      className="mobile-reader-appearance"
      label={t("sidebar.appearance")}
      onClose={onClose}
      open={open}
    >
      <div className="mobile-reader-appearance__heading">
        <h2>{t("sidebar.appearance")}</h2>
        <button
          aria-label={t("common.close")}
          className="mobile-round-button mobile-sheet__close"
          onClick={onClose}
          type="button"
        >
          <XIcon aria-hidden="true" size={18} />
        </button>
      </div>
      <div className="mobile-reader-themes" role="group" aria-label={t("readerTheme.title")}>
        {[...readerPresetThemes, ...appearance.readerCustomThemes].map((theme) => (
          <button
            aria-pressed={theme.id === appearance.readerTheme}
            className="mobile-reader-theme"
            key={theme.id}
            onClick={() => appearance.setReaderTheme(theme.id)}
            type="button"
          >
            <span
              aria-hidden="true"
              className="mobile-reader-theme__preview"
              style={{ background: theme.background, color: theme.text }}
            >
              あ
            </span>
            <small>{"label" in theme ? presetThemeLabel(theme) : theme.name}</small>
          </button>
        ))}
      </div>
      <div className="mobile-group mobile-reader-appearance__rows">
        <Stepper
          label={t("appearancePanel.fontSize")}
          max={readerFontSize.max}
          min={readerFontSize.min}
          onChange={appearance.setReaderFontSize}
          step={readerFontSize.step}
          unit={t("unit.px")}
          value={appearance.readerFontSize}
        />
        <Stepper
          format={(value) => value.toFixed(2)}
          label={t("appearancePanel.lineHeight")}
          max={readerLineHeight.max}
          min={readerLineHeight.min}
          onChange={appearance.setReaderLineHeight}
          step={readerLineHeight.step}
          value={appearance.readerLineHeight}
        />
        <Stepper
          label={t("appearancePanel.pageMargin")}
          max={readerSideMargin.max}
          min={readerSideMargin.min}
          onChange={appearance.setReaderPageMargin}
          step={readerSideMargin.step}
          unit={t("unit.px")}
          value={appearance.readerPageMargin}
        />
      </div>
      <SegmentedControl
        label={t("appearancePanel.writingMode")}
        onChange={appearance.setReaderWritingMode}
        options={writingModes.map((mode) => ({ value: mode.value, label: t(mode.label) }))}
        value={appearance.readerWritingMode}
      />
      <SegmentedControl
        label={t("appearancePanel.viewMode")}
        onChange={appearance.setReaderViewMode}
        options={viewModes.map((mode) => ({ value: mode.value, label: t(mode.label) }))}
        value={appearance.readerViewMode}
      />
    </MobileSheet>
  );
}

function BookPosition({
  current,
  total,
  unit,
}: {
  current: number;
  total: number;
  unit: ReaderBookProgress["unit"];
}) {
  const { number } = useI18n();
  return (
    <span>
      {number(Math.min(current, total))} / {number(total)} {unitShort(unit)}
    </span>
  );
}

function unitShort(unit: ReaderBookProgress["unit"]): string {
  return i18n().t(unit === "words" ? "readerFooter.wo" : "readerFooter.ch");
}

const percent = (current: number, total: number) =>
  total > 0 ? Math.floor((Math.min(Math.max(current, 0), total) / total) * 100) : 0;

interface FlatEntry extends ReaderContentsEntry {
  depth: number;
}

function flatEntries(entries: ReaderContentsEntry[], depth = 0): FlatEntry[] {
  return entries.flatMap((entry) => [
    { ...entry, depth },
    ...flatEntries(entry.children, depth + 1),
  ]);
}

/** The last entry starting at or before a book offset. */
function chapterAt(entries: FlatEntry[], offset: number): FlatEntry | undefined {
  let found: FlatEntry | undefined;
  for (const entry of entries) {
    const at = entry.location?.current;
    if (at !== undefined && at <= offset && at >= (found?.location?.current ?? 0)) found = entry;
  }
  return found;
}

/** Where the next entry after `entry` starts, or the book's end. */
function chapterEnd(entries: FlatEntry[], entry: FlatEntry, total: number): number {
  const start = entry.location?.current ?? 0;
  let end = total;
  for (const other of entries) {
    const at = other.location?.current;
    if (at !== undefined && at > start && at < end) end = at;
  }
  return end;
}

// The same place as the bookmarks store keeps it, its progress rounded to nine decimals.
function sameLocator(a: ReaderBookmarkLocator, b: ReaderBookmarkLocator): boolean {
  const rounded = (progress: number) => Math.round(progress * 1e9) / 1e9;
  return (
    a.spineIndex === b.spineIndex &&
    a.sectionKey === b.sectionKey &&
    a.contentKey === b.contentKey &&
    rounded(a.progress) === rounded(b.progress)
  );
}

function bookLanguage(identity: ReaderIdentity): string | undefined {
  return identity.status === "book" ? (identity.book.language ?? undefined) : undefined;
}

/** A touch's place on the screen; a touch in the book's page reports it within the page. */
function screenPoint(event: TouchEvent, touch: Touch): { x: number; y: number } {
  const target = event.target as Node | null;
  const owner = target?.ownerDocument ?? (target as Document | null);
  const frame = owner?.defaultView?.frameElement;
  const offset = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
  return { x: touch.clientX + offset.left, y: touch.clientY + offset.top };
}

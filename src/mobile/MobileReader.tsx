import {
  ArrowLeftIcon,
  BookmarkSimpleIcon,
  BookOpenIcon,
  CopyIcon,
  HighlighterIcon,
  ImageIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PlusIcon,
  TextAaIcon,
  TranslateIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";

import { ToggleSetting } from "../components/ui/ToggleSetting";
import { useAppearance } from "../features/appearance/AppearanceProvider";
import {
  ReaderAppearancePanel,
  type ReaderAppearancePanelProps,
} from "../features/reader/ReaderAppearancePanel";
import {
  ReaderBookmarksPanel,
  type ReaderBookmarksPanelProps,
} from "../features/reader/ReaderBookmarksPanel";
import {
  ReaderImagesPanel,
  type ReaderImagesPanelProps,
} from "../features/reader/ReaderImagesPanel";
import { noteAtPoint } from "../features/reader/noteHighlights";
import { ReaderNotesPanel, type ReaderNotesPanelProps } from "../features/reader/ReaderNotesPanel";
import { ReaderReadingStatus } from "../features/reader/ReaderReadingStatus";
import {
  ReaderSearchPanel,
  type ReaderSearchPanelProps,
} from "../features/reader/ReaderSearchPanel";
import type { ReaderIdentity } from "../features/reader/readerIdentity";
import { ReaderCustomThemeEditor } from "../features/reader/ReaderThemeSection";
import {
  isLightTheme,
  presetThemeLabel,
  readerCustomThemeLimit,
  readerPresetThemes,
  resolveReaderTheme,
} from "../features/reader/readerThemes";
import type {
  ReaderBookmarkLocator,
  ReaderBookmarkPlace,
  ReaderBookProgress,
  ReaderContentsEntry,
  ReaderLocator,
  ReaderPageTurnAvailability,
} from "../features/reader/renderer";
import type { useBookmarks } from "../features/reader/useBookmarks";
import type { SessionState } from "../features/reader/useReadingSession";
import { formatReadingSpeed, type ReadingSpeed } from "../features/statistics/readingSession";
import { i18n, useI18n } from "../i18n/i18n";
import { ContinueFromDialog, useReaderSync } from "./ContinueFrom";
import "./mobileReader.css";
import { MobileSheet } from "./MobileSheet";
import {
  onVolumeKey,
  ownBookSelection,
  showSystemBars,
  systemBarIcons,
  useBackCloser,
} from "./system";

/** The Reader's tools, as the PC's sidebar shows them. */
export interface MobileReaderTools {
  images: ReaderImagesPanelProps;
  search: ReaderSearchPanelProps;
  bookmarks: ReaderBookmarksPanelProps;
  notes: ReaderNotesPanelProps;
}

type Tool = keyof MobileReaderTools;

/** What the selection toolbar asks the Reader to do with the book's selected text. */
export type SelectionAction = "note" | "highlight" | "copy" | "lookUp" | "delete";

export interface MobileReaderProps {
  identity: ReaderIdentity;
  /** The PC's Appearance panel, shown in the Appearance sheet for touch. */
  appearance: ReaderAppearancePanelProps;
  /** The book is shown and laid out. */
  ready: boolean;
  turning: boolean;
  progress: ReaderBookProgress | null;
  pageTurns: ReaderPageTurnAvailability;
  contents: ReaderContentsEntry[];
  currentEntryId?: string | null;
  session: { readingMs: () => number; state: SessionState };
  /** The session's reading speed when the footer shows it and a minute was read. */
  speed: ReadingSpeed | null;
  bookmarks: ReturnType<typeof useBookmarks>;
  captureBookmark: () => Promise<ReaderBookmarkPlace | null>;
  tools: MobileReaderTools;
  /** Told of every selection change in the book's pages, with the page's document. */
  selectionRef: MutableRefObject<(document: Document) => void>;
  /** `note` is the saved passage under the selection, which `delete` removes. */
  onSelectionAction: (action: SelectionAction, document: Document, note?: string) => void;
  /** The image viewer over the Reader: whether it shows, its jumps to a page, and closing it. */
  image: { viewing: boolean; jumps: number; close: () => void };
  /** Receives every touch in the book's pages; the Reader hands it the book's documents. */
  touchRef: MutableRefObject<(event: TouchEvent) => void>;
  viewportRef: RefObject<HTMLElement | null>;
  onTurn: (direction: "advance" | "retreat") => void;
  /** Looks up the word at a tapped point of the screen; false when no word is there. */
  onLookUp: (x: number, y: number) => boolean;
  /**
   * The lookup over the book: whether one shows, when a press last closed it (on the
   * `performance.now()` clock), and Back, which closes the deepest.
   */
  lookup: { open: boolean; closedAt: () => number; back: () => void };
  /** A finger is on a continuously displayed book, which the WebView scrolls: reading on. */
  onScroll: () => void;
  /** Whether a chapter shown alone is at its edge, where reading on turns the chapter. */
  onChapterEdge: (direction: "advance" | "retreat") => boolean;
  /**
   * In VN view, shows the rest of the group's text, or reads on once it all shows when
   * `advance`; false outside VN view or with nothing to do.
   */
  onReadOn: (advance: boolean) => boolean;
  /** Whether a point is on the group VN view shows, where a tap reads on. */
  onVnGroupAt?: (x: number, y: number) => boolean;
  onGoToEntry: (id: string) => void;
  onGoToOffset: (offset: number, settled: (succeeded: boolean) => void) => void;
  /** Shows a saved reading position, such as the PC's. */
  onGoToPosition: (locator: ReaderLocator, settled: (succeeded: boolean) => void) => void;
  onBack: () => void;
  onFeedback: (message: string) => void;
}

// A tap moves less than this, in CSS pixels, and lifts within `tapTime` milliseconds.
const tapSlop = 10;
const tapTime = 500;
// The left and right parts of the page that turn it, as a fraction of its width.
const sideZone = 0.2;
const swipeDistance = 40;
// A press closes the lookup just before its touch starts: within this many milliseconds.
const closingPress = 300;

/**
 * The Reader by touch: the side parts of the page turn it, a swipe turns it in paginated view,
 * and the center, the clock or the footer show the controls over the book.
 */
export function MobileReader({
  identity,
  appearance,
  ready,
  turning,
  progress,
  pageTurns,
  contents,
  currentEntryId,
  session,
  speed,
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
  lookup,
  onScroll,
  onChapterEdge,
  onReadOn,
  onVnGroupAt,
  onGoToEntry,
  onGoToOffset,
  onGoToPosition,
  onBack,
  onFeedback,
}: MobileReaderProps) {
  const { t, number } = useI18n();
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
  const {
    readerTheme,
    readerCustomThemes,
    readerTapLookup,
    readerTouchPageTurns,
    readerVolumePageTurns,
    readerViewMode,
    readerShowReadingPosition,
    readerShowPercentage,
    readerShowChapterPosition,
    readerShowChapterPercentage,
    readerShowClock,
    readerShowReadingTime,
  } = useAppearance();
  // The footer's parts, as the PC's footer chooses them, in its order.
  const chapterProgress = progress?.chapter?.total ? progress.chapter : null;
  // Each part with its widest form (the book's total for each number), so whether the pill
  // needs a second line changes only with the settings, the book or the screen, never while
  // reading.
  const position = (total: number) =>
    `${number(total)} / ${number(total)} ${unitShort(progress?.unit ?? "characters")}`;
  type FooterPart = { node: ReactNode; widest: string; book: boolean };
  const parts: FooterPart[] = progress?.total
    ? (
        [
          readerShowReadingPosition && {
            node: (
              <BookPosition
                current={progress.current}
                total={progress.total}
                unit={progress.unit}
              />
            ),
            widest: position(progress.total),
            book: true,
          },
          readerShowPercentage && {
            node: `${percent(progress.current, progress.total)}%`,
            widest: "100%",
            book: true,
          },
          chapterProgress &&
            readerShowChapterPosition && {
              node: (
                <BookPosition
                  current={chapterProgress.current}
                  total={chapterProgress.total}
                  unit={progress.unit}
                />
              ),
              // A chapter is never longer than its book, so its widest is the book's.
              widest: position(progress.total),
              book: false,
            },
          chapterProgress &&
            readerShowChapterPercentage && {
              node: `${t("readerFooter.chapterPrefix")} ${percent(chapterProgress.current, chapterProgress.total)}%`,
              widest: `${t("readerFooter.chapterPrefix")} 100%`,
              book: false,
            },
          speed && {
            node: formatReadingSpeed(speed),
            widest: formatReadingSpeed({ ...speed, perHour: 99_999 }),
            book: false,
          },
        ] as (FooterPart | false | null | undefined)[]
      ).filter((part): part is FooterPart => !!part)
    : [];
  const footerWidest = parts.map((part) => part.widest).join(" · ");
  const footerMeasure = useRef<HTMLSpanElement>(null);
  const [footerTwoLines, setFooterTwoLines] = useState(false);
  useLayoutEffect(() => {
    const measure = footerMeasure.current;
    if (!measure) return setFooterTwoLines(false);
    const decide = () => setFooterTwoLines(measure.scrollWidth > measure.clientWidth);
    decide();
    window.addEventListener("resize", decide);
    return () => window.removeEventListener("resize", decide);
  }, [footerWidest]);
  // Two lines: the book's position on the first, the chapter's and the speed on the second.
  const bookParts = parts.filter((part) => part.book);
  const footerLines = (
    footerTwoLines && bookParts.length && bookParts.length < parts.length
      ? [bookParts, parts.filter((part) => !part.book)]
      : footerTwoLines && parts.length > 1
        ? [parts.slice(0, -1), parts.slice(-1)]
        : [parts]
  ).map((line) => line.map((part) => part.node));
  const lightPage = isLightTheme(resolveReaderTheme(readerTheme, readerCustomThemes));
  useEffect(() => systemBarIcons(lightPage), [lightPage]);
  // Back closes the deepest lookup popup.
  useBackCloser(lookup.open, lookup.back);

  const current = {
    ready,
    pageTurns,
    onTurn,
    onLookUp,
    onScroll,
    onChapterEdge,
    onReadOn,
    onVnGroupAt,
    lookupClosedAt: lookup.closedAt,
    tapLookup: readerTapLookup,
    touchTurns: readerTouchPageTurns,
    // Taps turn only pages: a continuous book, whole or a chapter at a time, has none.
    tapTurns: readerViewMode === "paginated" || readerViewMode === "vn",
    chapterView: readerViewMode === "semi-continuous",
  };
  const latest = useRef(current);
  latest.current = current;
  useEffect(() => {
    // `now` is on this window's clock: a book page's own events count from its frame's start.
    let start: {
      x: number;
      y: number;
      at: number;
      now: number;
      /** Where a chapter shown alone was at its edge when the touch began. */
      edges?: { advance: boolean; retreat: boolean };
    } | null = null;
    const touched = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!touch) return;
      const point = screenPoint(event, touch);
      if (event.type === "touchstart") {
        // A long press here selects the book's text, which shows Komori's toolbar.
        ownBookSelection((event.target as Node | null)?.ownerDocument !== document);
        const { pageTurns, chapterView, onChapterEdge, onScroll } = latest.current;
        start =
          event.touches.length === 1
            ? {
                ...point,
                at: event.timeStamp,
                now: performance.now(),
                edges:
                  chapterView && pageTurns.scrollAxis
                    ? { advance: onChapterEdge("advance"), retreat: onChapterEdge("retreat") }
                    : undefined,
              }
            : null;
        if (pageTurns.scrollAxis) onScroll();
        return;
      }
      const began = start;
      start = null;
      const {
        ready,
        pageTurns,
        onTurn,
        onLookUp,
        onReadOn,
        onVnGroupAt,
        lookupClosedAt,
        tapLookup,
        touchTurns,
        tapTurns,
      } = latest.current;
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
        const across = point.x / window.innerWidth;
        const turns = touchTurns && tapTurns;
        const back = turns && (leftAdvances ? across > 1 - sideZone : across < sideZone);
        const forward = turns && (leftAdvances ? across < sideZone : across > 1 - sideZone);
        // In VN view a tap on the group shown reads on, as a click on it does on the PC, with
        // or without page turns by touch: it is how VN view is read.
        const onGroup = !back && !forward && !!onVnGroupAt?.(point.x, point.y);
        // While VN view's text still appears, a tap only shows the rest of it, as a click does
        // on the PC: the words not shown yet are blank page. The side that turns back still
        // turns back. Otherwise a tap on a word looks it up; one on blank space turns the
        // page from a side, reads on from the group, or shows the controls from the middle,
        // unless it closed the lookup by the word, as the press it began with does.
        if (!back && onReadOn(false)) return;
        if (tapLookup && onLookUp(point.x, point.y)) return;
        if (lookupClosedAt() >= began.now - closingPress) return;
        if (back) onTurn("retreat");
        // VN view reads on, first showing the rest of the group.
        else if (forward || onGroup) {
          if (!onReadOn(true)) onTurn("advance");
        } else setShown(true);
        return;
      }
      if (!touchTurns) return;
      // A continuous book scrolls under the finger instead; a chapter shown alone turns to
      // its neighbour when the finger reads on from the chapter's edge.
      if (pageTurns.scrollAxis) {
        const vertical = pageTurns.scrollAxis === "vertical";
        const along = vertical ? dy : dx;
        const across = vertical ? dx : dy;
        if (!began.edges || Math.abs(along) < swipeDistance) return;
        if (Math.abs(along) < Math.abs(across) * 1.5) return;
        const direction = (vertical ? along < 0 : leftAdvances === along > 0)
          ? "advance"
          : "retreat";
        if (began.edges[direction]) onTurn(direction);
        return;
      }
      if (Math.abs(dx) < swipeDistance || Math.abs(dx) < Math.abs(dy) * 1.5) return;
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
      onSelectionAction(action, selected.document, selected.note);
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
  const sync = useReaderSync({
    bookId: identity.status === "book" ? identity.book.id : null,
    ready,
    goToPosition: (locator) => {
      if (locator) onGoToPosition(locator, () => {});
      else onGoToOffset(0, () => {});
    },
  });

  // The volume keys turn the page while the book alone shows, when their setting is on: down
  // reads on, as VN view's tap does, and up turns back. A press with the lookup open closes
  // it, as Back does. Any other press changes the volume.
  const volume = {
    on: readerVolumePageTurns && ready,
    covered: shown || chaptersOpen || appearanceOpen || !!tool || image.viewing || !!sync.conflict,
    lookup,
    onTurn,
    onReadOn,
  };
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  useEffect(
    () =>
      onVolumeKey((key) => {
        const { on, covered, lookup, onTurn, onReadOn } = volumeRef.current;
        if (!on || covered) return false;
        if (lookup.open) lookup.back();
        else if (key === "up") onTurn("retreat");
        else if (!onReadOn(true)) onTurn("advance");
        return true;
      }),
    [],
  );

  return (
    <>
      {ready && !shown && (readerShowClock || readerShowReadingTime) && (
        <button
          aria-label={t("mobileReader.showControls")}
          className="mobile-reader__status"
          onClick={() => setShown(true)}
          type="button"
        >
          <ReaderReadingStatus
            clock={readerShowClock}
            readingTime={readerShowReadingTime}
            readingMs={session.readingMs}
            session={session.state}
          />
        </button>
      )}
      {footerWidest && (
        <span
          aria-hidden="true"
          className="mobile-reader__footer mobile-reader__footer-measure"
          data-lines={footerTwoLines ? 2 : 1}
          ref={footerMeasure}
        >
          {footerWidest}
        </span>
      )}
      {ready && !shown && parts.length ? (
        <button
          aria-label={t("mobileReader.showControls")}
          className={`mobile-reader__footer${footerLines.length > 1 ? " mobile-reader__footer--two-lines" : ""}`}
          onClick={() => setShown(true)}
          type="button"
        >
          {footerLines.map((line, lineIndex) => (
            // One run of text per line, so the flex button keeps the spaces around the dots.
            <span key={lineIndex}>
              {line.map((part, index) => (
                <Fragment key={index}>
                  {index > 0 && " · "}
                  {part}
                </Fragment>
              ))}
            </span>
          ))}
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
          {/* Each pill flanked by round buttons, where the clock and the footer show while
              reading; the title and the chapter open Contents. */}
          <header className="mobile-reader-controls__row mobile-reader-controls__row--top">
            <button
              aria-label={t("statistics.back")}
              className="mobile-reader-controls__button"
              onClick={onBack}
              type="button"
            >
              <ArrowLeftIcon aria-hidden="true" size={20} />
            </button>
            <button
              aria-label={t("mobileReader.contents")}
              className="mobile-reader-controls__pill"
              onClick={() => setChaptersOpen(true)}
              type="button"
            >
              <span lang={bookLanguage(identity)}>{title}</span>
            </button>
            <button
              aria-label={t("sidebar.search")}
              className="mobile-reader-controls__button"
              onClick={() => openTool("search")}
              type="button"
            >
              <MagnifyingGlassIcon aria-hidden="true" size={20} />
            </button>
          </header>
          <section
            aria-label={t("mobileReader.tools")}
            className="mobile-reader-controls__row mobile-reader-controls__row--bottom"
          >
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
            <button
              aria-label={t("sidebar.chapters")}
              className="mobile-reader-controls__pill"
              onClick={() => setChaptersOpen(true)}
              type="button"
            >
              <span lang={bookLanguage(identity)}>{chapter?.label ?? title}</span>
              {total ? <small>· {percent(progress?.current ?? 0, total)}%</small> : null}
            </button>
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
        position={{
          at,
          total,
          unit: progress?.unit ?? "characters",
          chapter: chapter?.label ?? title,
          chapterPercent,
          disabled: !total || turning,
          onDrag: setDragged,
          onCommit: () => {
            if (dragged === null) return;
            setChaptersOpen(false);
            setShown(false);
            commit();
          },
        }}
        title={title}
      />
      <AppearanceSheet
        onClose={() => setAppearanceOpen(false)}
        open={appearanceOpen}
        panel={appearance}
      />
      <ContinueFromDialog
        chapterAt={(offset) => chapterAt(entries, offset)?.label}
        conflict={ready ? sync.conflict : null}
        lang={bookLanguage(identity)}
        onChoose={(keep) => void sync.choose(keep)}
        onClose={sync.close}
        title={title}
      />
      {selected && ready && !turning && !shown && !tool && !chaptersOpen && !appearanceOpen ? (
        <SelectionToolbar onAct={act} rect={selected.rect} saved={!!selected.note} />
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
  position,
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
  /** The book's position, which the slider changes: it shows where it is dragged. */
  position: {
    at: number;
    total: number;
    unit: ReaderBookProgress["unit"];
    chapter: string;
    chapterPercent: number | null;
    disabled: boolean;
    onDrag: (at: number) => void;
    onCommit: () => void;
  };
}) {
  const { t, number } = useI18n();
  const currentRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) currentRef.current?.scrollIntoView?.({ block: "center" });
  }, [open]);
  const index = entries.findIndex((entry) => entry.id === current);
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
      {position.total ? (
        <div className="mobile-chapters__now">
          <div className="mobile-reader-controls__chapter">
            <span lang={language}>{position.chapter}</span>
            {position.chapterPercent === null ? null : (
              <span className="mobile-reader-chip">{position.chapterPercent}%</span>
            )}
          </div>
          <input
            aria-label={t("mobileReader.position")}
            className="mobile-reader-controls__slider"
            disabled={position.disabled}
            max={position.total}
            min={0}
            onChange={(event) => position.onDrag(Number(event.currentTarget.value))}
            onKeyUp={position.onCommit}
            onPointerUp={position.onCommit}
            step={1}
            type="range"
            value={position.at}
          />
          <div className="mobile-reader-controls__counts">
            <BookPosition current={position.at} total={position.total} unit={position.unit} />
            <span>{percent(position.at, position.total)}%</span>
          </div>
        </div>
      ) : null}
    </MobileSheet>
  );
}

const toolButtons: {
  tool: Tool;
  label: "sidebar.images" | "sidebar.bookmarks" | "sidebar.notes";
  icon: typeof ImageIcon;
}[] = [
  { tool: "images", label: "sidebar.images", icon: ImageIcon },
  { tool: "bookmarks", label: "sidebar.bookmarks", icon: BookmarkSimpleIcon },
  { tool: "notes", label: "sidebar.notes", icon: NotePencilIcon },
];

/** Images, Bookmarks and Notes in Contents; Search has its own button in the controls. */
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
  /** The saved passage the selection starts on, as a long press on a highlight selects. */
  note?: string;
}

/** A book page's selected text and where it shows, or null when nothing is selected. */
function selectedText(document: Document): SelectedText | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const range = selection.getRangeAt(0);
  const box = range.getBoundingClientRect();
  const frame = document.defaultView?.frameElement?.getBoundingClientRect();
  const x = frame?.left ?? 0;
  const y = frame?.top ?? 0;
  const first = range.getClientRects?.()[0];
  const note = first
    ? noteAtPoint(document, (first.left + first.right) / 2, (first.top + first.bottom) / 2)
    : null;
  return {
    document,
    text,
    rect: { top: box.top + y, right: box.right + x, bottom: box.bottom + y, left: box.left + x },
    ...(note && { note }),
  };
}

// The toolbar's size, as mobileReader.css draws it, and its distance from the selection and
// the screen's edges. Below the selection it clears Android's handles.
const toolbarWidth = 248;
const toolbarHeight = 56;
const toolbarGap = 12;
const handleRoom = 32;
const screenGutter = 8;

/**
 * Note, Highlight, Copy, Look up and Search beside the book's selection, above it where there
 * is room. On a saved passage, Delete removes it in place of Highlight.
 */
function SelectionToolbar({
  rect,
  saved,
  onAct,
}: {
  rect: SelectedText["rect"];
  saved: boolean;
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
    saved
      ? ({ action: "delete", label: t("noteMenu.delete"), icon: TrashIcon } as const)
      : ({ action: "highlight", label: t("textMenu.highlight"), icon: HighlighterIcon } as const),
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

function AppearanceSheet({
  open,
  onClose,
  panel,
}: {
  open: boolean;
  onClose: () => void;
  panel: ReaderAppearancePanelProps;
}) {
  const { t } = useI18n();
  const appearance = useAppearance();
  const customTheme = appearance.readerCustomThemes.find(
    (theme) => theme.id === appearance.readerTheme,
  );
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
        <button
          aria-label={t("readerTheme.new")}
          className="mobile-reader-theme mobile-reader-theme--new"
          disabled={appearance.readerCustomThemes.length >= readerCustomThemeLimit}
          onClick={panel.onCreateCustomTheme}
          type="button"
        >
          <span aria-hidden="true" className="mobile-reader-theme__preview">
            <PlusIcon size={20} />
          </span>
          <small aria-hidden="true">{t("appearance.custom")}</small>
        </button>
      </div>
      {customTheme && (
        <section className="reader-appearance-card" aria-label={customTheme.name}>
          <ReaderCustomThemeEditor
            key={customTheme.id}
            theme={customTheme}
            onChange={(change) => panel.onCustomThemeChange(customTheme.id, change)}
            onDelete={() => panel.onDeleteCustomTheme(customTheme.id)}
          />
        </section>
      )}
      <ReaderAppearancePanel {...panel} touch />
      <section className="reader-appearance-card" aria-labelledby="mobile-reader-touch">
        <h3 className="reader-appearance-card__title" id="mobile-reader-touch">
          {t("appearancePanel.touch")}
        </h3>
        <div className="reader-appearance-rows">
          <ToggleSetting
            label={t("popupSettings.tapLookup")}
            checked={appearance.readerTapLookup}
            onChange={appearance.setReaderTapLookup}
          />
          <ToggleSetting
            label={t("appearancePanel.touchTurns")}
            checked={appearance.readerTouchPageTurns}
            onChange={appearance.setReaderTouchPageTurns}
          />
          <ToggleSetting
            label={t("appearancePanel.volumeTurns")}
            checked={appearance.readerVolumePageTurns}
            onChange={appearance.setReaderVolumePageTurns}
          />
        </div>
      </section>
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

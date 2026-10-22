import type { ReaderFontPair } from "./fontChoices";
import type { ReadingSession } from "../statistics/readingSession";
import type { ReaderSerifFont, ReaderSansFont } from "./fontFamilies";
import type {
  ReaderBlurMode,
  ReaderFuriganaStyle,
  ReaderPageLayout,
  ReaderTextOrientation,
  ReaderViewMode,
  ReaderWritingMode,
} from "./presentation";
import type { LookupTrigger, LookupTriggerPreferences } from "./lookupTriggers";

/** Komori's minimal UI-facing renderer boundary. No package or source paths cross it. */
export type ReaderImageBlurBoundary = "available" | "unavailable" | "fixed-layout";

export interface ReaderRenderer {
  /** Whether After ToC has an authored in-spine contents page. No paths cross here. */
  getImageBlurBoundary?(): ReaderImageBlurBoundary;
  /** Update lookup input listeners/timers without changing selection or book layout. */
  setLookupTriggers?(settings: LookupTriggerPreferences): void;
  /** Mount into an exclusively owned host. Reject to report an unexpected render failure. */
  mount(
    host: HTMLElement,
    signal: AbortSignal,
    onPageTurnsChanged: (availability: ReaderPageTurnAvailability) => void,
    onContentDocument?: (document: Document) => void,
    onContentsChanged?: (entries: ReaderContentsEntry[]) => void,
    position?: ReaderPositionBinding,
    onProgressChanged?: (progress: ReaderBookProgress) => void,
    presentation?: ReaderPresentation,
    onSelectionChanged?: (selection: ReaderSelection | null) => void,
  ): Promise<ReaderMountResult>;
  /**
   * Move one displayed page in the book's logical reading order. A book that scrolls
   * continuously moves by about one reading area, and a book that scrolls one chapter at
   * a time shows the neighbouring chapter once it is at its chapter's end or start.
   */
  revealVnText?(): void;
  advancePage(): Promise<void>;
  retreatPage(): Promise<void>;
  /**
   * Scroll a continuously displayed book by a distance in CSS pixels along its reading
   * order, backwards when negative. The position publishes once scrolling settles.
   * Ignored while a navigation or reflow is pending, or when the book turns pages.
   * Returns false, without scrolling, when a book scrolling one chapter at a time is
   * already at the end (or start) of its chapter and another chapter follows (or
   * precedes) it, which a page turn then shows.
   */
  scrollBy?(distance: number): boolean;
  /**
   * A continuously displayed book's scroll position along its reading order, for the
   * Reader's own scrollbar at the window's edge. Null while the book turns pages.
   */
  scrollMetrics?(): ReaderScrollMetrics | null;
  /** Scroll a continuously displayed book to a position along its reading order. */
  scrollToPosition?(position: number): void;
  /** Follow a continuous book's scrolling and size changes. Returns the unsubscribe. */
  watchScroll?(listener: () => void): () => void;
  /**
   * Publish where a continuously displayed book's scrolling stopped without waiting for
   * it to settle, as when the window or the book closes. A navigation or reflow under
   * way publishes its own point instead.
   */
  settlePosition?(): void;
  /** Resolve an adapter-owned authored destination by its session-local identity. */
  goToContentsEntry?(entryId: string): Promise<boolean>;
  /** Capture the actual displayed place without changing navigation or selection. */
  captureBookmark?(): Promise<ReaderBookmarkPlace | null>;
  /** Snapshot current selected book text and its original section identity without moving it. */
  captureNote?(): Promise<import("./notes").NotePassage | null>;
  /** Paint every saved passage, independent of Notes panel filtering. No navigation. */
  setNoteHighlights?(notes: readonly import("./notes").ReaderNote[]): void;
  /** Resolve a saved place, checking its section content before moving. No fallback jump. */
  goToBookmark?(locator: ReaderBookmarkLocator): Promise<boolean>;
  /** Literal readable-text search. Destinations remain session-local and adapter-owned. */
  searchBook?(
    query: string,
    scope: ReaderSearchScope,
    signal: AbortSignal,
  ): Promise<ReaderSearchResults>;
  /** Reject obsolete result IDs and stop pending resolution when its query is cancelled. */
  goToSearchResult?(id: string, signal: AbortSignal): Promise<boolean>;
  /** Discover illustrated places in reading order; all resource destinations stay here. */
  listImages?(signal: AbortSignal): Promise<ReaderImages>;
  /** Resolve a displayed occurrence through original archive discovery. */
  imageAt?(element: Element, signal: AbortSignal): Promise<ReaderImageSelection | null>;
  loadImage?(
    id: string,
    size: "thumbnail" | "viewer",
    signal: AbortSignal,
  ): Promise<ReaderImageResource>;
  /** Release only a generated image URL owned by this renderer. */
  releaseImage?(url: string): void;
  goToImage?(id: string, signal: AbortSignal): Promise<boolean>;
  /**
   * Reflow a ready book with a new presentation and show the page holding the same
   * reading point. Like a turn, it is ignored while another navigation is pending.
   */
  setPresentation?(presentation: ReaderPresentation): Promise<void>;
  /** Highlight a pointer scan's matched start by Unicode-character length. Null clears it.
   * Scan IDs are session-local; obsolete IDs are ignored. No DOM range crosses this boundary.
   */
  highlightPointerMatch?(scanId: number | null, length?: number): void;
  /** Idempotently release DOM, listeners, subscriptions, and pending work. */
  dispose(): void;
}

export type ReaderRendererFactory = () => ReaderRenderer;

export interface ReaderScrollMetrics {
  /** Vertical for horizontal text, horizontal for vertical text. */
  axis: "vertical" | "horizontal";
  /** A right-to-left book starts at the right end of a horizontal scroll. */
  reversed: boolean;
  /** Pixels scrolled from the start, the most it scrolls, and the size in view. */
  position: number;
  length: number;
  visible: number;
}

export interface ReaderImage {
  id: string;
  alt: string;
  label: string;
  section: number;
}

export interface ReaderImages {
  items: ReaderImage[];
  truncated: boolean;
  failedSections: number;
}

/** A dimension-checked raster or adapter-rebuilt inert drawing, never an authored URL/path. */
export interface ReaderImageResource {
  url: string;
  width: number;
  height: number;
  /**
   * The image the URL shows, for copying or saving it: the page may not fetch its own
   * `blob:` URLs.
   */
  blob?: Blob;
}

interface ReaderImageSelection {
  items: ReaderImage[];
  index: number;
}

export type ReaderSearchScope = "book" | "chapter";

export interface ReaderSearchMatch {
  id: string;
  label: string;
  section: number;
  before: string;
  match: string;
  after: string;
}

export interface ReaderSearchResults {
  matches: ReaderSearchMatch[];
  /** More matches exist; only the first bounded set was read. */
  truncated: boolean;
}

export type ReaderMountResult =
  "ready" | "missing" | "unreadable" | "invalid" | "tooLarge" | "error";

export type ReaderStatus = "empty" | "loading" | ReaderMountResult;

export interface ReaderPageTurnAvailability {
  vnRevealing?: boolean;
  vnNotice?: "fixed-layout" | "whole-section" | "instant-text";
  canAdvance: boolean;
  canRetreat: boolean;
  forwardArrow?: "ArrowLeft" | "ArrowRight";
  /**
   * The axis a continuously displayed book scrolls along: vertical for horizontal text,
   * horizontal for vertical text. Absent while the book turns pages.
   */
  scrollAxis?: "vertical" | "horizontal";
  /** Paginated chapter/section edges. Explicit navigation does not use the wheel guard. */
  advanceChapter?: boolean;
  retreatChapter?: boolean;
}

/**
 * Selected text or a Shift pointer scan in the book. A scan starts at the touched character,
 * stays within its block, and contains at most 256 Unicode characters. Null invalidates the
 * lookup when a selection is cleared or its layout changes. No book DOM crosses the boundary.
 */
export interface ReaderSelection {
  /** Owning trigger; older adapter reports may omit it for Shift scans. */
  origin?: LookupTrigger;
  /** Adapter-owned identity for a pointer scan; absent for browser selections. */
  scanId?: number;
  /** Selected or scanned text without ruby annotations, as it appears in the document. */
  text: string;
  /** Bounded surrounding sentence/block text, without ruby or renderer internals. */
  sentence?: string;
  /**
   * Where the selection shows, in the Reader window's CSS pixels: the union of its boxes
   * within the reading area, or of all of them when none is within it. A scan uses only
   * the touched character's boxes.
   */
  rect: ReaderRect;
  /** The writing mode of the text where the selection starts. */
  writingMode: "horizontal" | "vertical-rl" | "vertical-lr";
}

export interface ReaderRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ReaderContentsEntry {
  id: string;
  label: string;
  navigable: boolean;
  children: ReaderContentsEntry[];
  /** Counted book offset at the authored destination; null means unavailable. */
  location?: { current: number; total: number; unit: ReaderProgressUnit } | null;
}

/**
 * Komori's renderer-neutral reading position: a spine position, an optional short
 * fingerprint of that section, and fractional progress through its text. It holds
 * no source path, archive path, or renderer CFI.
 */
export interface ReaderLocator {
  spineIndex: number;
  sectionKey?: string;
  progress: number;
}

/** Bookmarks require both the section identity and a SHA-256 of its original content. */
export interface ReaderBookmarkLocator extends ReaderLocator {
  sectionKey: string;
  contentKey: string;
}

export interface ReaderBookmarkPlace {
  locator: ReaderBookmarkLocator;
  excerpt: string;
}

export interface ReaderPositionBinding {
  /** The saved position to restore. A missing or unresolvable one opens the authored start. */
  initial: Promise<ReaderLocator | null>;
  /** Called after a page turn or contents jump settles on a new displayed position. */
  onLocationChanged(locator: ReaderLocator): void;
}

/**
 * Characters (Unicode letters and numbers) for mostly Chinese, Japanese, or Korean
 * books, otherwise words. Neither counts whitespace, punctuation, or furigana.
 */
export type ReaderProgressUnit = "characters" | "words";

/**
 * How far the reader is through the book, in readable units of the linear spine
 * sections. It is published once the adapter has counted the book, then after each
 * settled turn or contents jump.
 */
export interface ReaderBookProgress {
  unit: ReaderProgressUnit;
  /** Units before the first displayed character, or `total` on the final page. */
  current: number;
  total: number;
  /** The same position within the current chapter. */
  chapter: ReaderChapterProgress;
}

/**
 * A chapter is the text between consecutive authored contents destinations in
 * reading order, or a linear spine section when the book has no usable contents.
 * The current chapter is the last one that starts on or before the displayed page.
 */
interface ReaderChapterProgress {
  /**
   * Chapter units, in the book's unit, before the first displayed character: 0 on its
   * start page, and `total` once its last counted unit or the book's final page is displayed.
   */
  current: number;
  total: number;
  /**
   * The session-local contents entry that begins this chapter, or the entry just
   * chosen from the contents until the next settled position. Absent for text before
   * the first destination and for books without usable contents.
   */
  entryId?: string;
}

/** How the book's text is presented. No renderer styling crosses this boundary. */
export interface ReaderPresentation {
  /** The book's base font size in CSS pixels, which its relative sizes follow. */
  fontSize: number;
  /**
   * The line height of all the book's text, as a multiple of its font size. Absent,
   * the book keeps its own line spacing.
   */
  lineHeight?: number;
  /** Ordered font choices, ignored by fixed-layout books. Absent, keep the book font. */
  fontPair?: ReaderFontPair;
  fontFamilyGroup1?: ReaderSerifFont;
  fontFamilyGroup2?: ReaderSansFont;
  /**
   * The weight of the book's normal text, 100 to 900. Its other weights shift with it,
   * so its bold text stays bolder. Absent, the book keeps its own weights.
   */
  fontWeight?: number;
  /**
   * The first-line indentation of the book's indented paragraphs, in em of their font
   * size. Absent, the book keeps its own indentation.
   */
  paragraphIndent?: number;
  /**
   * The space before and after each paragraph of every reflowable section, along the
   * text's block direction, in CSS pixels. Absent, the book keeps its own.
   */
  paragraphMargin?: number;
  /**
   * The space between the characters of every reflowable section's text, and at each space
   * between its words, in CSS pixels. Absent or 0, the book keeps its own spacing.
   */
  letterSpacing?: number;
  wordSpacing?: number;
  /** Justify prose paragraphs. False/absent preserves publisher alignment. */
  textJustification?: boolean;
  /** Request browser pretty paragraph wrapping. False/absent preserves publisher wrapping. */
  prettyTextWrap?: boolean;
  /**
   * The empty space on the left and right of each page, in CSS pixels. Absent, the
   * renderer keeps its automatic margins.
   */
  sideMargin?: number;
  /** Maximum text width per page, centered and fitted to the available reading area. */
  maxWidth?: number;
  /** Paginated pages per turn. Horizontal spreads side by side; vertical stacks pages. */
  pageLayout?: ReaderPageLayout;
  /**
   * The tallest the book's reading area may be, in CSS pixels; a shorter one is centered
   * in the window's height. Absent, the book fills the window's height.
   */
  maxHeight?: number;
  /**
   * The direction every reflowable section's text runs in, which also sets the page
   * turn direction. Absent, each book keeps its own.
   */
  writingMode?: ReaderWritingMode;
  /**
   * How the characters of every reflowable section's vertical text stand: Latin letters
   * and digits sideways (mixed) or upright. Horizontal text is unaffected. Absent, each
   * book keeps its own.
   */
  textOrientation?: ReaderTextOrientation;
  /**
   * Whether the ruby annotations (furigana) of every reflowable section are hidden, the
   * text laid out without them. Absent or false, they show.
   */
  hideFurigana?: boolean;
  /** How the enabled Hide furigana setting presents and reveals authored readings. */
  furiganaStyle?: ReaderFuriganaStyle;
  /**
   * Whether images in the chosen scope of reflowable sections are blurred. Blurring changes no
   * layout. Absent or false, images show.
   */
  blurImage?: boolean;
  /** All (default), or images following the authored contents page. */
  blurMode?: ReaderBlurMode;
  /**
   * The `#rrggbb` color of every reflowable section's text, replacing the colors the
   * book sets, with links kept distinguishable. Recoloring changes no layout. Absent,
   * each book keeps its own.
   */
  textColor?: string;
  /**
   * The `#rrggbb` color behind text selected in the book and behind a pointer lookup's
   * match. Absent, the browser's own.
   */
  selectionColor?: string;
  /** The `#rrggbb` color behind saved passages. Absent, Komori's default yellow. */
  highlightColor?: string;
  /**
   * Whether reflowable books turn pages, scroll continuously across sections, or scroll
   * through one chapter at a time. Absent, pages turn. Fixed-layout books always turn
   * pages.
   */
  viewMode?: ReaderViewMode;
  vnParagraphs?: number;
  vnTextSpeed?: number;
}

/** Native-owned persistence for one catalog ID. */
export interface ReaderPositionStore {
  load(): Promise<ReaderLocator | null>;
  save(locator: ReaderLocator): Promise<void>;
  /** Records the whole-book progress the Library shows. */
  saveProgress?(progress: Pick<ReaderBookProgress, "unit" | "current" | "total">): Promise<void>;
  /** Records (or updates) one reading session for Statistics. */
  saveSession?(session: ReadingSession): Promise<void>;
}

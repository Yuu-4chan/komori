import { i18n } from "../../i18n/i18n";
import {
  isReaderFontChoice,
  fontPairStack,
  fontPairFaces,
  fontPairBaseWeight,
  sameFontPair,
  googleFontFiles,
  validUploadedFont,
  validFontFamily,
  type ReaderFontPair,
} from "./fontChoices";
import { isFaceWeight } from "./fontWeights";
import ePub, { type Book, type Rendition } from "epubjs";
import {
  installEpubTolerance,
  InvalidEpubDocument,
  EpubResourceLimit,
  validateEpubSpine,
} from "./epubTolerance";
import { applyBookImageLayout, fitBookImagePage, isTextImage, shownText } from "./bookImageLayout";
import { fillFixedSvgPage, isSvgPage } from "./svgPage";
import {
  isReaderSerifFont,
  isReaderSansFont,
  readerFontStack,
  readerInterFace,
  type ReaderSerifFont,
  type ReaderSansFont,
} from "./fontFamilies";

import { vnBlocks, vnGroupStarts, type VnBlock } from "./vnGroups";
import { VnReveal } from "./vnReveal";
import { applyParagraphLayout } from "./paragraphLayout";
import { applyHangingIndentLayout } from "./hangingIndentLayout";
import { prepareReaderContent } from "./contentApi";
import { installNativeArchive, openNativeArchive } from "./nativeArchive";
import {
  countUnits,
  progressUnit,
  readableText,
  readableUnits,
  readableUnitsBefore,
  scriptCounts,
  type TextPoint,
} from "./readingMeasure";
import {
  isBlurMode,
  isFuriganaStyle,
  type ReaderFuriganaStyle,
  type ReaderBlurMode,
  normalizeFontSize,
  normalizeFontWeight,
  normalizeLineHeight,
  normalizeMaxHeight,
  normalizeMaxWidth,
  normalizePageLayout,
  type ReaderPageLayout,
  normalizeParagraphIndent,
  normalizeParagraphMargin,
  normalizeLetterSpacing,
  normalizeWordSpacing,
  normalizeSideMargin,
  normalizeTextOrientation,
  normalizeViewMode,
  normalizeVnParagraphs,
  normalizeVnTextSpeed,
  normalizeWritingMode,
  readerFontSize,
  readerFontWeight,
  type ReaderTextOrientation,
  type ReaderViewMode,
  type ReaderWritingMode,
} from "./presentation";
import { ImageBlurSession, type ImageBlurBoundary } from "./imageBlur";
import { FuriganaSession } from "./furigana";
import { imageInkShift, type InkShift } from "./imageInk";
import {
  IMAGE_LIMIT,
  IMAGE_BYTES,
  IMAGE_DOCUMENT_BYTES,
  imageElements,
  imageAlt,
  imageArchivePath,
  rasterType,
  inertSvg,
  renderBookImage,
} from "./bookImages";
import type { ReaderImages, ReaderImageResource, ReaderScrollMetrics } from "./renderer";
import { normalizeReaderLocator } from "./readingPosition";
import { normalizeBookmarkLocator } from "./bookmarks";
import { notePassage } from "./noteCapture";
import type { NotePassage, ReaderNote } from "./notes";
import {
  LOOKUP_MARKS,
  NOTE_MARKS,
  noteHighlightResolver,
  paintLookupMatch,
  paintNoteHighlights,
  paintSearchMatch,
  paintSelection,
  SEARCH_MARKS,
  SELECTION_MARKS,
  textRanges,
} from "./noteHighlights";
import { isThemeColor } from "./readerThemes";
import type {
  ReaderBookProgress,
  ReaderBookmarkLocator,
  ReaderBookmarkPlace,
  ReaderProgressUnit,
  ReaderContentsEntry,
  ReaderLocator,
  ReaderMountResult,
  ReaderPageTurnAvailability,
  ReaderPositionBinding,
  ReaderPresentation,
  ReaderRect,
  ReaderRenderer,
  ReaderRendererFactory,
  ReaderSelection,
} from "./renderer";
import { readerRangeRect, watchTextSelection, type SelectionWatch } from "./textSelection";
import { defaultLookupTriggers, type LookupTriggerPreferences } from "./lookupTriggers";
import {
  SEARCH_LIMIT,
  SEARCH_QUERY_LIMIT,
  literalMatches,
  matchExcerpt,
  searchQuery,
  searchText,
} from "./bookSearch";
import type { ReaderSearchResults, ReaderSearchScope } from "./renderer";

const unavailable: ReaderPageTurnAvailability = { canAdvance: false, canRetreat: false };

interface DisplayedBookLocation {
  atStart?: boolean;
  atEnd?: boolean;
  start?: {
    index?: number;
    href?: string;
    cfi?: string;
    displayed?: { page?: number; total?: number };
  };
  end?: { index?: number; cfi?: string; displayed?: { page?: number; total?: number } };
}

interface DisplayedPosition {
  locator: ReaderLocator;
  atEnd: boolean;
  /** The first displayed character and the point just after the last one, when resolvable. */
  pageStart?: PagePoint;
  pageEnd?: PagePoint;
}

/** A point in a displayed section document. */
interface PagePoint extends TextPoint {
  spineIndex: number;
  document: Document;
}

interface EpubPageContents {
  document: Document;
  sectionIndex?: number;
  cfiFromRange(range: Range): string;
  range?(cfi: string): Range;
  /** Measure the text and, when its size changed, expand the view to it at once. */
  resizeCheck?(): void;
  /** The content width along a continuous vertical section's reading order. */
  textWidth?(): number;
  /** The content height along a continuous horizontal section's reading order. */
  textHeight?(): number;
  /** The writing mode of the section's root. */
  writingMode?(): string;
  columns?(
    width: number,
    height: number,
    columnWidth: number,
    gap: number,
    direction?: string,
  ): unknown;
  /** The size a fixed-layout page declares for itself in its viewport meta element. */
  viewport?(): { width?: string; height?: string };
  /** Set a style property on the element EPUB.js fits a fixed-layout page in. */
  css?(property: string, value?: string): unknown;
}

/** The reading point a presentation change keeps displayed. */
interface ReflowAnchor {
  spineIndex: number;
  /** Text progress of the point, for when its displayed document is gone. */
  progress: number;
  point?: PagePoint;
}

/**
 * The part of EPUB.js's view manager that its own next() uses to page vertically, and
 * that lays out its pages.
 */
interface EpubManager {
  layout: {
    height: number;
    delta?: number;
    /** One page's width without its gap. */
    columnWidth?: number;
    /** Pages in a spread: 2 when a double layout has room for two, else 1. */
    divisor?: number;
    /** One page's width, a column and its gap. */
    pageWidth?: number;
    _spread?: boolean;
    _minSpreadWidth?: number;
    /** The page progression each section is formatted in. */
    settings?: { direction?: string; spread?: string };
    /** Lay a section out in pages, as each section renders and when pages change. */
    format?(contents: EpubPageContents, ...rest: unknown[]): unknown;
  };
  /** Pages a section's displayed text in the page progression. */
  mapping?: { direction?: string };
  scrollBy(x: number, y: number, silent?: boolean): void;
  /** The size EPUB.js lays its pages out in, measured just before each layout. */
  _stageSize?: { width: number; height: number };
  /**
   * The axis of the last section EPUB.js displayed, vertical for vertical writing, and
   * the page progression it pages and positions sections in. A continuous view adds
   * sections within its offset of the reading area.
   */
  settings?: { axis?: string; direction?: string; offset?: number };
  /** Lay the pages out again and reformat the displayed views. */
  updateLayout?(): void;
  /** The size new views are created at, which a layout sets to the page size. */
  viewSettings?: { width?: number; height?: number };
  /** Set the page progression and lay the pages out again. */
  direction?(direction: string): void;
  /** Remove every displayed view, so the next display renders its section afresh. */
  clear?(): void;
  /** Follow a window resize: clear the views, lay the pages out again, and report it. */
  resize?(width?: number, height?: number, epubcfi?: string): void;
  /** Called by each section as it loads, before EPUB.js formats it with the layout. */
  updateAxis?(axis: string, forceUpdate?: boolean): void;
  /** The element the views are laid out in, which a continuous book scrolls. */
  container?: HTMLElement;
  /**
   * The displayed sections and the text each shows, found by laying the views out again
   * and measuring their text up to the page on every call.
   */
  currentLocation?(): unknown;
  views?: {
    all(): EpubView[];
    displayed(): EpubView[];
    first?(): EpubView | undefined;
    last?(): EpubView | undefined;
    remove(view: EpubView): void;
    /** Remove a section's view from the page, as clearing and trimming do. */
    destroy?(view: EpubView): void;
    /** Make the displayed views visible, once a navigation has laid them out. */
    show?(): void;
  };
  createView?(...args: unknown[]): EpubView;
  /** Show the section after a displayed one, as a fixed-layout spread's second page does. */
  handleNextPrePaginated?(
    forceRight: boolean,
    section: EpubSection,
    action: (section: EpubSection) => Promise<unknown>,
  ): unknown;
  /** Show a section before the displayed ones. */
  prepend?(section: EpubSection, forceRight?: boolean): Promise<unknown>;
  /** Show a section after the displayed ones, forced onto a spread's right side if asked. */
  add?(section: EpubSection, forceRight?: boolean): Promise<unknown>;
  /** Show the next page or spread, as a turn forward does. */
  next?(): Promise<unknown> | undefined;
  /** Show the previous page or spread, as a turn back does. */
  prev?(): Promise<unknown> | undefined;
  /** Show a section, at a CFI or fragment in it when given. */
  display?(section: EpubSection, target?: string): Promise<unknown>;
  scrollTo?(x: number, y: number, silent?: boolean): void;
  stage?: {
    overflow(overflow: string): void;
    /** Scroll from the right for a right-to-left progression. */
    direction?(direction: string): void;
  };
  overflow?: string;
  /** The rendition's queue, where EPUB.js adds and removes sections after a scroll. */
  q?: { enqueue(task: () => unknown): Promise<unknown> };
  /** Continuous view: the writing mode EPUB.js converts right-to-left scroll offsets by. */
  writingMode?: string;
  updateWritingMode?(mode: string): void;
  /** Continuous view: remove a section that has scrolled far out of view. */
  erase?(view: EpubView, above?: EpubView[]): void;
  /** Continuous view: keep the text in view when a section added before it renders. */
  counter?(bounds: unknown): void;
  /** Continuous view: remove sections outside the visible range. */
  trim?(): Promise<unknown>;
  /**
   * Continuous view: add the sections before and after the views while the reading area
   * lies within its offset of either end, and render them.
   */
  check?(...args: unknown[]): Promise<unknown>;
  /** Continuous view: check, in its queue, until no section is added. */
  fill?(): Promise<unknown>;
  /** Refresh the sections that intersect the current scroll position. */
  update?(offset?: number): Promise<unknown>;
  /** What each view loads its section with. */
  request?: unknown;
}

/** A spine section as EPUB.js's view manager shows it. */
interface EpubSection {
  index: number;
  href?: string;
  /** Whether the section is in the reading order, where turns pass through it. */
  linear?: boolean;
  /** The spine item's properties, such as the side of a spread a page is set on. */
  properties?: string[];
  /** The linear sections before and after it, which EPUB.js adds views for. */
  prev(): unknown;
  next(): unknown;
}

/** One section shown by EPUB.js's view manager. */
interface EpubView {
  section: EpubSection;
  element: HTMLElement;
  contents?: EpubPageContents;
  /** Whether a spread view rounds its section up to whole spreads, as EPUB.js does. */
  settings?: { axis?: string; forceEvenPages?: boolean };
  display(request?: unknown): Promise<unknown>;
  /** Make the view visible; EPUB.js forces a layout of the whole book each time. */
  show?(): void;
  hide?(): void;
  /** Remove the section's frame, keeping the view in place at its size. */
  destroy?(): void;
  /** Its section is rendered in it. */
  displayed?: boolean;
  iframe?: HTMLIFrameElement;
  /** Lock the view's fixed axis to a page size and expand it to its content. */
  size?(width?: number, height?: number): void;
  /** The view's width, a fixed-layout view's page width. */
  width?(): number;
  expand?(force?: boolean): void;
  reframe?(width: number, height: number): void;
  lockedWidth?: number;
  lockedHeight?: number;
  /** The size EPUB.js last framed the view at, and whether it must frame it again. */
  _width?: number;
  _height?: number;
  _needsReframe?: boolean;
  /** The layout the view's section is formatted with. */
  layout?: { name?: string };
  /** Where the view lies in the view manager's container. */
  offset?(): { left: number; top: number };
  /** Where a CFI or fragment lies in the view's section. */
  locationOf?(target: string): { left: number; top: number };
}

/** EPUB.js's layout, which formats each section for the view manager. */
interface EpubLayout {
  format(contents: EpubPageContents, section?: unknown, axis?: string): unknown;
}

/** How long the host's size must stay unchanged before the book follows it. */
const HOST_SIZE_SETTLE_MS = 150;
/** SVG content that draws something besides a framed picture. */
const SVG_DRAWING =
  "path, rect, circle, ellipse, line, polyline, polygon, text, use, foreignObject";
/** How long a continuous book must stay still before its position publishes. */
const SCROLL_SETTLE_MS = 250;
/** The share of the reading area a page turn scrolls a continuous book by. */
const CONTINUOUS_PAGE = 0.9;
/** How long a search jump's match stays marked, fading out over its last second. */
const SEARCH_MATCH_MS = 3500;
/**
 * The most linear sections a continuous book keeps loaded. Each section is a frame, and
 * WebView2 loads no more than 1000 frames in a page, so a longer book keeps only the
 * sections near its reading area loaded.
 */
const LOADED_SECTIONS_LIMIT = 400;
/** How many sections on each side of those in view a long continuous book keeps loaded. */
const LOADED_SECTIONS_REACH = 24;
/**
 * How many sections' views a continuous book groups together. Laying out the book after a
 * section changes size lays out that section's group and the groups, so the cost of a
 * section's layout grows with the book's length divided by this, plus this.
 */
const CONTINUOUS_VIEW_GROUP = 32;
/** EPUB.js's padding on the left and right of a vertical page, in pixels. */
const VERTICAL_PAGE_MARGIN = 20;
/** The host's custom property for a continuous vertical book's left and right margin. */
const SIDE_INSET = "--reader-side-inset";
/** The host's custom property for the tallest the reading area may be. */
const MAX_HEIGHT = "--reader-max-height";

// EPUB.js, including its spine and resource URLs, stays inside this module.
export function epubRendererFactory(catalogId: string): ReaderRendererFactory {
  return () => new EpubRenderer(catalogId);
}

class EpubRenderer implements ReaderRenderer {
  private book?: Book;
  private rendition?: Rendition;
  private disposed = false;
  private host?: HTMLElement;
  private request?: AbortController;
  private navigationAbort = new AbortController();
  private onPageTurnsChanged?: (availability: ReaderPageTurnAvailability) => void;
  private onContentDocument?: (document: Document) => void;
  private onSelectionChanged?: (selection: ReaderSelection | null) => void;
  private selectionActive = false;
  private scanIds = 0;
  private pointerScan?: { id: number; ranges: Range[] };
  private clearPointerPaint?: () => void;
  private noteHighlights: readonly ReaderNote[] = [];
  private notePaint = new Map<Document, { active: boolean; clear: () => void }>();
  /** The selection painter of each displayed section document. */
  private selectionPaint = new Map<Document, () => void>();

  setNoteHighlights(notes: readonly ReaderNote[]): void {
    if (this.disposed) return;
    this.clearNoteHighlights();
    this.noteHighlights = notes;
    this.registerContentDocuments();
  }

  private clearNoteHighlights() {
    for (const pending of this.notePaint.values()) {
      pending.active = false;
      pending.clear();
    }
    this.notePaint.clear();
  }

  private paintNotes(contents: EpubPageContents) {
    const { document, sectionIndex } = contents;
    if (!document || sectionIndex === undefined || this.notePaint.has(document)) return;
    const section = this.book?.spine.get(sectionIndex) as { href?: string } | null;
    if (!section?.href) return;
    const notes = this.noteHighlights.filter(
      (note) =>
        note.locator.spineIndex === sectionIndex &&
        note.locator.sectionKey === sectionKey(section.href!),
    );
    if (!notes.length) return;
    const pending = { active: true, clear: () => {} };
    this.notePaint.set(document, pending);
    void this.bookmarkSection(sectionIndex).then((original) => {
      if (!pending.active || this.disposed) return;
      try {
        const resolve = noteHighlightResolver(document);
        pending.clear = paintNoteHighlights(
          document,
          notes.map((note) => ({
            id: note.id,
            ranges: original?.contentKey === note.locator.contentKey ? resolve(note) : [],
          })),
        );
      } catch {
        // Unresolvable passages stay editable/removable in Notes.
      }
    });
  }
  /** The selection listeners of each displayed section document. */
  private selectionWatches = new Map<Document, SelectionWatch>();
  private lookupTriggers = defaultLookupTriggers;

  setLookupTriggers(settings: LookupTriggerPreferences): void {
    if (JSON.stringify(settings) === JSON.stringify(this.lookupTriggers)) return;
    this.lookupTriggers = { ...settings };
    for (const watch of this.selectionWatches.values()) watch.setSettings(this.lookupTriggers);
  }
  private onLocationChanged?: (locator: ReaderLocator) => void;
  private onProgressChanged?: (progress: ReaderBookProgress) => void;
  private onContentsChanged?: (entries: ReaderContentsEntry[]) => void;
  private contents: ReaderContentsEntry[] = [];
  private progressCounts?: BookProgressCounts;
  /** The prepared content URL, which names the source version being read. */
  private contentUrl?: string;
  private progressRevision = 0;
  private destinations = new Map<string, string>();
  /** Each image-only section that shares a spread, and the section beside it. */
  private imageSpreads = new Map<number, number>();
  /** Sections of text that follow a lone image page on its spread. */
  private textPartners = new Set<number>();
  /** The anchors of contents entries in each spine section, "" for its start, with their labels. */
  private headingTargets = new Map<unknown, Map<string, string[]>>();
  /** Each heading image's content shift, measured once from the archive by path. */
  private inkShifts = new Map<string, Promise<InkShift | undefined>>();
  /** The contents entry of the last successful jump, current until the next settled turn. */
  private jumpedEntryId?: string;
  private forwardArrow: "ArrowLeft" | "ArrowRight" = "ArrowRight";
  /** The book's own page progression and forward arrow, which a chosen writing mode replaces. */
  private bookDirection: "ltr" | "rtl" = "ltr";
  private bookForwardArrow: "ArrowLeft" | "ArrowRight" = "ArrowRight";
  /** The paginated horizontal section EPUB.js last formatted sets itself right to left. */
  private sectionRtl = false;
  /** EPUB.js is turning a paginated page, which may take it into another section. */
  private turningPage = false;
  /** Remove the views a paginated turn kept in view, as the next section's view shows. */
  private releaseHeldViews?: () => void;
  /** Fixed-layout pages keep their own writing mode. */
  private fixedLayout = false;
  private blurBoundary?: ImageBlurBoundary;
  private imageBlur = new ImageBlurSession(
    () => this.refreshImageBlur(),
    () => this.ready && !this.disposed && !this.turnPending && !this.layoutPending,
  );
  private furigana = new FuriganaSession(
    () => this.refreshFurigana(),
    () => this.ready && !this.disposed && !this.turnPending && !this.layoutPending,
  );

  private furiganaDocument(document: Document, index: number) {
    this.furigana.apply(
      document,
      index,
      this.presentation.hideFurigana,
      this.presentation.furiganaStyle,
    );
  }

  private refreshFurigana() {
    let index = -1;
    this.book?.spine.each((section: { document?: Document }) => {
      index++;
      if (section.document) this.furiganaDocument(section.document, index);
    });
    for (const contents of (this.rendition?.getContents() ?? []) as unknown as EpubPageContents[])
      this.furiganaDocument(contents.document, contents.sectionIndex ?? -1);
  }

  getImageBlurBoundary() {
    return this.fixedLayout
      ? ("fixed-layout" as const)
      : this.blurBoundary
        ? ("available" as const)
        : ("unavailable" as const);
  }

  private blurDocument(document: Document, spineIndex: number) {
    this.imageBlur.apply(
      document,
      spineIndex,
      this.presentation.blurImage,
      this.presentation.blurMode,
      this.blurBoundary,
    );
  }

  private refreshImageBlur() {
    if (!this.book || !this.rendition || this.disposed) return;
    let index = -1;
    this.book.spine.each((section: { document?: Document }) => {
      index++;
      if (section.document) this.blurDocument(section.document, index);
    });
    for (const contents of this.rendition.getContents() as unknown as EpubPageContents[])
      this.blurDocument(contents.document, contents.sectionIndex ?? -1);
  }
  private lastSpineIndex = 0;
  private firstSpineIndex = -1;
  private linearSections = 0;
  private presentation = normalizePresentation(undefined);
  /** Whether the rendition scrolls through the book rather than turning pages. */
  private continuous = false;
  /** Whether a continuous book scrolls through one chapter at a time. */
  private chapterView = false;
  private requestedVn = false;
  private vnStarts?: Promise<ChapterStart[]>;
  private vnBlockCache = new WeakMap<Document, VnBlock[]>();
  private vnReveal = new VnReveal(() => {
    void this.refreshPageTurns();
  });
  private get vnView() {
    return this.presentation.viewMode === "vn";
  }
  private blocks(document: Document): VnBlock[] {
    let blocks = this.vnBlockCache.get(document);
    if (!blocks) {
      blocks = vnBlocks(document);
      this.vnBlockCache.set(document, blocks);
    }
    return blocks;
  }
  revealVnText(): void {
    this.vnReveal.finish();
  }
  private updateVnReveal(): void {
    const start = this.shownChapter === undefined ? undefined : this.chapters[this.shownChapter];
    const document =
      start && this.rendition && sectionContents(this.rendition, start.spineIndex)?.document;
    if (!this.vnView || !document || !start || !this.host) {
      this.vnReveal.clear();
      return;
    }
    const revealing = this.vnReveal.revealing;
    const end = this.chapters[(this.shownChapter ?? 0) + 1];
    const blocks = this.blocks(document);
    const elements = blocks
      .slice(
        start.blockIndex ?? 0,
        end?.spineIndex === start.spineIndex ? end.blockIndex : undefined,
      )
      .map((block) => block.element);
    this.vnReveal.start(
      `${start.spineIndex}:${start.blockIndex ?? 0}`,
      elements,
      this.presentation.vnTextSpeed,
      this.host.ownerDocument,
    );
    // The Reader's Show all text, click and Space follow the reveal at once.
    if (this.vnReveal.revealing !== revealing) void this.refreshPageTurns();
  }
  /** Where the book's chapters begin, found once per book, and once found. */
  private chapterStarts?: Promise<ChapterStart[]>;
  private chapters: ChapterStart[] = [];
  /** The chapter a chapter view shows, as an index into its chapter starts. */
  private shownChapter?: number;
  /** Sections collapsed outside the shown chapter, and how much of each is clipped before it. */
  private collapsedViews = new WeakSet<Element>();
  private clippedStarts = new WeakMap<Element, number>();
  /** Each section's shown extent along the reading order as last measured. */
  private sectionExtents = new WeakMap<Element, number>();
  /** The views a continuous book lays out again, which fit their text once all are sized. */
  private deferredExpansions?: Set<EpubView>;
  /** A continuous book's reading area and its size, until it resizes. */
  private areaSize?: { element: HTMLElement; clientWidth: number; clientHeight: number };
  private areaObserver?: { element: HTMLElement; observer: ResizeObserver };
  /** Whether a continuous book has too many sections to keep them all loaded. */
  private limitsLoadedSections = false;
  /** Loaded sections whose content hooks have run, which a long book may release. */
  private renderedViews = new WeakSet<EpubView>();
  /** The section a continuous book was last asked to show, kept loaded with those near it. */
  private keptSection?: number;
  /**
   * While a continuous book opens, the spine indexes EPUB.js adds its sections within, so
   * the reading point shows without the whole book laid out first.
   */
  private openingSections?: { from: number; to: number };
  /** The rest of a continuous book loading after it shows, until it has. */
  private sectionsLoading?: Promise<void>;
  /**
   * Whether the book is vertical: declared in its package, or found in a section EPUB.js
   * rendered vertically. A continuous book scrolls along one axis for all its sections.
   */
  private bookVertical = false;
  /** Continuous sections of both axes were shown before the book was found vertical. */
  private axisConflict = false;
  /** The book's section hooks before any rendition added its own. */
  private sectionHooks: unknown[] = [];
  /** The last published reading point, which a scroll keeping it in view does not change. */
  private published?: { spineIndex: number; progress: number };
  private scrollContainer?: HTMLElement;
  private sectionSizes?: ResizeObserver;
  private scrollTimer?: ReturnType<typeof setTimeout>;
  /** Listeners of the Reader's own scrollbar, and the sizes that change its extent. */
  private scrollWatchers = new Set<() => void>();
  private scrollExtent?: ResizeObserver;
  /** The book's font-weight and text-indent rules for each section document, in cascade order. */
  private styleRules = new WeakMap<Document, StyleRule[]>();
  /** Each of the book's stylesheets, read and parsed once, by archive path. */
  private stylesheets = new Map<string, Promise<Stylesheet | undefined>>();
  /** The point kept across consecutive presentation changes, until the next turn or jump. */
  private reflowAnchor?: ReflowAnchor;
  /** The first character of the last settled page, which a change of host size keeps. */
  private settledAnchor?: ReflowAnchor;
  private restoreAxis?: () => void;
  /** The latest presentation requested while a host reflow was laying the book out. */
  private skippedPresentation?: ReaderPresentation;
  /** The host size the book was last laid out and positioned for. */
  private anchoredSize?: { width: number; height: number };
  private hostObserver?: ResizeObserver;
  private hostSizeTimer?: ReturnType<typeof setTimeout>;
  private ready = false;
  private turnPending = false;
  private layoutPending = false;
  /** Counts EPUB.js's resizes, so only the latest one's display ends its layout. */
  private resizeRevision = 0;
  /** EPUB.js has shown its own location after a window resize since the host was followed. */
  private resizeDisplaced = false;
  private locationRevision = 0;
  private onRelocated = () => {
    this.layoutPending = false;
    void this.refreshPageTurns();
  };
  private onResized = () => {
    this.areaSize = undefined;
    this.invalidateSelection();
    // EPUB.js follows a window resize to its own location, a paragraph start that can
    // lie pages earlier. The book returns to its settled reading point once the host's
    // size settles.
    this.layoutPending = true;
    this.resizeDisplaced = true;
    this.locationRevision++;
    this.onPageTurnsChanged?.(unavailable);
    void this.endResizeLayout(++this.resizeRevision);
    // Even when the host's size is followed already, or is back to the one followed.
    this.scheduleHostSize();
  };

  constructor(private readonly catalogId: string) {}

  async mount(
    host: HTMLElement,
    signal: AbortSignal,
    onPageTurnsChanged: (availability: ReaderPageTurnAvailability) => void,
    onContentDocument?: (document: Document) => void,
    onContentsChanged?: (entries: ReaderContentsEntry[]) => void,
    position?: ReaderPositionBinding,
    onProgressChanged?: (progress: ReaderBookProgress) => void,
    presentation?: ReaderPresentation,
    onSelectionChanged?: (selection: ReaderSelection | null) => void,
  ): Promise<ReaderMountResult> {
    this.host = host;
    this.onSelectionChanged = onSelectionChanged;
    this.requestedVn = presentation?.viewMode === "vn";
    this.presentation = normalizePresentation(presentation);
    this.onPageTurnsChanged = onPageTurnsChanged;
    this.onContentDocument = onContentDocument;
    this.onLocationChanged = position?.onLocationChanged;
    this.onProgressChanged = onProgressChanged;
    this.onContentsChanged = onContentsChanged;
    onPageTurnsChanged(unavailable);
    const access = await prepareReaderContent(this.catalogId);
    if (signal.aborted || this.disposed) return "error";
    if (access.status !== "ready") {
      switch (access.status) {
        case "missing":
        case "unknown":
          return "missing";
        case "unreadable":
        case "invalid":
        case "tooLarge":
          return access.status;
        default:
          return "error";
      }
    }

    this.contentUrl = access.url;
    const request = new AbortController();
    this.request = request;
    signal.addEventListener("abort", () => request.abort(), { once: true });
    if (signal.aborted) request.abort();

    let book: Book | undefined;
    try {
      // The UUID URL has no .epub suffix, so tell EPUB.js explicitly that it is an archive.
      // Only this exact URL is requested: it lists the archive's entries, which the native
      // archive then reads under it as EPUB.js asks for them.
      book = ePub({
        openAs: "epub",
        replacements: "blobUrl",
        requestMethod: async (url: string) => {
          if (url !== access.url) throw new Error("Unexpected EPUB request");
          return openNativeArchive(url, request.signal);
        },
      });
      this.book = book;
      installNativeArchive(book as unknown as Parameters<typeof installNativeArchive>[0]);
      installEpubTolerance(book as unknown as Parameters<typeof installEpubTolerance>[0]);
      await book.open(access.url, "epub");
      await book.opened;
      if (signal.aborted || this.disposed) return "error";
      await validateEpubSpine(book as unknown as Parameters<typeof validateEpubSpine>[0], signal);
      if (signal.aborted || this.disposed) return "error";

      // Navigation values stay in this adapter; React receives session-local IDs only.
      const navigation = await book.loaded.navigation.catch(() => undefined);
      if (signal.aborted || this.disposed) return "error";
      const fromNavigation = await this.normalizeContents(navigation?.toc, book, navigation);
      let contents = fromNavigation.entries;
      const packaging = (book as unknown as { package?: { navPath?: string; ncxPath?: string } })
        .package;
      if (
        (fromNavigation.leadsNowhere || !this.destinations.size) &&
        packaging?.navPath &&
        packaging.ncxPath
      ) {
        // EPUB.js reads only an EPUB 3 book's navigation document. One that is missing,
        // unreadable or names a file the book lacks, as an editor's unfinished placeholder
        // does, leaves its EPUB 2 NCX to list the contents when that leads to more places.
        const ncx = await (
          book as unknown as { loadNavigation(packaging: object): Promise<{ toc?: unknown }> }
        )
          .loadNavigation({ ...packaging, navPath: "" })
          .catch(() => undefined);
        if (signal.aborted || this.disposed) return "error";
        const destinations = this.destinations;
        this.destinations = new Map();
        const listed = await this.normalizeContents(ncx?.toc, book, navigation, packaging.ncxPath);
        if (this.destinations.size > destinations.size) contents = listed.entries;
        else this.destinations = destinations;
      }
      this.contents = contents;
      const collectLabels = (entries: ReaderContentsEntry[]) => {
        for (const entry of entries) {
          this.searchLabels.set(entry.id, entry.label);
          collectLabels(entry.children);
        }
      };
      collectLabels(contents);
      if (signal.aborted || this.disposed) return "error";
      for (const [entryId, destination] of this.destinations) {
        const target = book.spine.get(destination);
        if (!target) continue;
        const anchors = this.headingTargets.get(target) ?? new Map<string, string[]>();
        this.headingTargets.set(target, anchors);
        const fragment = destination.split("#")[1] ?? "";
        const label = this.searchLabels.get(entryId);
        anchors.set(fragment, [...(anchors.get(fragment) ?? []), ...(label ? [label] : [])]);
      }
      this.blurBoundary = this.destinations.size
        ? await spineTocBoundary(book, navigation)
        : undefined;
      if (signal.aborted || this.disposed) return "error";
      onContentsChanged?.(contents);

      const initial = await firstDisplayableSection(book, signal);
      let spineIndex = -1;
      book.spine.each((section: { linear?: boolean }) => {
        spineIndex += 1;
        if (section.linear) {
          if (this.firstSpineIndex < 0) this.firstSpineIndex = spineIndex;
          this.lastSpineIndex = spineIndex;
          this.linearSections++;
        }
      });
      if (signal.aborted || this.disposed) return "error";
      if (!initial) throw new Error("No readable section");

      const writingMode = await declaredWritingMode(book);
      const { package: opf, displayOptions } = book as unknown as {
        package?: { metadata?: { direction?: string; layout?: string } };
        displayOptions?: { fixedLayout?: string };
      };
      const metadata = opf?.metadata;
      this.bookDirection = metadata?.direction === "rtl" ? "rtl" : "ltr";
      this.bookForwardArrow =
        writingMode === "vertical-rl" || this.bookDirection === "rtl" ? "ArrowLeft" : "ArrowRight";
      // EPUB.js lays out pre-paginated pages from either declaration.
      this.fixedLayout =
        metadata?.layout === "pre-paginated" || displayOptions?.fixedLayout === "true";
      this.presentation = this.normalize(presentation);
      this.continuous = this.presentation.viewMode !== "paginated";
      this.chapterView = this.presentation.viewMode === "semi-continuous" || this.vnView;
      this.bookVertical = !!writingMode;
      if (signal.aborted || this.disposed) return "error";
      if (writingMode) {
        // EPUB.js measures <html> rather than a vertically styled <body> for
        // every displayed section. Keep that axis correct after TOC jumps too.
        book.spine.hooks.content.register((document: Document) => {
          document.documentElement.style.writingMode = writingMode;
        });
      }
      // Each section is styled before EPUB.js lays it out, so it opens on the right page.
      // EPUB.js waits for the book's font-weight and text-indent rules before it
      // serializes the section.
      const opened = book;
      book.spine.hooks.content.register(
        (document: Document, section?: { url?: string; index?: number; document?: Document }) => {
          const headingImages = this.fixedLayout
            ? []
            : applyHeadingCentering(document, this.headingTargets.get(section));
          if (!this.fixedLayout) applyBookImageLayout(document);
          else fillFixedSvgPage(document);
          applyPresentation(document, this.sectionPresentation());
          let index = section?.index ?? -1;
          if (index < 0) {
            let ordinal = -1;
            book!.spine.each((candidate: { document?: Document }) => {
              ordinal++;
              if (candidate === section || candidate.document === document) index = ordinal;
            });
          }
          this.blurDocument(document, index);
          this.furiganaDocument(document, index);
          this.styleSectionDocument(document, index);
          return Promise.all([
            this.collectStyleRules(opened, document, section?.url).then((rules) => {
              if (this.disposed) return;
              this.styleRules.set(document, rules);
              applyBookStyles(document, rules, this.sectionPresentation());
            }),
            this.centerHeadingInk(opened, headingImages, section?.url),
          ]);
        },
      );
      this.sectionHooks = [...sectionHookList(book)];

      const rendition = await this.render(book, host);
      if (signal.aborted || this.disposed) return "error";
      const saved = normalizeReaderLocator(await position?.initial.catch(() => null));
      if (signal.aborted || this.disposed) return "error";
      // A missing, stale, or unresolvable position quietly opens the authored start.
      let opening: ReflowAnchor | undefined = saved ?? undefined;
      if (saved) await this.limitOpening(book, saved.spineIndex);
      if (!saved || !(await this.restore(rendition, book, saved))) {
        if (signal.aborted || this.disposed) return "error";
        const index = (book.spine.get(initial) as { index?: number } | null)?.index;
        await this.limitOpening(book, index);
        if (signal.aborted || this.disposed) return "error";
        await rendition.display(initial);
        opening = index === undefined ? undefined : { spineIndex: index, progress: 0 };
        if (this.continuous && index !== undefined) await this.showSectionStart(rendition, index);
      }
      // The book was found vertical only after sections of the other axis were shown.
      if (this.axisConflict && opening) await this.redisplay(rendition, book, opening);
      if (signal.aborted || this.disposed) return "error";
      this.registerContentDocuments();
      if (signal.aborted || this.disposed) return "error";
      await this.refreshPageTurns();
      this.ready = true;
      this.updateVnReveal();
      await this.refreshPageTurns();
      this.observeHost(host);
      this.loadRemainingSections();
      // The book-wide count runs after the first page is visible and never blocks a turn.
      if (onProgressChanged || onContentsChanged) void this.countProgress(book);
      return "ready";
    } catch (error) {
      if (!this.disposed) {
        this.dispose();
        book = undefined;
      }
      return error instanceof EpubResourceLimit
        ? "tooLarge"
        : error instanceof InvalidEpubDocument
          ? "invalid"
          : "error";
    } finally {
      // An in-flight EPUB.js operation may settle after disposal. Release anything
      // it created after the first cleanup and remove any late iframe mount.
      if (this.disposed) {
        if (book) releaseBook(book);
        host.replaceChildren();
        this.sectionHooks = [];
      }
    }
  }

  /**
   * Render the book into the host in the current view mode: EPUB.js's paginated view
   * manager, or its continuous one, which scrolls through the sections, of the whole book
   * or of one chapter at a time.
   */
  private async render(book: Book, host: HTMLElement): Promise<Rendition> {
    const options = {
      width: "100%",
      height: "100%",
      // EPUB.js's iframe sandbox excludes scripts and popups by default.
      allowScriptedContent: false,
      ...(!this.continuous &&
        this.presentation.pageLayout && {
          spread: this.presentation.pageLayout === "single" ? "none" : "auto",
        }),
      // Paginated pages a reflowable book whatever rendition:flow it declares, which EPUB.js
      // would otherwise take; fixed-layout pages keep their own layout.
      ...(!this.continuous && !this.fixedLayout && { flow: "paginated" }),
      // A continuous book lays out every linear section as it opens and keeps them all,
      // so it scrolls the whole book at its full length: EPUB.js adds sections within
      // its offset of the reading area and removes those beyond it.
      ...(this.continuous && {
        manager: "continuous",
        flow: "scrolled",
        offset: Number.POSITIVE_INFINITY,
        // Its images take the reading area's size limits (see sizeContinuousImages), so
        // EPUB.js does not lay each section out to limit them to the section.
        limitImages: false,
        // A section that changes size lays out its group of views and the groups rather
        // than every section of the book.
        groupViews: CONTINUOUS_VIEW_GROUP,
      }),
    };
    // EPUB.js copies each option's descriptor, so it reads the gap afresh on every
    // layout, including after a window resize.
    // EPUB.js measures the host as its view manager attaches and sizes its views to it,
    // so a paginated book rendered after a continuous vertical one must not keep that
    // book's inset, which would leave its pages' last lines outside the narrower views.
    this.applyHostHeight();
    this.applyHostInset();
    Object.defineProperty(options, "gap", {
      get: () => this.pageGap(),
      configurable: true,
      enumerable: true,
    });
    const rendition = book.renderTo(host, options);
    this.rendition = rendition;
    await rendition.started;
    // EPUB.js attaches its view manager to the host next, in its queue.
    await (rendition as unknown as EpubManager).q?.enqueue(() => undefined);
    if (this.disposed) return rendition;
    this.followAxis();
    this.followPageLayout();
    this.followSectionDirection();
    if (!this.continuous) {
      this.followTurnHandover();
      this.followLocationReuse();
      this.followImageSpreads();
      if (this.fixedLayout) this.followFixedSpreads();
    }
    this.followWritingMode();
    if (this.continuous) this.followScrolling(rendition);
    this.applyHostInset();
    rendition.hooks?.content?.register(async (contents: EpubPageContents) => {
      if (this.disposed) return;
      if (!this.continuous && !this.fixedLayout) pageTextWidth(contents);
      this.restyleIfStale(contents, false);
      await waitForReaderFonts(contents.document, this.sectionPresentation());
      if (!this.disposed) contents.resizeCheck?.();
    });
    rendition.on("relocated", this.onRelocated);
    rendition.on("resized", this.onResized);
    rendition.on("rendered", this.onRendered);
    return rendition;
  }

  /**
   * Replace the rendition with one in the current view mode. Its sections render afresh
   * from the book's section documents, which keep their presentation.
   */
  private async renderAgain(book: Book, host: HTMLElement): Promise<Rendition> {
    const previous = this.rendition;
    previous?.off("relocated", this.onRelocated);
    previous?.off("resized", this.onResized);
    previous?.off("rendered", this.onRendered);
    this.vnReveal.clear();
    this.releaseScrolling();
    this.releaseHeldViews?.();
    this.shownChapter = undefined;
    try {
      previous?.destroy();
    } finally {
      host.replaceChildren();
    }
    // Each rendition adds its own section hooks; keep only the new one's.
    const hooks = sectionHookList(book);
    hooks.splice(0, hooks.length, ...this.sectionHooks);
    const rendition = await this.render(book, host);
    this.restyleSections(book, rendition);
    return rendition;
  }

  async advancePage(): Promise<void> {
    await this.turnPage("advance");
  }

  async retreatPage(): Promise<void> {
    await this.turnPage("retreat");
  }

  private bookmarkSections = new Map<
    number,
    Promise<{ contentKey: string; text: string } | null>
  >();

  private searchRevision = 0;
  private imageRevision = 0;
  private imageDestinations = new Map<
    string,
    { spineIndex: number; ordinal: number; base: string; element: Element; signal: AbortSignal }
  >();
  private imageUrls = new Set<string>();
  private imageCatalog: ReaderImages | null = null;
  private imageLoads = new Set<AbortController>();
  private imageReads = 0;

  /** Check the declared entry size before reading image or section payloads. */
  private checkImageEntry(path: string, limit: number) {
    const zip = (
      this.book?.archive as unknown as {
        zip?: { file(path: string): { _data?: { uncompressedSize?: number } } | null };
      }
    )?.zip;
    if (!zip) return;
    const entry = zip.file(decodeURIComponent(path.replace(/^\//, "")));
    if (!entry || (entry._data?.uncompressedSize ?? 0) > limit)
      throw Error("Image entry unavailable");
  }

  async listImages(signal: AbortSignal): Promise<ReaderImages> {
    const book = this.book;
    if (!book || !this.ready || this.disposed || signal.aborted) throw Error("Images unavailable");
    const revision = ++this.imageRevision;
    this.imageCatalog = null;
    this.imageDestinations.clear();
    const check = () => {
      if (this.disposed || signal.aborted || revision !== this.imageRevision)
        throw Error("Images cancelled");
    };
    const sections: Array<{ linear?: boolean; url?: string }> = [];
    book.spine.each((section: (typeof sections)[number]) => sections.push(section));
    const result: ReaderImages = { items: [], truncated: false, failedSections: 0 };
    let bytes = 0;
    for (const [spineIndex, section] of sections.entries()) {
      check();
      if (!section.linear || !section.url) continue;
      if (spineIndex >= 2000) {
        result.truncated = true;
        break;
      }
      try {
        this.checkImageEntry(section.url, IMAGE_DOCUMENT_BYTES);
        const document = (await book.load(section.url)) as Document;
        check();
        if (!document?.documentElement) throw Error("Image section unavailable");
        bytes += new XMLSerializer().serializeToString(document.documentElement).length;
        if (bytes > 32_000_000) {
          result.truncated = true;
          break;
        }
        for (const [ordinal, element] of imageElements(document).entries()) {
          if (result.items.length === IMAGE_LIMIT) {
            result.truncated = true;
            this.imageCatalog = result;
            return result;
          }
          const id = `image-${revision}-${result.items.length}`;
          this.imageDestinations.set(id, {
            spineIndex,
            ordinal,
            base: section.url,
            element,
            signal,
          });
          // The chapter is the last contents entry at or before the image: one in its own
          // section whose anchor precedes it, else the last in the nearest earlier section.
          let label = i18n().t("reader.section", { number: spineIndex + 1 });
          let labelSection = -1;
          for (const [entryId, destination] of this.destinations) {
            const index = sections.indexOf(
              book.spine.get(destination) as (typeof sections)[number],
            );
            if (index < 0 || index > spineIndex || index < labelSection) continue;
            if (index === spineIndex) {
              const fragment = destination.split("#")[1];
              let anchor: Element | null = null;
              try {
                if (fragment) anchor = document.getElementById(decodeURIComponent(fragment));
              } catch {
                /* An invalid authored fragment keeps the earlier label. */
              }
              if (
                fragment &&
                !(
                  anchor &&
                  (anchor === element ||
                    !!(anchor.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))
                )
              )
                continue;
            }
            label = this.searchLabels.get(entryId) ?? label;
            labelSection = index;
          }
          result.items.push({ id, alt: imageAlt(element), label, section: spineIndex + 1 });
        }
      } catch {
        check();
        result.failedSections++;
      }
      await nextTask();
    }
    check();
    this.imageCatalog = result;
    return result;
  }

  async imageAt(element: Element, signal: AbortSignal) {
    const contents = (
      this.rendition?.getContents() as unknown as EpubPageContents[] | undefined
    )?.find((item) => item.document === element.ownerDocument);
    if (!contents || contents.sectionIndex === undefined) return null;
    const ordinal = imageElements(element.ownerDocument).indexOf(element);
    if (ordinal < 0) return null;
    if (signal.aborted || this.disposed) throw Error("Images cancelled");
    // A direct click while the gallery is open must not invalidate its card IDs,
    // pending thumbnails or later location actions by starting another discovery.
    const cached = this.imageCatalog;
    const result =
      cached &&
      cached.items.every((item) => {
        const destination = this.imageDestinations.get(item.id);
        return destination && !destination.signal.aborted;
      })
        ? cached
        : await this.listImages(signal);
    if (signal.aborted || this.disposed) return null;
    const index = result.items.findIndex((item) => {
      const place = this.imageDestinations.get(item.id);
      return place?.spineIndex === contents.sectionIndex && place?.ordinal === ordinal;
    });
    return index < 0 ? null : { items: result.items, index };
  }

  async loadImage(
    id: string,
    size: "thumbnail" | "viewer",
    signal: AbortSignal,
  ): Promise<ReaderImageResource> {
    const destination = this.imageDestinations.get(id);
    if (
      !destination ||
      destination.signal.aborted ||
      this.disposed ||
      signal.aborted ||
      (size !== "thumbnail" && size !== "viewer")
    )
      throw Error("Image unavailable");
    const controller = new AbortController();
    this.imageLoads.add(controller);
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    destination.signal.addEventListener("abort", abort, { once: true });
    const check = () => {
      if (
        controller.signal.aborted ||
        this.disposed ||
        this.imageDestinations.get(id) !== destination
      )
        throw Error("Image cancelled");
    };
    let totalBytes = 0;
    const read = async (href: string, base: string): Promise<Blob> => {
      check();
      const path = imageArchivePath(href, base);
      if (!path) throw Error("Image resource unavailable");
      this.checkImageEntry(path, IMAGE_BYTES);
      const blob = await this.book?.archive.request(path, "blob");
      check();
      if (!(blob instanceof Blob) || (totalBytes += blob.size) > IMAGE_BYTES)
        throw Error("Image resource limit");
      return blob;
    };
    const raster = async (blob: Blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      check();
      const type = rasterType(bytes);
      if (!type) throw Error("Image format unavailable");
      return new Blob([bytes], { type });
    };
    // A drawing that only frames one picture, as books wrap their illustrations, copies
    // and saves as that picture at its own resolution.
    let framed: Blob | undefined;
    const svg = (element: Element, base: string) => {
      const single =
        element.querySelectorAll("image").length === 1 && !element.querySelector(SVG_DRAWING);
      return inertSvg(element, async (href) => {
        const blob = await raster(await read(href, base));
        if (single) framed = blob;
        // A tiny SVG viewBox can wrap a huge raster. Bound that raster's decoded
        // dimensions too, while keeping its original bytes for sharp zooming.
        await renderBookImage(blob, "viewer", controller.signal);
        check();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        check();
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return `data:${blob.type};base64,${btoa(binary)}`;
      });
    };
    let reading = false;
    try {
      while (this.imageReads >= 3) {
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
        check();
      }
      check();
      this.imageReads++;
      reading = true;
      let blob: Blob;
      if (destination.element.localName === "svg")
        blob = await svg(destination.element, destination.base);
      else {
        const href = destination.element.getAttribute("src") ?? "";
        const input = await read(href, destination.base);
        const prefix = await input.slice(0, 512).text();
        check();
        if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(prefix)) {
          if (input.size > IMAGE_DOCUMENT_BYTES) throw Error("Drawing limit");
          const document = new DOMParser().parseFromString(await input.text(), "image/svg+xml");
          if (document.querySelector("parsererror")) throw Error("Drawing unavailable");
          blob = await svg(document.documentElement, imageArchivePath(href, destination.base)!);
        } else blob = await raster(input);
      }
      check();
      const rendered = await renderBookImage(blob, size, controller.signal);
      check();
      const url = URL.createObjectURL(rendered.blob);
      this.imageUrls.add(url);
      return { url, width: rendered.width, height: rendered.height, blob: framed ?? rendered.blob };
    } finally {
      if (reading) this.imageReads--;
      this.imageLoads.delete(controller);
      signal.removeEventListener("abort", abort);
      destination.signal.removeEventListener("abort", abort);
    }
  }

  releaseImage(url: string): void {
    if (this.imageUrls.delete(url)) URL.revokeObjectURL(url);
  }

  async goToImage(id: string, signal: AbortSignal): Promise<boolean> {
    if (this.sectionsLoading) await this.sectionsLoaded();
    const destination = this.imageDestinations.get(id);
    const book = this.book;
    const rendition = this.rendition;
    const valid = () =>
      !this.disposed &&
      !signal.aborted &&
      !!destination &&
      !destination.signal.aborted &&
      this.imageDestinations.get(id) === destination;
    if (!book || !rendition || !this.ready || !valid() || this.turnPending || this.layoutPending)
      return false;
    this.turnPending = true;
    this.invalidateSelection();
    this.onPageTurnsChanged?.(unavailable);
    try {
      const section = book.spine.get(destination!.spineIndex) as { href?: string } | null;
      if (!section?.href) return false;
      const relocation = this.waitForRelocation(rendition);
      await rendition.display(section.href);
      if (!valid()) return false;
      if (this.continuous) await this.managerSettled();
      if (!valid()) return false;
      const contents = sectionContents(rendition, destination!.spineIndex);
      const image = contents && imageElements(contents.document)[destination!.ordinal];
      if (!contents || !image) return false;
      this.jumpedEntryId = undefined;
      this.reflowAnchor = undefined;
      if (this.continuous) await this.scrollToPoint(contents, image, valid);
      else {
        const range = contents.document.createRange();
        range.selectNode(image);
        range.collapse(true);
        await this.displayPoint(rendition, contents, range, section.href, relocation, valid);
      }
      if (!valid()) return false;
      await this.refreshPageTurns();
      await this.publishLocation(undefined, valid);
      return valid();
    } catch {
      return false;
    } finally {
      this.turnPending = false;
      if (!this.disposed) await this.refreshPageTurns();
    }
  }
  private releaseSearch?: () => void;
  private searchDestinations = new Map<
    string,
    { spineIndex: number; offset: number; text: string; signal: AbortSignal }
  >();

  async searchBook(
    value: string,
    scope: ReaderSearchScope,
    signal: AbortSignal,
  ): Promise<ReaderSearchResults> {
    const revision = ++this.searchRevision;
    this.releaseSearch?.();
    this.searchDestinations.clear();
    const query = searchQuery(value);
    const book = this.book;
    const valid = () => !this.disposed && !signal.aborted && this.searchRevision === revision;
    const check = () => {
      if (!valid()) throw Error("Search cancelled");
    };
    if (
      !book ||
      !this.ready ||
      !query ||
      [...query].length > SEARCH_QUERY_LIMIT ||
      (scope !== "book" && scope !== "chapter")
    )
      throw Error("Search unavailable");
    check();
    const abort = () => {
      if (this.searchRevision === revision) this.searchDestinations.clear();
    };
    signal.addEventListener("abort", abort, { once: true });
    this.releaseSearch = () => signal.removeEventListener("abort", abort);
    let start: ChapterStart | undefined;
    let end: ChapterStart | undefined;
    if (scope === "chapter") {
      // Snapshot the real chapter at submission, including multiple anchors in one section.
      if (this.turnPending || this.layoutPending) throw Error("Navigation pending");
      const place = await this.displayedLocator();
      check();
      this.chapterStarts ??= this.findChapterStarts(book);
      const chapters = await this.chapterStarts;
      check();
      const contents =
        place && this.rendition && sectionContents(this.rendition, place.locator.spineIndex);
      const point = contents && place && pointAtProgress(contents.document, place.locator.progress);
      const index =
        contents && point
          ? chapterAt(chapters, place!.locator.spineIndex, contents.document, point)
          : undefined;
      if (index === undefined) throw Error("Chapter unavailable");
      start = chapters[index];
      end = chapters[index + 1];
    }
    const sections: Array<{ linear?: boolean; url?: string }> = [];
    book.spine.each((section: (typeof sections)[number]) => sections.push(section));
    const results: ReaderSearchResults = { matches: [], truncated: false };
    let totalText = 0;
    try {
      for (const [spineIndex, section] of sections.entries()) {
        if (
          !section.linear ||
          !section.url ||
          (start && spineIndex < start.spineIndex) ||
          (end && spineIndex > end.spineIndex)
        )
          continue;
        check();
        // Read original archive documents, with no appearance rules or resource rewrites.
        const document = (await book.load(section.url)) as Document;
        check();
        if (!document?.body) throw Error("Section unavailable");
        const mapped = searchText(document);
        totalText += mapped.text.length;
        if (totalText > 32_000_000) throw Error("Book search text limit");
        const from = start?.spineIndex === spineIndex ? mapped.anchorOffset(start.anchorId) : 0;
        const to =
          end?.spineIndex === spineIndex ? mapped.anchorOffset(end.anchorId) : mapped.text.length;
        for (const match of literalMatches(mapped.text.slice(from, to), query)) {
          if (results.matches.length === SEARCH_LIMIT) {
            results.truncated = true;
            return results;
          }
          const offset = from + match.index;
          const id = `search-${revision}-${results.matches.length}`;
          this.searchDestinations.set(id, { spineIndex, offset, text: match[0], signal });
          // Only authored labels and section ordinals cross the boundary, never hrefs.
          let label = i18n().t("reader.section", { number: spineIndex + 1 });
          let labelSection = -1;
          let labelOffset = -1;
          for (const [entryId, destination] of this.destinations) {
            const index = sections.indexOf(
              book.spine.get(destination) as (typeof sections)[number],
            );
            if (index < 0 || index > spineIndex || index < labelSection) continue;
            const fragment = destination.split("#")[1];
            let anchorOffset = 0;
            try {
              if (fragment && index === spineIndex)
                anchorOffset = mapped.anchorOffset(decodeURIComponent(fragment));
            } catch {
              continue;
            }
            if (index === spineIndex && anchorOffset > offset) continue;
            if (index === labelSection && anchorOffset < labelOffset) continue;
            label = this.searchLabels.get(entryId) ?? label;
            labelSection = index;
            labelOffset = anchorOffset;
          }
          results.matches.push({
            id,
            label,
            section: spineIndex + 1,
            ...matchExcerpt(mapped.text, offset, match[0].length),
          });
        }
        // Give input/query cancellation a turn between archive sections.
        await nextTask();
      }
      check();
      return results;
    } catch (error) {
      if (this.searchRevision === revision) this.searchDestinations.clear();
      throw error;
    }
  }

  locatorOffset(locator: ReaderLocator): { current: number; total: number } | undefined {
    const counts = this.progressCounts;
    if (!counts) return undefined;
    const current = fractionOffset(counts, locator.spineIndex, locator.progress);
    return current === undefined ? undefined : { current, total: counts.total };
  }

  private searchLabels = new Map<string, string>();
  private searchMatch?: { range: Range; clear: () => void; timer: ReturnType<typeof setTimeout> };

  /** Mark a search jump's match on its page for a moment, so the eye finds it there. */
  private markSearchMatch(document: Document, range: Range): void {
    this.clearSearchMatch();
    const clear = paintSearchMatch(document, textRanges(range), SEARCH_MATCH_MS);
    const timer = setTimeout(() => this.clearSearchMatch(), SEARCH_MATCH_MS);
    this.searchMatch = { range, clear, timer };
  }

  private clearSearchMatch(): void {
    if (!this.searchMatch) return;
    clearTimeout(this.searchMatch.timer);
    this.searchMatch.clear();
    this.searchMatch = undefined;
  }

  searchMatchRect(): ReaderRect | null {
    const range = this.searchMatch?.range;
    const frame = range?.startContainer.ownerDocument?.defaultView?.frameElement;
    if (!range || !frame?.isConnected) return null;
    return readerRangeRect(range, frame, this.host);
  }

  async goToSearchResult(id: string, signal: AbortSignal): Promise<boolean> {
    if (this.sectionsLoading) await this.sectionsLoaded();
    const destination = this.searchDestinations.get(id);
    const rendition = this.rendition;
    const book = this.book;
    const valid = () =>
      !this.disposed &&
      !signal.aborted &&
      !!destination &&
      !destination.signal.aborted &&
      this.searchDestinations.get(id) === destination;
    if (
      !destination ||
      !rendition ||
      !book ||
      !this.ready ||
      !valid() ||
      this.turnPending ||
      this.layoutPending
    )
      return false;
    this.turnPending = true;
    this.invalidateSelection();
    this.onPageTurnsChanged?.(unavailable);
    try {
      const section = book.spine.get(destination.spineIndex) as {
        href?: string;
        url?: string;
      } | null;
      if (!section?.href || !section.url) return false;
      const original = searchText((await book.load(section.url)) as Document);
      if (
        !valid() ||
        original.text.slice(destination.offset, destination.offset + destination.text.length) !==
          destination.text
      )
        return false;
      const relocation = this.waitForRelocation(rendition);
      await rendition.display(section.href);
      if (!valid()) return false;
      if (this.continuous) await this.managerSettled();
      if (!valid()) return false;
      const contents = sectionContents(rendition, destination.spineIndex);
      const mapped = contents && searchText(contents.document);
      const point = mapped?.point(destination.offset);
      if (
        !contents ||
        !point ||
        mapped?.text.slice(destination.offset, destination.offset + destination.text.length) !==
          destination.text
      )
        return false;
      this.jumpedEntryId = undefined;
      this.reflowAnchor = undefined;
      await this.displayPoint(rendition, contents, point, section.href, relocation, valid);
      if (!valid()) return false;
      await this.refreshPageTurns();
      if (!valid()) return false;
      await this.publishLocation(undefined, valid);
      if (!valid()) return false;
      const last = mapped?.point(destination.offset + destination.text.length - 1);
      if (last) {
        const match = point.cloneRange();
        match.setEnd(last.startContainer, last.startOffset + 1);
        this.markSearchMatch(contents.document, match);
      }
      return true;
    } catch {
      return false;
    } finally {
      this.turnPending = false;
      if (!this.disposed) await this.refreshPageTurns();
    }
  }

  private bookmarkSection(index: number) {
    const saved = this.bookmarkSections.get(index);
    if (saved) return saved;
    const book = this.book;
    const section = book?.spine.get(index) as { url?: string } | null;
    const result = (async () => {
      if (!book || !section?.url || this.disposed) return null;
      try {
        // Original archive document, unaffected by injected appearance or iframe/blob URLs.
        const document = (await book.load(section.url)) as Document;
        if (this.disposed || !document?.documentElement) return null;
        const source = new XMLSerializer().serializeToString(document.documentElement);
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
        if (this.disposed) return null;
        return {
          contentKey: [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
          text: readableText(document)
            .replace(/\s+/gu, " ")
            .replace(/\p{Cc}/gu, "")
            .trim(),
        };
      } catch {
        return null;
      }
    })();
    this.bookmarkSections.set(index, result);
    // A failed read is retryable.
    void result.then((value) => {
      if (!value) this.bookmarkSections.delete(index);
    });
    return result;
  }

  async captureBookmark(): Promise<ReaderBookmarkPlace | null> {
    if (!this.ready || this.disposed || this.turnPending || this.layoutPending) return null;
    const point = await this.displayedLocator();
    if (!point || this.disposed) return null;
    const section = await this.bookmarkSection(point.locator.spineIndex);
    if (
      !section ||
      this.disposed ||
      this.turnPending ||
      this.layoutPending ||
      !point.locator.sectionKey
    )
      return null;
    // The excerpt starts at the page's first displayed character, else at the text fraction.
    const pageStart = point.pageStart;
    const shown =
      pageStart?.spineIndex === point.locator.spineIndex
        ? readableText(pageStart.document)
            .slice(readableText(pageStart.document, pageStart).length)
            .replace(/\s+/gu, " ")
            .replace(/\p{Cc}/gu, "")
            .trim()
        : "";
    const text = [...(shown || section.text)];
    const start = shown ? 0 : Math.floor(point.locator.progress * text.length);
    return {
      locator: {
        ...point.locator,
        sectionKey: point.locator.sectionKey,
        contentKey: section.contentKey,
      },
      excerpt: text
        .slice(start, start + 160)
        .join("")
        .trim(),
    };
  }

  async captureNote(): Promise<NotePassage | null> {
    if (
      !this.ready ||
      this.disposed ||
      this.turnPending ||
      this.layoutPending ||
      !this.rendition ||
      !this.book
    )
      return null;
    const displayed = this.rendition.getContents() as unknown as EpubPageContents[];
    for (const contents of displayed) {
      const document = contents.document;
      const selection = document?.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed || contents.sectionIndex === undefined)
        continue;
      const range = selection.getRangeAt(0).cloneRange();
      if (!document.body?.contains(range.commonAncestorContainer)) continue;
      const passage = notePassage(range);
      const progress = textProgress(document, range.startContainer, range.startOffset);
      const section = this.book.spine.get(contents.sectionIndex) as { href?: string } | null;
      if (!passage || progress === null || !section?.href) return null;
      const revision = this.locationRevision;
      const original = await this.bookmarkSection(contents.sectionIndex);
      const current = document.getSelection();
      const currentRange = current?.rangeCount ? current.getRangeAt(0) : null;
      if (
        !original ||
        this.disposed ||
        this.turnPending ||
        this.layoutPending ||
        revision !== this.locationRevision ||
        !currentRange ||
        current?.isCollapsed ||
        currentRange.startContainer !== range.startContainer ||
        currentRange.startOffset !== range.startOffset ||
        currentRange.endContainer !== range.endContainer ||
        currentRange.endOffset !== range.endOffset ||
        notePassage(currentRange) !== passage ||
        !((this.rendition?.getContents() ?? []) as unknown as EpubPageContents[]).some(
          (item) => item.document === document,
        )
      )
        return null;
      return {
        passage,
        locator: {
          spineIndex: contents.sectionIndex,
          sectionKey: sectionKey(section.href),
          progress,
          contentKey: original.contentKey,
        },
      };
    }
    return null;
  }

  async goToBookmark(value: ReaderBookmarkLocator): Promise<boolean> {
    if (this.sectionsLoading) await this.sectionsLoaded();
    const locator = normalizeBookmarkLocator(value);
    const rendition = this.rendition;
    const book = this.book;
    if (
      !locator ||
      !rendition ||
      !book ||
      !this.ready ||
      this.disposed ||
      this.turnPending ||
      this.layoutPending
    )
      return false;
    this.turnPending = true;
    this.onPageTurnsChanged?.(unavailable);
    try {
      const section = book.spine.get(locator.spineIndex) as { href?: string } | null;
      if (!section?.href || sectionKey(section.href) !== locator.sectionKey) return false;
      const original = await this.bookmarkSection(locator.spineIndex);
      if (!original || original.contentKey !== locator.contentKey || this.disposed) return false;
      this.jumpedEntryId = undefined;
      this.reflowAnchor = undefined;
      if (!(await this.restore(rendition, book, locator, true)) || this.disposed) return false;
      await this.refreshPageTurns();
      await this.publishLocation();
      return !this.disposed;
    } catch {
      return false;
    } finally {
      this.turnPending = false;
      if (!this.disposed) await this.refreshPageTurns();
    }
  }

  async goToContentsEntry(entryId: string): Promise<boolean> {
    // A jump finds the rest of a continuous book laid out, as a book always shows whole.
    if (this.sectionsLoading) await this.sectionsLoaded();
    const rendition = this.rendition;
    const destination = this.destinations.get(entryId);
    if (!rendition || !destination || this.disposed || this.turnPending || this.layoutPending)
      return false;
    this.turnPending = true;
    this.jumpedEntryId = undefined;
    this.reflowAnchor = undefined;
    this.onPageTurnsChanged?.(unavailable);
    try {
      // EPUB.js resolves the authored href, including a fragment, in its own spine.
      const section = this.book?.spine.get(destination) as { index?: number } | null | undefined;
      if (!section) return false;
      const relocation = this.waitForRelocation(rendition);
      // A continuous book shows every section already and scrolls to the fragment itself.
      await rendition.display(this.continuous ? destination.split("#")[0] : destination);
      if (this.disposed) return false;
      if (this.continuous) await this.managerSettled();
      if (this.disposed) return false;
      const fragment = destination.split("#")[1];
      if (fragment) {
        // EPUB.js can display the section yet leave a vertical fragment at its
        // first page. Its CFI resolver uses the rendered heading's actual range.
        const id = decodeURIComponent(fragment);
        const shown = rendition.getContents() as unknown as EpubPageContents[];
        // A continuous book shows several sections, which can share IDs.
        const contents =
          shown.find(
            (item) => item.sectionIndex === section.index && item.document?.getElementById(id),
          ) ?? shown.find((item) => item.document?.getElementById(id));
        const anchor = contents?.document.getElementById(id);
        if (!contents || !anchor) return false;
        const range = contents.document.createRange();
        range.selectNodeContents(anchor);
        range.collapse(true);
        if (this.continuous && !anchor.textContent?.trim())
          await this.scrollToPoint(contents, anchor);
        else
          await this.displayPoint(
            rendition,
            contents,
            range,
            destination.split("#")[0],
            relocation,
          );
        if (this.disposed) return false;
      } else if (this.continuous && section.index !== undefined) {
        if (!(await this.showSectionStart(rendition, section.index)) || this.disposed) return false;
      }
      await this.refreshPageTurns();
      // The chosen entry stays current even when another entry shares its position.
      this.jumpedEntryId = entryId;
      await this.publishLocation(relocation);
      return true;
    } catch {
      return false;
    } finally {
      this.turnPending = false;
      if (!this.disposed) await this.refreshPageTurns();
    }
  }

  async setPresentation(presentation: ReaderPresentation): Promise<void> {
    const rendition = this.rendition;
    const book = this.book;
    this.requestedVn = presentation.viewMode === "vn";
    const next = this.normalize(presentation);
    if (!rendition || !book || !this.ready || this.disposed) return;
    // A host reflow is the adapter's own work, so the hook cannot wait for it. The
    // latest choice made meanwhile is applied when it ends.
    if (this.turnPending) {
      this.skippedPresentation = presentation;
      return;
    }
    this.skippedPresentation = undefined;
    if (sameLayout(next, this.presentation)) {
      if (sameStyle(next, this.presentation)) {
        await this.refreshPageTurns();
        return;
      }
      // A blur or recoloring changes no layout, so the book stays where it is and
      // publishes nothing.
      this.presentation = next;
      this.restyleSections(book, rendition);
      this.registerContentDocuments();
      this.updateVnReveal();
      await this.refreshPageTurns();
      return;
    }
    // A new layout lays out the whole of a continuous book, once the rest of it has loaded.
    if (this.sectionsLoading) {
      await this.sectionsLoaded();
      if (this.disposed) return;
      if (this.turnPending) {
        this.skippedPresentation = presentation;
        return;
      }
    }
    this.turnPending = true;
    this.invalidateSelection();
    this.onPageTurnsChanged?.(unavailable);
    try {
      // Repeated changes return to the same point rather than to each reflowed page's
      // first character, which would creep backwards with every larger size or spacing.
      const anchor = this.reflowAnchor ?? (await this.displayedAnchor());
      if (this.disposed) return;
      const marginChanged = next.sideMargin !== this.presentation.sideMargin;
      const heightChanged = next.maxHeight !== this.presentation.maxHeight;
      const widthChanged = next.maxWidth !== this.presentation.maxWidth;
      const pagesChanged = next.pageLayout !== this.presentation.pageLayout;
      const modeChanged = next.writingMode !== this.presentation.writingMode;
      const viewChanged = next.viewMode !== this.presentation.viewMode;
      const groupsChanged = next.vnParagraphs !== this.presentation.vnParagraphs;
      // Continuous and chapter views share EPUB.js's continuous view manager.
      const managerChanged =
        (next.viewMode === "paginated") !== (this.presentation.viewMode === "paginated");
      // A new writing mode or view manager renders the section afresh; read which one is
      // shown first.
      const shownIndex =
        modeChanged || managerChanged
          ? (anchor?.spineIndex ?? (await this.currentBookLocation(rendition))?.start?.index)
          : undefined;
      if (this.disposed) return;
      if (next.vnParagraphs !== this.presentation.vnParagraphs) this.vnStarts = undefined;
      this.vnReveal.clear();
      this.presentation = next;
      this.continuous = next.viewMode !== "paginated";
      this.chapterView = next.viewMode === "semi-continuous" || this.vnView;
      // A VN group is measured again after any reflow, as its size and centering change.
      if (viewChanged || groupsChanged || this.vnView) {
        // The chapter is found again at the reading point; until then the book shows whole.
        this.shownChapter = undefined;
        this.applyChapterBounds();
      }
      const displayed = this.restyleSections(book, rendition);
      this.registerContentDocuments();
      await Promise.all(displayed.map((contents) => waitForReaderFonts(contents.document, next)));
      if (this.disposed) return;
      const host = this.host;
      this.applyHostHeight();
      // Images fit the reading area the host now has, not the one they were styled for.
      for (const contents of displayed)
        this.styleSectionDocument(contents.document, contents.sectionIndex);
      if (managerChanged && host) {
        // EPUB.js's view manager is chosen with its rendition, so render the book again.
        const href =
          shownIndex === undefined
            ? undefined
            : (book.spine.get(shownIndex) as { href?: string } | null)?.href;
        const shown = await this.renderAgain(book, host);
        if (this.disposed) return;
        if (href) {
          const relocation = this.waitForRelocation(shown);
          await shown.display(href);
          if (!this.continuous) await this.navigatedLocation(shown, relocation);
          if (this.disposed) return;
        }
        if (!anchor && this.continuous && shownIndex !== undefined)
          await this.showSectionStart(shown, shownIndex);
        // A continuous book found vertical only now shows its sections again in one axis.
        if (this.axisConflict && anchor) await this.redisplay(shown, book, anchor);
        if (this.disposed) return;
      } else if (modeChanged) {
        // EPUB.js takes a section's axis from its root's writing mode only as it renders
        // the section, so show the section again, in the new page direction.
        this.manager()?.clear?.();
        // EPUB.js sizes new views to the host it last measured, so a continuous book
        // leaving or entering the vertical mode is measured again, without or with its
        // side inset and scrolling along its new axis, before its sections are shown.
        const insetChanged = this.applyHostInset();
        const axisChanged = this.followScrollAxis();
        if (insetChanged || axisChanged || heightChanged) this.layOutAgain();
        this.followWritingMode();
        const href =
          shownIndex === undefined
            ? undefined
            : (book.spine.get(shownIndex) as { href?: string } | null)?.href;
        if (href) {
          const relocation = this.waitForRelocation(rendition);
          await rendition.display(href);
          if (!this.continuous) await this.navigatedLocation(rendition, relocation);
          if (this.disposed) return;
        }
      } else {
        // Horizontal pages take their margins from EPUB.js's column gap, and a
        // continuous vertical book from the host's sides. A max height resizes the host.
        if (marginChanged || heightChanged || widthChanged || pagesChanged) {
          this.applyPageLayout();
          this.applyHostInset();
          this.layOutAgain();
          await this.matchImageSpread(rendition);
          if (this.disposed) return;
        }
        // EPUB.js would otherwise expand the view to the reflowed text a frame later. A
        // continuous book's views are measured together.
        if (this.continuous) {
          const documents = new Set(displayed.map((contents) => contents.document));
          this.expandViews(
            this.manager()
              ?.views?.all()
              .filter((view) => view.contents && documents.has(view.contents.document)) ?? [],
          );
        } else for (const contents of displayed) contents.resizeCheck?.();
      }
      // The book already follows the host's new height, so its observer has nothing to do.
      if ((heightChanged || widthChanged || pagesChanged) && host)
        this.anchoredSize = hostSize(host);
      const current = this.rendition ?? rendition;
      if (anchor) await this.displayAnchor(current, book, anchor);
      if (this.disposed) return;
      if (this.chapterView && this.shownChapter === undefined) await this.showReadingChapter();
      if (this.disposed) return;
      await this.refreshPageTurns();
      await this.publishLocation();
    } finally {
      this.turnPending = false;
      if (!this.disposed) await this.refreshPageTurns();
    }
    await this.applySkippedPresentation();
  }

  /** Apply the latest presentation requested while the book was being laid out. */
  private async applySkippedPresentation(): Promise<void> {
    const skipped = this.skippedPresentation;
    this.skippedPresentation = undefined;
    if (skipped && !this.disposed) await this.setPresentation(skipped);
  }

  /**
   * Style every section EPUB.js has loaded, which it renders again when revisited, and
   * every displayed one, with the current presentation. Returns the displayed sections.
   */
  private restyleSections(book: Book, rendition: Rendition): EpubPageContents[] {
    const shown = this.sectionPresentation();
    let index = -1;
    book.spine.each((section: { document?: Document }) => {
      index++;
      if (!section.document) return;
      this.blurDocument(section.document, index);
      applyPresentation(section.document, shown);
      this.furiganaDocument(section.document, index);
      this.styleSectionDocument(section.document, index);
      applyBookStyles(section.document, this.styleRules.get(section.document), shown);
    });
    const displayed = rendition.getContents() as unknown as EpubPageContents[];
    for (const contents of displayed) this.restyleContents(book, contents, shown);
    return displayed;
  }

  private restyleContents(
    book: Book,
    contents: EpubPageContents,
    shown: NormalizedPresentation,
  ): void {
    applyPresentation(contents.document, shown);
    this.furiganaDocument(contents.document, contents.sectionIndex ?? -1);
    this.blurDocument(contents.document, contents.sectionIndex ?? -1);
    this.styleSectionDocument(contents.document, contents.sectionIndex);
    // A displayed document is serialized from its section's, which holds the rules.
    const section =
      contents.sectionIndex === undefined
        ? null
        : (book.spine.get(contents.sectionIndex) as { document?: Document } | null);
    const rules =
      this.styleRules.get(contents.document) ??
      (section?.document ? this.styleRules.get(section.document) : undefined);
    applyBookStyles(contents.document, rules, shown);
  }

  /**
   * EPUB.js serializes a section as it starts rendering a view, and a continuous book
   * renders views as it scrolls. A view serialized before a presentation change but
   * loaded after it would keep the old presentation, so it is styled again as it is
   * rendered, and EPUB.js resizes it to its new text, unless the caller measures it next.
   * Its images are sized again for the displayed document, whose side padding the
   * section's own document lacks; only a changed presentation restyles it whole.
   */
  private restyleIfStale(contents: EpubPageContents | undefined, measure = true): void {
    const book = this.book;
    const root = contents?.document?.documentElement;
    if (!book || !contents || !root || this.disposed) return;
    const shown = this.sectionPresentation();
    const imageStyle = contents.document.querySelector(`style[${CONTINUOUS_IMAGE_STYLE}]`);
    const previousImageRule = imageStyle?.textContent;
    const previousPageRule = contents.document.querySelector(
      "style[data-komori-page-image-width]",
    )?.textContent;
    const previousFitRule = contents.document.querySelector(
      "style[data-komori-page-image-fit]",
    )?.textContent;
    this.styleSectionDocument(contents.document, contents.sectionIndex);
    const stale = root.getAttribute(PRESENTATION_ATTRIBUTE) !== presentationKey(shown);
    if (
      !stale &&
      previousImageRule ===
        contents.document.querySelector(`style[${CONTINUOUS_IMAGE_STYLE}]`)?.textContent &&
      previousPageRule ===
        contents.document.querySelector("style[data-komori-page-image-width]")?.textContent &&
      previousFitRule ===
        contents.document.querySelector("style[data-komori-page-image-fit]")?.textContent
    )
      return;
    if (stale) this.restyleContents(book, contents, shown);
    if (measure) contents.resizeCheck?.();
  }

  /** Size a section's images and show VN's pointer for the current presentation. */
  private styleSectionDocument(document: Document, index?: number): void {
    this.sizeContinuousImages(document, index);
    applyVnCursor(document, this.vnView && !this.fixedLayout);
  }

  /**
   * A continuous book's reading area, its size read once until it resizes. Each section
   * reads it as it is styled, and reading it just after another section was resized would
   * lay the whole book out again.
   */
  private readingArea(element: HTMLElement): { clientWidth: number; clientHeight: number } {
    if (this.areaSize?.element === element) return this.areaSize;
    const measure = () =>
      (this.areaSize = {
        element,
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
      });
    if (typeof ResizeObserver === "undefined") return element;
    if (this.areaObserver?.element !== element) {
      this.areaObserver?.observer.disconnect();
      // The observer reports a resize after layout, when reading the size costs nothing.
      const observer = new ResizeObserver(() => {
        if (this.areaSize?.element === element) measure();
      });
      observer.observe(element);
      this.areaObserver = { element, observer };
    }
    return measure();
  }

  /** A continuous section may be many screens tall, but its images fit one reading area. */
  private sizeContinuousImages(document: Document, index?: number): void {
    const element = this.scrollContainer ?? this.manager()?.container ?? this.host;
    const area = element && (this.continuous ? this.readingArea(element) : element);
    applyContinuousImageSizing(
      document,
      this.continuous && !this.fixedLayout ? area?.clientWidth : undefined,
      this.continuous && !this.fixedLayout ? area?.clientHeight : undefined,
    );
    // EPUB.js's horizontal columnWidth already excludes the gap. Its adjustImages()
    // subtracts body padding (the same gap) again, collapsing large-margin images.
    // Correct this width limit; fixed pages keep EPUB.js's sizing.
    const manager = this.manager();
    const width =
      !this.continuous &&
      !this.fixedLayout &&
      manager?.settings?.axis === "horizontal" &&
      this.presentation.sideMargin !== undefined
        ? manager.layout.columnWidth
        : undefined;
    if (!this.fixedLayout) {
      const horizontal = !document.documentElement.style.writingMode.startsWith("vertical");
      // An image page with no partner, such as the cover, is alone on its spread, so it
      // centers on the whole spread rather than on its first page beside a blank one.
      const alone =
        index !== undefined &&
        index >= 0 &&
        !this.continuous &&
        this.presentation.pageLayout === "double" &&
        manager?.settings?.axis === "horizontal" &&
        (manager.layout.divisor ?? 1) >= 2 &&
        this.imagePartner(index) === undefined;
      fitBookImagePage(
        document,
        horizontal
          ? this.continuous
            ? area?.clientWidth
            : ((alone ? manager?.layout.delta : manager?.layout.pageWidth) ?? area?.clientWidth)
          : !this.continuous
            ? area?.clientWidth
            : undefined,
        !this.continuous ? manager?.layout.height : horizontal ? area?.clientHeight : undefined,
        !this.continuous,
        // Semi-continuous view clears two em before a chapter's first section.
        this.continuous && this.chapterView && !this.vnView
          ? 2 * (this.presentation.fontSize ?? readerFontSize.default)
          : 0,
      );
    }
    let style = document.querySelector("style[data-komori-page-image-width]");
    if (!width || width <= 0) {
      style?.remove();
      return;
    }
    const rule = `:root body img, :root body svg { max-width: ${width}px !important; }`;
    if (style?.textContent === rule) return;
    if (!style) {
      style = document.createElementNS(XHTML_NAMESPACE, "style");
      style.setAttribute("data-komori-page-image-width", "");
      (document.head ?? document.documentElement).append(style);
    }
    style.textContent = rule;
  }

  /**
   * How each section is styled. A continuous book scrolls along one axis, so once it is
   * found vertical every section's root takes the vertical mode, and its left and right
   * margins lie at the reading area's sides rather than at each section's ends.
   */
  private sectionPresentation(): NormalizedPresentation {
    const shown =
      this.continuous && this.presentation.writingMode === undefined && this.bookVertical
        ? { ...this.presentation, rootWritingMode: "vertical" as const }
        : this.presentation;
    return this.scrollsHorizontally() ? { ...shown, sideMargin: undefined } : shown;
  }

  /** The chosen writing mode, or the vertical mode a continuous vertical book keeps. */
  private displayedMode(): ReaderWritingMode | undefined {
    return (
      this.presentation.writingMode ??
      (this.continuous && this.bookVertical ? "vertical" : undefined)
    );
  }

  /** Whether the book scrolls horizontally, as a continuous vertical book does. */
  private scrollsHorizontally(): boolean {
    return this.continuous && this.displayedMode() === "vertical";
  }

  /**
   * A continuous vertical book keeps its margin on the left and right of the reading
   * area, where its text scrolls in and out, up to a quarter of its width. The automatic
   * margin is EPUB.js's for the sides of a vertical page. The Reader's stylesheet pads
   * the host by the inset. Returns whether the inset changed.
   */
  private applyHostInset(): boolean {
    const style = this.host?.style;
    if (!style) return false;
    this.areaSize = undefined;
    const margin = this.presentation.sideMargin ?? VERTICAL_PAGE_MARGIN;
    const inset = this.scrollsHorizontally() ? `${margin}px` : "";
    if (style.getPropertyValue(SIDE_INSET) === inset) return false;
    if (inset) style.setProperty(SIDE_INSET, inset);
    else style.removeProperty(SIDE_INSET);
    return true;
  }

  /**
   * A chosen max height caps the host's height, which the Reader's stylesheet centers in
   * the reading area, so EPUB.js lays its pages or columns out no taller than it.
   */
  private applyHostHeight(): void {
    const style = this.host?.style;
    if (!style) return;
    // The reading area is measured again after the host changes, before its observer reports it.
    this.areaSize = undefined;
    const { maxHeight } = this.presentation;
    const width = this.presentation.maxWidth;
    // Each page is its text and its margins.
    const gap = 2 * (this.presentation.sideMargin ?? 20);
    const availableWidth =
      this.host?.parentElement?.clientWidth || this.manager()?._stageSize?.width || 800;
    const spreadMinimum = this.manager()?.layout?._minSpreadWidth ?? 800;
    const pages =
      !this.continuous &&
      this.displayedMode() !== "vertical" &&
      this.presentation.pageLayout === "double" &&
      availableWidth >= spreadMinimum &&
      (width === undefined || (width + gap) * 2 >= spreadMinimum)
        ? 2
        : 1;
    if (width === undefined) style.removeProperty("--reader-max-width");
    else style.setProperty("--reader-max-width", `${(width + gap) * pages}px`);
    const height = maxHeight === undefined ? "" : `${maxHeight}px`;
    if (style.getPropertyValue(MAX_HEIGHT) === height) return;
    if (height) style.setProperty(MAX_HEIGHT, height);
    else style.removeProperty(MAX_HEIGHT);
  }

  /** Refresh EPUB.js's spread choice without changing the rendition or reading anchor. */
  private applyPageLayout(): void {
    const layout = this.manager()?.layout;
    if (!layout || this.continuous || !this.presentation.pageLayout) return;
    layout._spread =
      this.presentation.pageLayout === "double" && this.manager()?.settings?.axis !== "vertical";
    if (layout.settings)
      layout.settings.spread = this.presentation.pageLayout === "single" ? "none" : "auto";
    this.applyHostHeight();
  }

  /** Vertical CSS columns follow the existing pagination axis, one column a turn. */
  private followPageLayout(): void {
    const layout = (this.rendition as unknown as { _layout?: EpubLayout })?._layout;
    const format = layout?.format?.bind(layout);
    if (!layout || !format) return;
    layout.format = (contents, section, axis) => {
      if (
        !this.continuous &&
        !this.fixedLayout &&
        this.presentation.pageLayout &&
        (axis === "vertical" || contents.writingMode?.().startsWith("vertical"))
      ) {
        const area = this.manager()?._stageSize;
        if (area && contents.columns)
          return contents.columns(area.width, area.height, area.height - 40, 40, "ltr");
      }
      return format(contents, section, axis);
    };
    this.applyPageLayout();
  }

  /**
   * Lay the pages out again at the host's size. EPUB.js formats the displayed views at
   * the new size, but it keeps each view's fixed axis, such as a horizontal page's height,
   * at the size it was created with, rebuilding views only after a window resize. Size
   * them to the new pages too, so a taller page is not cut off at its old height. A
   * continuous book's views fit their text once all are formatted and sized.
   */
  private layOutAgain(): void {
    const manager = this.manager();
    const deferred = new Set<EpubView>();
    this.deferredExpansions = deferred;
    try {
      manager?.updateLayout?.();
      this.areaSize = undefined;
      const { width, height } = manager?.viewSettings ?? {};
      for (const view of manager?.views?.all() ?? []) {
        if (typeof view.size === "function") view.size(width, height);
      }
    } finally {
      this.deferredExpansions = undefined;
    }
    this.expandViews(deferred);
  }

  /**
   * Fit continuous views to their text, measuring every one before resizing any: each
   * measurement made after another view was resized lays the whole book out again.
   */
  private expandViews(views: Iterable<EpubView>): void {
    const fits = Array.from(views, (view) => ({ view, size: this.fittedSize(view) }));
    for (const { view, size } of fits) {
      if (!size) {
        view.expand?.();
        continue;
      }
      // EPUB.js frames a view again when its size changed. Vertical text is compared with
      // its frame's own size, as Komori's expansion of it does.
      const frame = view.settings?.axis === "horizontal" ? view.iframe?.style : undefined;
      const width = frame ? parseFloat(frame.width) : view._width;
      const height = frame ? parseFloat(frame.height) : view._height;
      if (view._needsReframe || size.width !== width || size.height !== height)
        view.reframe?.(size.width, size.height);
    }
  }

  /**
   * The size a loaded continuous view expands to: its text's extent along the reading
   * order and its locked size across it. A fixed-layout page, or a view without its text,
   * is left to EPUB.js.
   */
  private fittedSize(view: EpubView): { width: number; height: number } | undefined {
    const contents = view.contents;
    if (!this.continuous || !view.iframe || !contents || view.layout?.name === "pre-paginated")
      return undefined;
    if (view.settings?.axis === "horizontal") {
      const height = view.lockedHeight;
      if (this.fixedLayout || !this.scrollsHorizontally() || !contents.textWidth) return undefined;
      if (height === undefined || !Number.isFinite(height) || height <= 0) return undefined;
      // textWidth() rounds to the nearest pixel. Reserve its fractional remainder so the
      // last line is not clipped by the iframe's edge.
      const width = Math.ceil(contents.textWidth() + 0.5);
      return Number.isFinite(width) && width >= 0 ? { width, height } : undefined;
    }
    const width = view.lockedWidth;
    if (width === undefined || !contents.textHeight) return undefined;
    return { width, height: contents.textHeight() };
  }

  /** Show a section afresh, such as in another axis, then the page of a reading point. */
  private async redisplay(rendition: Rendition, book: Book, anchor: ReflowAnchor) {
    this.axisConflict = false;
    const href = (book.spine.get(anchor.spineIndex) as { href?: string } | null)?.href;
    if (!href) return;
    this.manager()?.clear?.();
    this.followWritingMode();
    this.applyHostInset();
    await rendition.display(href);
    if (this.disposed) return;
    await this.displayAnchor(rendition, book, anchor);
  }

  /** Show the page holding a reflow's reading point, which later reflows keep too. */
  private async displayAnchor(rendition: Rendition, book: Book, anchor: ReflowAnchor) {
    this.reflowAnchor = anchor;
    const href = (book.spine.get(anchor.spineIndex) as { href?: string } | null)?.href;
    // A continuous book may have its target beyond the loaded viewport after a
    // manager change or reflow. Bring that section on screen before aligning its
    // saved character; otherwise an unloaded iframe silently leaves the old point.
    if (this.continuous && href) {
      if (
        !this.manager()
          ?.views?.all()
          .some((view) => view.section.index === anchor.spineIndex)
      )
        await rendition.display(href);
      if (this.disposed || !(await this.showSectionStart(rendition, anchor.spineIndex))) return;
    }
    const contents = sectionContents(rendition, anchor.spineIndex);
    const point =
      contents &&
      (anchorPoint(contents, anchor) ?? pointAtProgress(contents.document, anchor.progress));
    if (contents && point && href) {
      const relocation = this.waitForRelocation(rendition);
      await this.displayPoint(rendition, contents, point, href, relocation);
    }
  }

  /** Follow the host's size once it settles, such as after the Reader's sidebar is pinned. */
  private observeHost(host: HTMLElement): void {
    this.anchoredSize = hostSize(host);
    this.resizeDisplaced = false;
    void this.displayedAnchor().then((anchor) => {
      this.settledAnchor ??= anchor;
    });
    if (typeof ResizeObserver === "undefined") return;
    this.hostObserver = new ResizeObserver(() => this.scheduleHostSize());
    this.hostObserver.observe(host);
    // A fitted single page may keep its size while its container becomes large
    // enough for a spread again. Follow the container as well as the host.
    if (host.parentElement) this.hostObserver.observe(host.parentElement);
  }

  private scheduleHostSize(): void {
    clearTimeout(this.hostSizeTimer);
    this.hostSizeTimer = setTimeout(() => void this.followHostSize(), HOST_SIZE_SETTLE_MS);
  }

  /**
   * EPUB.js answers a resize by displaying its own location and then reporting where it
   * is. A report that finds no location, as while a drag resizes the views, never
   * relocates, so the layout also ends once that display and its report are done. The
   * host's size is then followed from the settled reading point either way.
   */
  private async endResizeLayout(revision: number): Promise<void> {
    const queue = (this.rendition as unknown as EpubManager | undefined)?.q;
    if (!queue) return;
    // EPUB.js queues its display just after announcing the resize, and its report as
    // that display ends; the report reads the location on the next frame.
    await Promise.resolve();
    await queue.enqueue(() => undefined);
    await queue.enqueue(() => undefined);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (this.disposed || !this.layoutPending || revision !== this.resizeRevision) return;
    this.layoutPending = false;
    void this.refreshPageTurns();
  }

  /** The host's size changed, or EPUB.js followed a window resize, since the book followed it. */
  private reflowPending(): boolean {
    const host = this.host;
    const anchored = this.anchoredSize;
    if (!host || !anchored) return false;
    const size = hostSize(host);
    return this.resizeDisplaced || size.width !== anchored.width || size.height !== anchored.height;
  }

  /**
   * EPUB.js lays the book out again only when the window resizes, and then shows the
   * start of the paragraph it last reported, which can lie pages before the reading
   * point. When the host's size changes, by a window resize or by the Reader's own
   * layout, lay it out at the new size and show the page holding the last settled page's
   * first character, like a presentation change, after EPUB.js's own display. That point
   * is kept from before the change: EPUB.js measures its container again whenever its
   * location is read, so a page measured after the change has already moved.
   */
  private async followHostSize(): Promise<void> {
    const rendition = this.rendition;
    const book = this.book;
    const host = this.host;
    const anchored = this.anchoredSize;
    if (!rendition || !book || !host || !anchored || !this.ready || this.disposed) return;
    this.applyHostHeight();
    if (!this.reflowPending()) return;
    if (this.turnPending || this.layoutPending || this.sectionsLoading) {
      this.scheduleHostSize();
      return;
    }
    this.invalidateSelection();
    this.turnPending = true;
    this.onPageTurnsChanged?.(unavailable);
    try {
      const anchor = this.reflowAnchor ?? this.settledAnchor;
      this.anchoredSize = hostSize(host);
      this.resizeDisplaced = false;
      // EPUB.js measures its container, which fills the host, and formats the views again.
      this.restyleSections(book, rendition);
      this.layOutAgain();
      await this.matchImageSpread(rendition);
      if (this.disposed) return;
      if (anchor) await this.displayAnchor(rendition, book, anchor);
      if (this.disposed) return;
      await this.refreshPageTurns();
      await this.publishLocation();
    } finally {
      this.turnPending = false;
      if (!this.disposed) await this.refreshPageTurns();
    }
    await this.applySkippedPresentation();
  }

  /**
   * The book's font-weight and text-indent rules that apply to a section document, from
   * its stylesheets and style elements in document order. A stylesheet that cannot be
   * read adds none.
   */
  private async collectStyleRules(
    book: Book,
    document: Document,
    sectionUrl?: string,
  ): Promise<StyleRule[]> {
    const sources = Array.from(document.querySelectorAll("link, style")).filter(
      (element) =>
        !element.hasAttribute(FONT_WEIGHT_STYLE) &&
        !element.hasAttribute(PARAGRAPH_INDENT_STYLE) &&
        !element.hasAttribute(LINE_HEIGHT_ATTRIBUTE) &&
        !element.hasAttribute(SIDE_MARGIN_STYLE) &&
        !element.hasAttribute(CENTER_IMAGES_STYLE) &&
        !element.hasAttribute(CENTER_HEADINGS_STYLE),
    );
    // A link counts as a stylesheet that imports the linked one.
    const roots = sources.map((element): Stylesheet => {
      if (element.localName === "style")
        return ownStylesheet(element.textContent ?? "", sectionUrl);
      const href = element.getAttribute("href");
      const rel = element.getAttribute("rel")?.toLowerCase().split(/\s+/) ?? [];
      const path = href && sectionUrl ? archivePath(href, sectionUrl) : undefined;
      if (!path || !rel.includes("stylesheet")) return { imports: [], rules: [] };
      return { imports: [{ path, media: "" }], rules: [] };
    });
    // Every stylesheet the section reaches is read first; reading one never waits on
    // another's imports, so stylesheets that import each other cannot wait on each other.
    const sheets = new Map<string, Stylesheet | undefined>();
    const load = async (imports: readonly string[]): Promise<void> => {
      await Promise.all(
        imports.map(async (path) => {
          if (sheets.has(path)) return;
          sheets.set(path, undefined);
          const sheet = await this.stylesheetAt(book, path);
          sheets.set(path, sheet);
          if (sheet) await load(sheet.imports.map((entry) => entry.path));
        }),
      );
    };
    await load(roots.flatMap((root) => root.imports.map((entry) => entry.path)));
    // One cycle set for the collection holds the stylesheets being expanded: one that
    // imports itself, directly or not, adds nothing the second time.
    const expanding = new Set<string>();
    const expand = (sheet: Stylesheet): StyleRule[] => [
      ...sheet.imports.flatMap(({ path, media }) => {
        const rules = expandAt(path);
        return media
          ? rules.map((rule) => ({ ...rule, conditions: [`@media ${media}`, ...rule.conditions] }))
          : rules;
      }),
      ...sheet.rules,
    ];
    const expandAt = (path: string): StyleRule[] => {
      const sheet = sheets.get(path);
      if (!sheet || expanding.has(path)) return [];
      expanding.add(path);
      try {
        return expand(sheet);
      } finally {
        expanding.delete(path);
      }
    };
    return roots.flatMap(expand);
  }

  /**
   * Centers the drawn content of heading images that leave blank space on one side,
   * measured from the archive before the section is laid out. An image that cannot be
   * read or measured keeps its content where it is.
   */
  private async centerHeadingInk(
    book: Book,
    images: readonly Element[],
    sectionUrl: string | undefined,
  ): Promise<void> {
    await Promise.all(
      images.map(async (image) => {
        const src = image.getAttribute("src");
        const path = src && sectionUrl ? archivePath(src, sectionUrl) : undefined;
        if (!path) return;
        let shift = this.inkShifts.get(path);
        if (!shift) {
          shift = Promise.resolve()
            .then(() => book.archive?.request(path, "blob") as Promise<unknown> | undefined)
            .then((blob) => (blob instanceof Blob ? imageInkShift(blob) : undefined))
            .catch(() => undefined);
          this.inkShifts.set(path, shift);
        }
        const measured = await shift;
        if (measured && !this.disposed) applyInkShift(image, measured);
      }),
    );
  }

  /** One of the book's stylesheets, read and parsed once from the archive. */
  private stylesheetAt(book: Book, path: string): Promise<Stylesheet | undefined> {
    let sheet = this.stylesheets.get(path);
    if (!sheet) {
      sheet = Promise.resolve()
        .then(() => book.archive?.request(path, "text") as Promise<unknown> | undefined)
        .then((text) => (typeof text === "string" ? ownStylesheet(text, path) : undefined))
        .catch(() => undefined);
      this.stylesheets.set(path, sheet);
    }
    return sheet;
  }

  /**
   * EPUB.js lays its pages out before a section reports its axis, then formats the
   * section. When a chosen margin meets a section whose axis differs from the last one,
   * such as a vertical chapter after a horizontal cover, lay the pages out again first,
   * so the section is formatted with its own axis's gap.
   */
  private followAxis(): void {
    this.restoreAxis?.();
    const manager = this.manager();
    const updateAxis = manager?.updateAxis?.bind(manager);
    if (!manager || !updateAxis) return;
    // The wrapper holds this renderer, so a manager EPUB.js leaves reachable must not keep it.
    const own = Object.hasOwn(manager, "updateAxis");
    const original = manager.updateAxis;
    this.restoreAxis = () => {
      if (own) manager.updateAxis = original;
      else delete manager.updateAxis;
      this.restoreAxis = undefined;
    };
    manager.updateAxis = (axis, forceUpdate) => {
      // A continuous section of vertical text scrolls horizontally.
      if (this.continuous && this.presentation.writingMode === undefined) {
        if (axis === "horizontal" && !this.bookVertical) this.foundVertical(manager);
        else if (axis === "vertical" && this.bookVertical) {
          // A section rendered before the book was found vertical is shown again.
          this.axisConflict = true;
          return;
        }
      }
      const changed = axis !== manager.settings?.axis;
      const spread = manager.layout?._spread;
      updateAxis(axis, forceUpdate);
      if (!this.continuous && this.presentation.pageLayout) this.applyPageLayout();
      if (this.continuous) {
        // EPUB.js sets the scroll direction only with the flow, before any axis is known.
        if (changed) {
          manager.stage?.overflow(manager.overflow ?? "scroll");
          // The first vertical section changes the stage from a vertical scrollbar
          // to a horizontal one. Its view was sized before that change; remeasure
          // the scrollable height now, before EPUB.js formats its columns.
          if (this.scrollsHorizontally()) this.layOutAgain();
        }
        if (changed && this.book && this.rendition) this.restyleSections(this.book, this.rendition);
        // It drops its two-page spread on changing to the vertical axis, but not for the
        // vertical axis a continuous book opens with. The spread sets how wide it lets
        // images be, so keep it, and a book shows its images as when it opens.
        if (manager.layout) manager.layout._spread = spread;
        return;
      }
      // A chosen writing mode changes the axis of the section it shows again.
      const { sideMargin, writingMode } = this.presentation;
      if (!changed || (sideMargin === undefined && writingMode === undefined)) return;
      manager.updateLayout?.();
      // EPUB.js pages a vertical section by its height, as the section had just set.
      if (axis === "vertical") manager.layout.delta = manager.layout.height;
    };
  }

  /**
   * A continuous book scrolls along the axis of its displayed mode, and the scrollbar
   * EPUB.js shows along it narrows or shortens the reading area. Returns whether the axis
   * changed.
   */
  private followScrollAxis(): boolean {
    const manager = this.manager();
    if (!this.continuous || !manager?.updateAxis) return false;
    const axis = this.scrollsHorizontally() ? "horizontal" : "vertical";
    if (manager.settings?.axis === axis) return false;
    manager.updateAxis(axis);
    return true;
  }

  /**
   * A continuous book showing a vertical section is a vertical book: its sections take
   * the vertical mode, and it scrolls right to left. Sections already shown in the other
   * axis are shown again once the current navigation completes.
   */
  private foundVertical(manager: EpubManager): void {
    this.bookVertical = true;
    this.followWritingMode();
    this.applyHostInset();
    if (this.book && this.rendition) this.restyleSections(this.book, this.rendition);
    if (manager.views?.all().some((view) => view.settings?.axis === "vertical"))
      this.axisConflict = true;
  }

  /**
   * The page progression and forward arrow of the displayed writing mode: a chosen
   * horizontal mode reads left to right, a chosen vertical one right to left, and
   * otherwise the book's own apply. A paginated section that sets itself right to left
   * is read right to left in either horizontal mode, as its columns run. Pages are laid
   * out again, unless EPUB.js is about to format and position the section itself.
   */
  private followWritingMode(relayout = true): void {
    const mode = this.displayedMode();
    const rtl = this.sectionRtl && mode !== "vertical";
    this.forwardArrow = rtl
      ? "ArrowLeft"
      : mode === "horizontal"
        ? "ArrowRight"
        : mode === "vertical"
          ? "ArrowLeft"
          : this.bookForwardArrow;
    const direction = rtl
      ? "rtl"
      : mode === "horizontal"
        ? "ltr"
        : mode === "vertical"
          ? "rtl"
          : this.bookDirection;
    const settings = (
      this.rendition as unknown as { settings?: { direction?: string } } | undefined
    )?.settings;
    const manager = this.manager();
    if (!settings || settings.direction === direction) return;
    // EPUB.js's own rendition.direction() would also display its last location again.
    // Its layout keeps a copy too, which each section's columns are formatted in.
    settings.direction = direction;
    if (manager?.layout.settings) manager.layout.settings.direction = direction;
    if (relayout) manager?.direction?.(direction);
    else if (manager) {
      // Its view manager pages and maps the section in its own copy, and its stage
      // scrolls from the progression's side.
      if (manager.settings) manager.settings.direction = direction;
      if (manager.mapping) manager.mapping.direction = direction;
      manager.stage?.direction?.(direction);
    }
  }

  /**
   * EPUB.js lays a paginated section's columns out in the section's own direction when it
   * is right to left, whatever the page progression, and would read such a section from
   * its last page. Each horizontal section's own direction is followed as EPUB.js formats
   * it, before it is positioned in its first or last page.
   */
  private followSectionDirection(): void {
    this.sectionRtl = false;
    const layout = this.manager()?.layout;
    const format = layout?.format?.bind(layout);
    if (!layout || !format) return;
    layout.format = (contents, ...rest) => {
      if (!this.continuous && !this.fixedLayout && !this.disposed && contents?.document) {
        const rtl = followBodyDirection(contents.document);
        if (rtl !== this.sectionRtl) {
          this.sectionRtl = rtl;
          this.followWritingMode(false);
        }
      }
      return format(contents, ...rest);
    };
  }

  /**
   * EPUB.js removes the view of the section a paginated turn leaves before it loads the
   * next section, which would leave the reading area empty until the new view paints.
   * The page in sight stays where it is until EPUB.js shows the new view, and both
   * change in the same frame.
   */
  private followTurnHandover(): void {
    this.releaseHeldViews = undefined;
    const manager = this.manager();
    const views = manager?.views;
    const container = manager?.container;
    const clear = manager?.clear?.bind(manager);
    const destroy = views?.destroy?.bind(views);
    const show = views?.show?.bind(views);
    if (!manager || !views || !container || !clear || !destroy || !show) return;
    const held = new Set<EpubView>();
    const remove = (view: EpubView) => {
      try {
        destroy(view);
      } catch {
        // The page around it is already gone.
      } finally {
        view.element.remove();
      }
    };
    this.releaseHeldViews = () => {
      held.forEach(remove);
      held.clear();
    };
    manager.clear = () => {
      if (this.turningPage && !this.disposed) {
        // Each page is measured before any leaves the flow: the one after a held page
        // would otherwise move into its place first, over it.
        const shown = views
          .all()
          .filter((view) => view.displayed && view.element.style.visibility !== "hidden")
          .map((view) => [view, view.element.getBoundingClientRect()] as const);
        for (const [view, box] of shown)
          if (holdInPlace(view.element, container, box)) held.add(view);
      }
      clear();
      // EPUB.js hid them as it cleared the page.
      for (const view of held) {
        view.element.style.visibility = "visible";
        if (view.iframe) view.iframe.style.visibility = "visible";
      }
    };
    views.destroy = (view) => {
      if (!held.has(view)) destroy(view);
    };
    views.show = () => {
      show();
      if (!held.size) return;
      // Tearing down the old section's document would delay the new page's frame, so
      // it waits until that frame is drawn.
      const replaced = [...held];
      held.clear();
      for (const view of replaced) {
        view.element.style.visibility = "hidden";
        if (view.iframe) view.iframe.style.visibility = "hidden";
      }
      requestAnimationFrame(() => setTimeout(() => replaced.forEach(remove)));
    };
  }

  /**
   * EPUB.js shows one reflowable section at a time and rounds it up to whole spreads, so
   * an image-only page would fill one side of a spread and leave the other blank. Image
   * pages in a run share a spread instead, one image a page, as a fixed-layout spread
   * shows its two pages: the first of a pair brings its partner after it, and
   * the second (reached going back, or opened directly) brings it before. Each is one
   * page wide. An image page left alone shares its spread with the first page of the
   * text after it in the same chapter: the text then takes an odd number of pages, so
   * the two sections end on a whole spread.
   */
  private followImageSpreads(): void {
    const manager = this.manager();
    const createView = manager?.createView?.bind(manager);
    const handle = manager?.handleNextPrePaginated?.bind(manager);
    const prepend = manager?.prepend?.bind(manager);
    const display = manager?.display?.bind(manager);
    if (!manager || !createView || !handle || !prepend) return;
    const shown = (index: number) =>
      manager.views?.all().some((view) => view.section.index === index) ?? false;
    const section = (index: number) =>
      this.book?.spine.get(index) as unknown as EpubSection | undefined;
    manager.createView = (...args) => {
      const view = createView(...args);
      const index = (args[0] as EpubSection | undefined)?.index;
      if (index === undefined) return view;
      if (this.imagePartner(index) !== undefined && view.settings)
        view.settings.forceEvenPages = false;
      // EPUB.js rounds the measured text width, which can pass a fractional page width by
      // a pixel and take another page. A fitted image page fills one spread, or one page
      // beside its partner.
      const reframe = view.reframe?.bind(view);
      if (reframe)
        view.reframe = (width, height) => {
          const page = manager.layout?.pageWidth;
          const paired = this.imagePartner(index) !== undefined;
          if (paired && page && this.textPartners.has(index)) {
            const pages = Math.max(1, Math.round(width / page));
            reframe(pages % 2 ? width : width + page, height);
            return;
          }
          const imagePage =
            paired || !!view.contents?.document?.querySelector("[data-komori-page-image]");
          const pages = paired ? 1 : (manager.layout?.divisor ?? 1);
          const limited =
            imagePage && page && !this.continuous && manager.settings?.axis !== "vertical";
          reframe(limited ? Math.min(width, page * pages) : width, height);
        };
      return view;
    };
    // EPUB.js places a target by whole spreads of the section it lies in; beside an image
    // page, the text's spreads start a page later. Show the spread holding the target.
    if (display)
      manager.display = async (shownSection, target) => {
        await display(shownSection, target);
        if (!this.showsImageSpread()) return;
        const view = manager.views
          ?.all()
          .find((shown) => shown.section.index === shownSection.index);
        const spread = manager.layout?.delta;
        if (!view?.offset || !spread || !manager.scrollTo) return;
        let left = view.offset().left;
        if (target && view.locationOf) {
          try {
            left += view.locationOf(target).left;
          } catch {
            /* An unplaceable target shows the section's start. */
          }
        }
        manager.scrollTo(Math.floor(left / spread) * spread, 0, true);
      };
    manager.handleNextPrePaginated = (forceRight, shownSection, action) => {
      const partner = this.imagePartner(shownSection.index);
      const other = partner === undefined || shown(partner) ? undefined : section(partner);
      if (!other) return handle(forceRight, shownSection, action);
      return partner! > shownSection.index ? action.call(manager, other) : prepend(other);
    };
    manager.prepend = async (added, forceRight) => {
      await prepend(added, forceRight);
      const partner = this.imagePartner(added.index);
      const other =
        partner === undefined || partner > added.index || shown(partner)
          ? undefined
          : section(partner);
      if (other) await prepend(other);
    };
  }

  /**
   * EPUB.js pairs a fixed-layout book's pages from whichever page it shows, only as a
   * left-to-right book sets them, and turns a right-to-left spread by scrolling, which
   * never reaches the next page. The pages are grouped into spreads from the book's start
   * instead, by the sides they declare in either progression, and showing a page or
   * turning shows a whole spread. Each page of a spread lies against its spine, and a
   * page alone on its spread on the side it belongs to; a single page is centered. Every
   * page is centered vertically.
   */
  private followFixedSpreads(): void {
    const manager = this.manager();
    const layout = manager?.layout;
    const book = this.book;
    if (!manager || !layout || !book) return;
    const display = manager.display?.bind(manager);
    const next = manager.next?.bind(manager);
    const prev = manager.prev?.bind(manager);
    const add = manager.add?.bind(manager);
    const format = layout.format?.bind(layout);
    const pages: EpubSection[] = [];
    book.spine.each((section: EpubSection) => {
      if (section.linear) pages.push(section);
    });
    const rtl = () => manager.settings?.direction === "rtl";
    // The spreads of each page progression, and the spread each section's page is in.
    const arrangements = new Map<
      boolean,
      { spreads: FixedSpread<EpubSection>[]; at: Map<number, number> }
    >();
    const arrangement = () => {
      const backward = rtl();
      let found = arrangements.get(backward);
      if (!found) {
        const spreads = fixedSpreads(
          pages,
          pages.map((section) => declaredSide(section, backward)),
        );
        const at = new Map<number, number>();
        spreads.forEach((spread, index) =>
          spread.pages.forEach((page) => at.set(page.index, index)),
        );
        found = { spreads, at };
        arrangements.set(backward, found);
      }
      return found;
    };
    // A page outside the reading order, reached through a link, is shown alone.
    const spreadOf = (section: EpubSection): FixedSpread<EpubSection> => {
      const { spreads, at } = arrangement();
      return spreads[at.get(section.index) ?? -1] ?? { pages: [section], alone: "center" };
    };
    const neighbor = (section: EpubSection, step: number) => {
      const { spreads, at } = arrangement();
      const index = at.get(section.index);
      if (index !== undefined) return spreads[index + step];
      const adjacent = (step > 0 ? section.next() : section.prev()) as EpubSection | undefined;
      return adjacent ? spreadOf(adjacent) : undefined;
    };
    const paired = () => this.fixedLayout && !this.disposed && (layout.divisor ?? 1) >= 2;
    const show = async (spread: FixedSpread<EpubSection>, turn: boolean) => {
      manager.clear?.();
      // The new pages may be laid out differently, as EPUB.js's own turns allow for.
      if (turn) manager.updateLayout?.();
      try {
        for (const page of spread.pages) await add?.(page);
      } catch (error) {
        // EPUB.js shows what it could of a turn's pages.
        if (!turn) throw error;
      }
      // A spread's pages fill it from the side it is read from, so a page alone on its
      // second side, or in its center, moves along by a page or half of one.
      const view = manager.views?.all()[0];
      const width = layout.columnWidth ?? view?.width?.() ?? 0;
      const offset = spread.alone === "second" ? width : spread.alone === "center" ? width / 2 : 0;
      if (view && offset) view.element.style[rtl() ? "marginRight" : "marginLeft"] = `${offset}px`;
      manager.views?.show?.();
    };
    if (display && add)
      manager.display = (section, target) =>
        paired() ? show(spreadOf(section), false) : display(section, target);
    if (next && add)
      manager.next = () => {
        if (!paired()) return next();
        const last = manager.views?.all().at(-1)?.section;
        const spread = last && neighbor(last, 1);
        return spread ? show(spread, true) : undefined;
      };
    if (prev && add)
      manager.prev = () => {
        if (!paired()) return prev();
        const first = manager.views?.all()[0]?.section;
        const spread = first && neighbor(first, -1);
        return spread ? show(spread, true) : undefined;
      };
    // EPUB.js scales a page to fit its share of the reading area and sets it against the
    // area's left edge, or a declared left page against its right edge.
    if (format)
      layout.format = (contents, ...rest) => {
        const formatted = format(contents, ...rest);
        const column = layout.columnWidth;
        if (!this.fixedLayout || this.disposed || !contents?.css || !column) return formatted;
        // EPUB.js reads the page's size from its viewport the same way.
        const viewport = contents.viewport?.();
        const width = Number.parseInt(viewport?.width ?? "", 10);
        const height = Number.parseInt(viewport?.height ?? "", 10);
        if (!(width > 0) || !(height > 0) || !(layout.height > 0)) return formatted;
        const section = rest[0] as EpubSection | undefined;
        const scale = Math.min(column / width, layout.height / height);
        const spare = column - width * scale;
        let place: SpreadSide = "center";
        if (paired() && section) {
          const spread = spreadOf(section);
          place = spread.alone ?? (spread.pages[0]?.index === section.index ? "first" : "second");
        }
        const left = place === "center" ? spare / 2 : (place === "first") !== rtl() ? spare : 0;
        // A hundredth of a pixel is finer than any screen, and keeps the scale's rounding
        // error out of the margins.
        const pixels = (value: number) => `${Math.round(value * 100) / 100}px`;
        contents.css("margin-left", pixels(left));
        contents.css("margin-top", pixels((layout.height - height * scale) / 2));
        return formatted;
      };
  }

  /** The section that shares a spread with an image-only section, in the current layout. */
  private imagePartner(index: number): number | undefined {
    const manager = this.manager();
    if (this.continuous || this.fixedLayout || this.presentation.pageLayout !== "double")
      return undefined;
    if (manager?.settings?.axis === "vertical" || (manager?.layout?.divisor ?? 1) < 2)
      return undefined;
    return this.imageSpreads.get(index);
  }

  /** Whether the displayed views are the two image pages of one spread. */
  private showsImageSpread(): boolean {
    const views = this.manager()?.views?.all() ?? [];
    return (
      views.length === 2 && this.imagePartner(views[0].section.index) === views[1].section.index
    );
  }

  /**
   * Show image pages paired or alone as the layout now has them, after the spread
   * changes or the pairs are found. Only a page that has to change is shown again.
   */
  private async matchImageSpread(rendition: Rendition): Promise<void> {
    if (!this.imageSpreads.size) return;
    const views = this.manager()?.views?.all() ?? [];
    const first = views[0]?.section.index;
    if (first === undefined || this.continuous || this.fixedLayout || this.disposed) return;
    const partner = this.imagePartner(first);
    const expected = partner === undefined ? [first] : [first, partner].sort((a, b) => a - b);
    const shown = views.map((view) => view.section.index).sort((a, b) => a - b);
    // A section of text shown on its own is as it should be.
    if (partner === undefined && views.length === 1) return;
    if (expected.length === shown.length && expected.every((index, i) => index === shown[i]))
      return;
    const href = (this.book?.spine.get(expected[0]) as { href?: string } | null)?.href;
    if (!href) return;
    const relocation = this.waitForRelocation(rendition);
    this.manager()?.clear?.();
    await rendition.display(href);
    await this.navigatedLocation(rendition, relocation);
  }

  /**
   * EPUB.js finds a paginated page's location by measuring the section's text from its
   * start, which takes long deep in a long section, and a turn asks for it several times
   * as it settles. A location is reused until the current task ends, while the views and
   * the reading area lie as they did when it was found.
   */
  private followLocationReuse(): void {
    const manager = this.manager();
    const locate = manager?.currentLocation?.bind(manager);
    if (!manager || !locate) return;
    let found: { layout: unknown[]; location: unknown } | undefined;
    manager.currentLocation = () => {
      if (found && sameValues(found.layout, locationLayout(manager))) return found.location;
      const location = locate();
      if (!location || typeof (location as PromiseLike<unknown>).then === "function")
        return location;
      if (!found) setTimeout(() => (found = undefined));
      // Finding it lays the views out, so the layout it belongs to is the one after.
      found = { layout: locationLayout(manager), location };
      return location;
    };
  }

  /**
   * Follow a continuous rendition's scrolling. EPUB.js's continuous view manager lays
   * out every linear section, given an unbounded offset, and keeps them; the reading
   * point settles once scrolling stops.
   */
  private followScrolling(rendition: Rendition): void {
    const manager = this.manager();
    const container = manager?.container;
    if (!manager || !container) return;
    // The text in view stays in place when a section before it changes size, such as
    // one EPUB.js adds before the view and renders later. EPUB.js compensates only for
    // part of that, and the browser's own scroll anchoring would add to it.
    container.style.overflowAnchor = "none";
    const anchoring = this.followSectionSizes(manager, container);
    if (typeof ResizeObserver !== "undefined") {
      this.scrollExtent?.disconnect();
      this.scrollExtent = new ResizeObserver(this.notifyScroll);
      this.scrollExtent.observe(container);
    }
    // EPUB.js converts right-to-left scroll offsets only for horizontal writing, but a
    // vertical book scrolls right to left as well.
    manager.writingMode = "horizontal-tb";
    manager.updateWritingMode = () => {
      manager.writingMode = "horizontal-tb";
    };
    // EPUB.js never finishes rendering a section removed while it renders, such as one
    // added after a scroll just before a jump clears the book, and its queue would wait
    // for it for good. Such a section's display ends instead.
    const cancels = new WeakMap<EpubView, () => void>();
    const createView = manager.createView?.bind(manager);
    if (createView) {
      manager.createView = (...args) => {
        const view = createView(...args);
        // EPUB.js rounds every horizontal extent to whole pages, even in scrolled
        // vertical text. Those unused pixels become gaps between spine sections.
        const expand = view.expand?.bind(view);
        let expanding = false;
        if (expand)
          view.expand = (force) => {
            if (expanding) return;
            // A view laid out again with the others fits its text once all are sized.
            if (this.deferredExpansions) {
              this.deferredExpansions.add(view);
              return;
            }
            const size = view.settings?.axis === "horizontal" ? this.fittedSize(view) : undefined;
            if (!size || !view.iframe || !view.reframe) {
              expand(force);
              return;
            }
            expanding = true;
            try {
              if (
                parseFloat(view.iframe.style.width) !== size.width ||
                parseFloat(view.iframe.style.height) !== size.height
              )
                view.reframe(size.width, size.height);
            } finally {
              expanding = false;
            }
          };
        // A chapter view shows no section outside its chapter, even for a moment.
        if (this.chapterView) this.clipView(view);
        anchoring?.observe(view.element);
        this.scrollExtent?.observe(view.element);
        // While the rest of the book loads, a section added before the text in view keeps
        // that text in place as EPUB.js sizes it, not a frame later: until then, the reading
        // point the Reader measures and publishes would lie in a section before it.
        const reframe = view.reframe?.bind(view);
        if (reframe && anchoring)
          view.reframe = (width, height) => {
            reframe(width, height);
            if (this.sectionsLoading && !this.disposed)
              this.followSectionSize(view.element, container);
          };
        // After every section it adds, EPUB.js shows each view again, forcing a layout
        // of the whole book per view to redraw it for Safari: a long book took seconds to
        // open. A view already shown is left as it is.
        const show = view.show?.bind(view);
        if (show)
          view.show = () => {
            if (
              view.element.style.visibility !== "visible" ||
              view.iframe?.style.visibility !== "visible"
            )
              show();
          };
        // EPUB.js loads a view's section again when asked to display it while it renders,
        // as an update does for a section its own display is adding, and the first
        // display then never ends. Such a request waits for the display under way.
        const display = view.display.bind(view);
        let displaying: Promise<unknown> | undefined;
        view.display = (request) =>
          (displaying ??= new Promise((resolve, reject) => {
            cancels.set(view, () => reject(new Error("Section removed")));
            display(request).then(resolve, reject);
          }).finally(() => {
            displaying = undefined;
          }));
        return view;
      };
    }
    const views = manager.views;
    const destroy = views?.destroy?.bind(views);
    if (views && destroy) {
      views.destroy = (view) => {
        destroy(view);
        anchoring?.unobserve(view.element);
        this.scrollExtent?.unobserve(view.element);
        cancels.get(view)?.();
      };
    }
    // EPUB.js assumes trim always has a displayed view. At a short section near the
    // book's end, its deferred cleanup can run while none is displayed and otherwise
    // remove almost every view, leaving the rendition's navigation queue broken.
    const trim = manager.trim?.bind(manager);
    if (trim) {
      manager.trim = () => (manager.views?.displayed().length ? trim() : Promise.resolve());
    }
    // Removing sections before those in view keeps the ones in view in place, whichever
    // way the book scrolls.
    const erase = manager.erase?.bind(manager);
    manager.erase = (view, above) => {
      const views = manager.views?.all() ?? [];
      const index = views.indexOf(view);
      // The same view can be queued for cleanup twice. EPUB.js's Views.remove calls
      // removeChild even when that view has already left the container.
      if (index < 0 || !view.element.parentNode) return;
      const kept = views[index + 1];
      if (!above || !kept || !manager.views) {
        erase?.(view, above);
        return;
      }
      const before = kept.element.getBoundingClientRect();
      manager.views.remove(view);
      const after = kept.element.getBoundingClientRect();
      container.scrollLeft += after.left - before.left;
      container.scrollTop += after.top - before.top;
    };
    // Each layout formats the displayed sections again without their axis, which
    // would size vertical text like horizontal text.
    const layout = (rendition as unknown as { _layout?: EpubLayout })._layout;
    if (layout) {
      const format = layout.format.bind(layout);
      layout.format = (contents, section, axis) =>
        format(
          contents,
          section,
          axis ?? (contents.writingMode?.().startsWith("vertical") ? "horizontal" : "vertical"),
        );
    }
    this.followOpeningSections(manager);
    this.limitsLoadedSections = this.linearSections > LOADED_SECTIONS_LIMIT;
    if (this.limitsLoadedSections) this.followLoadedSections(manager, container);
    else this.followAllSections(manager);
    this.scrollContainer = container;
    container.addEventListener("scroll", this.onScroll, { passive: true });
  }

  /**
   * Keep the text in view in place while a section entirely before it changes size, by
   * scrolling as far as it grew or shrank. EPUB.js's own compensation, for sections it
   * adds before the view, is replaced. In a chapter view, the chapter's clipped ends
   * follow their contents destinations first, and only the part of a section shown in
   * the chapter counts.
   */
  private followSectionSizes(
    manager: EpubManager,
    container: HTMLElement,
  ): ResizeObserver | undefined {
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      if (this.disposed) return;
      if (this.chapterView) this.applyChapterBounds();
      for (const entry of entries) this.followSectionSize(entry.target, container);
    });
    manager.counter = () => undefined;
    this.sectionSizes = observer;
    return observer;
  }

  /** Scroll as far as a section entirely before the reading area grew or shrank. */
  private followSectionSize(element: Element, container: HTMLElement): void {
    const size = this.sectionExtent(element);
    const previous = this.sectionExtents.get(element);
    this.sectionExtents.set(element, size);
    if (previous === undefined || previous === size) return;
    const span = this.blockSpan();
    // Before the change, the section ended at or before the reading area's start.
    const end = span(element.getBoundingClientRect())[1];
    if (end - (size - previous) <= span(container.getBoundingClientRect())[0] + 1)
      this.scrollReading(size - previous);
  }

  /**
   * Add sections, as EPUB.js checks for them, only within the opening range while the book
   * opens. A section added before the others is measured from empty, so the text in view
   * keeps its place as it renders, however late it is first measured.
   */
  private followOpeningSections(manager: EpubManager): void {
    const check = manager.check?.bind(manager);
    if (!check) return;
    manager.check = (...args) => {
      const first = manager.views?.first?.();
      const last = manager.views?.last?.();
      const range = this.openingSections;
      // EPUB.js asks only the first view for the section before it and the last view for
      // the one after it, as its check begins.
      const prev = first?.section.prev;
      const next = last?.section.next;
      const within = (section: unknown) => {
        const index = (section as EpubSection | undefined)?.index;
        return range && index !== undefined && index >= range.from && index <= range.to
          ? section
          : undefined;
      };
      if (range && first && last && prev && next) {
        first.section.prev = () => within(prev());
        last.section.next = () => within(next());
      }
      try {
        return check(...args);
      } finally {
        if (first && prev) first.section.prev = prev;
        if (last && next) last.section.next = next;
        const added = manager.views?.first?.();
        if (added && added !== first) this.sectionExtents.set(added.element, 0);
      }
    };
  }

  /**
   * Open a continuous book with only the sections near a section: those within a reading
   * area's length after it, or, in a chapter view, those of the chapters it lies in. The
   * others load once the book shows.
   */
  private async limitOpening(book: Book, spineIndex: number | undefined): Promise<void> {
    const manager = this.manager();
    if (!this.continuous || spineIndex === undefined || !manager?.settings) return;
    if (!this.chapterView) {
      const container = manager.container;
      manager.settings.offset = Math.max(container?.clientWidth ?? 0, container?.clientHeight ?? 0);
      this.openingSections = { from: spineIndex, to: Number.POSITIVE_INFINITY };
      return;
    }
    // A VN group never crosses a section.
    if (this.vnView) {
      this.openingSections = { from: spineIndex, to: spineIndex };
      return;
    }
    this.chapterStarts ??= this.findChapterStarts(book);
    const chapters = await this.chapterStarts;
    if (this.disposed) return;
    // A point of the section lies in a chapter beginning at or after the last chapter start
    // in an earlier section or at its own start, and ending at or before the next section a
    // chapter starts in.
    let from = spineIndex;
    let to = this.lastSpineIndex;
    for (const start of chapters) {
      if (start.spineIndex > spineIndex) {
        to = start.spineIndex;
        break;
      }
      if (start.spineIndex < spineIndex || start.anchorId === undefined) from = start.spineIndex;
    }
    this.openingSections = { from, to };
  }

  /**
   * Load the rest of a continuous book once it shows. Meanwhile its scrollbar, whose
   * length grows with each section, is held back.
   */
  private loadRemainingSections(): void {
    const manager = this.manager();
    const limited = this.openingSections;
    this.openingSections = undefined;
    if (!limited || !manager || this.disposed) return;
    if (manager.settings) manager.settings.offset = Number.POSITIVE_INFINITY;
    if (!manager.fill) return;
    const loading = this.loadSettled(manager, manager.fill()).then(() => {
      if (this.sectionsLoading !== loading) return;
      this.sectionsLoading = undefined;
      if (this.disposed) return;
      this.notifyScroll();
      void this.refreshPageTurns();
    });
    this.sectionsLoading = loading;
  }

  /** Wait for the rest of a continuous book to load, as a jump or a new layout needs it. */
  private async sectionsLoaded(): Promise<void> {
    await this.sectionsLoading;
  }

  /**
   * The end of a continuous book's load, however long a long book takes; a load that adds
   * no section for a while, or whose book no longer shows, is not waited for.
   */
  private async loadSettled(manager: EpubManager, load: Promise<unknown>): Promise<void> {
    let ended = false;
    void load.then(
      () => (ended = true),
      () => (ended = true),
    );
    let added = -1;
    while (!ended && !this.disposed && this.manager() === manager) {
      const views = manager.views?.all().length ?? 0;
      if (views === added) return;
      added = views;
      await settledWithin(load, SECTIONS_LOAD_LIMIT_MS);
    }
  }

  /** Whether every section a chapter view's chapter lies in is loaded. */
  private chapterLoaded(chapter: number): boolean {
    const start = this.chapters[chapter];
    if (!start) return true;
    const end = this.vnView
      ? start.spineIndex
      : (this.chapters[chapter + 1]?.spineIndex ?? this.lastSpineIndex);
    const views = this.manager()?.views?.all() ?? [];
    // The views lie in reading order, one for each linear section between the first and last.
    const first = views[0]?.section.index;
    const last = views.at(-1)?.section.index;
    if (first === undefined || last === undefined || first > start.spineIndex || last < end)
      return false;
    return views.every(
      (view) => view.section.index < start.spineIndex || view.section.index > end || view.displayed,
    );
  }

  /**
   * Load and show every section of a continuous book, as all lie within EPUB.js's unbounded
   * offset. EPUB.js would confirm that by measuring each section at every step of the book's
   * layout. A window resize lays the loaded sections out again where they are.
   */
  private followAllSections(manager: EpubManager): void {
    // EPUB.js answers a window resize by clearing every section and laying the whole book
    // out again from its location. With every section loaded, the views stay, and are laid
    // out again in place as the host's size is followed, as when the Reader's own layout
    // changes the host. A book still opening is laid out again by EPUB.js.
    const resize = manager.resize?.bind(manager);
    if (resize)
      manager.resize = (...args) => {
        if (!this.ready) {
          resize(...args);
          return;
        }
        const { clear, updateLayout } = manager;
        manager.clear = () => undefined;
        manager.updateLayout = () => undefined;
        try {
          resize(...args);
        } finally {
          manager.clear = clear;
          manager.updateLayout = updateLayout;
        }
      };
    if (!manager.update) return;
    manager.update = () =>
      Promise.all(
        (manager.views?.all() ?? []).map((view) =>
          view.displayed
            ? view.show?.()
            : view.display(manager.request).then(
                () => view.show?.(),
                () => view.hide?.(),
              ),
        ),
      );
  }

  /**
   * Keep a long continuous book's sections loaded only near its reading area, its shown
   * chapter, and the section it was last asked to show, and load the others again as the
   * reading area nears them. A released section keeps its place and size, so the book's
   * scroll length stays the same.
   */
  private followLoadedSections(manager: EpubManager, container: HTMLElement): void {
    // EPUB.js's update loads every section within its unbounded offset.
    manager.update = () => this.loadNearbySections();
    // EPUB.js clears the book to show a section it has not loaded, and lays the whole book
    // out again. A released section is scrolled to where it lies, as a loaded one is.
    const display = manager.display?.bind(manager);
    if (!display) return;
    manager.display = (section, target) => {
      this.keptSection = section.index;
      const view = manager.views?.all().find((item) => item.section.index === section.index);
      if (!view || view.displayed) return display(section, target);
      const span = this.blockSpan();
      this.scrollReading(
        span(view.element.getBoundingClientRect())[0] - span(container.getBoundingClientRect())[0],
      );
      const loaded = this.loadNearbySections();
      // A point within the section is found in its loaded document, which EPUB.js scrolls to.
      const within = typeof target === "string" && /#|^epubcfi\(/.test(target);
      return within ? loaded.then(() => display(section, target)) : loaded;
    };
  }

  /**
   * Load the sections a long continuous book keeps near its reading area, and release the
   * others whose content hooks have run, unless only releasing.
   */
  private loadNearbySections(load = true): Promise<unknown> {
    const manager = this.manager();
    const views = manager?.views?.all() ?? [];
    if (!this.limitsLoadedSections || this.disposed || !manager || !views.length)
      return Promise.resolve();
    const near = this.nearbySections(views);
    const loading: Promise<unknown>[] = [];
    let released = false;
    views.forEach((view, index) => {
      if (near(index)) {
        if (!load) return;
        if (view.displayed) view.show?.();
        else
          loading.push(
            view.display(manager.request).then(
              () => view.show?.(),
              () => view.hide?.(),
            ),
          );
      } else if (view.displayed && this.renderedViews.has(view)) {
        this.renderedViews.delete(view);
        view.destroy?.();
        released = true;
      }
    });
    if (released) this.registerContentDocuments();
    if (!loading.length) return Promise.resolve();
    // The reading point waits for a section in view to load, then settles again.
    return Promise.all(loading).then(() => {
      if (this.ready && !this.disposed) this.onScroll();
    });
  }

  /**
   * Whether each of a long continuous book's views, by its place among them, is near the
   * reading area, the shown chapter's first or last section, or the section last asked for.
   */
  private nearbySections(views: EpubView[]): (index: number) => boolean {
    const ranges: Array<[number, number]> = [];
    const container = this.manager()?.container;
    if (container) {
      const span = this.blockSpan();
      const [start, end] = span(container.getBoundingClientRect());
      // The views lie in reading order.
      const first = firstIndex(
        views,
        (view) => span(view.element.getBoundingClientRect())[1] > start,
      );
      const after = firstIndex(
        views,
        (view) => span(view.element.getBoundingClientRect())[0] >= end,
      );
      ranges.push([first, Math.max(first, after - 1)]);
    }
    const sectionRange = (from: number, to: number) => {
      const first = firstIndex(views, (view) => view.section.index >= from);
      const after = firstIndex(views, (view) => view.section.index > to);
      if (first < after) ranges.push([first, after - 1]);
    };
    // The sections a shown chapter begins and ends in are measured to clip it, and a chapter
    // may hold more sections than load.
    const shown = this.chapterView ? this.shownChapter : undefined;
    const chapter = shown === undefined ? undefined : this.chapters[shown];
    if (chapter) {
      sectionRange(chapter.spineIndex, chapter.spineIndex);
      const end = this.chapters[(shown ?? 0) + 1]?.spineIndex ?? this.lastSpineIndex;
      sectionRange(end, end);
    }
    if (this.keptSection !== undefined) sectionRange(this.keptSection, this.keptSection);
    return (index) =>
      ranges.some(
        ([first, last]) =>
          index >= first - LOADED_SECTIONS_REACH && index <= last + LOADED_SECTIONS_REACH,
      );
  }

  /** A section's extent along the reading order, less any part clipped before its chapter. */
  private sectionExtent(element: Element): number {
    const rect = element.getBoundingClientRect();
    const horizontal = this.manager()?.settings?.axis === "horizontal";
    return (horizontal ? rect.width : rect.height) - (this.clippedStarts.get(element) ?? 0);
  }

  /** Measure every section again, after a change the Reader scrolls for itself. */
  private resyncSectionExtents(): void {
    if (!this.sectionSizes) return;
    for (const view of this.manager()?.views?.all() ?? [])
      this.sectionExtents.set(view.element, this.sectionExtent(view.element));
  }

  private releaseScrolling(): void {
    this.limitsLoadedSections = false;
    this.keptSection = undefined;
    this.openingSections = undefined;
    this.sectionsLoading = undefined;
    this.sectionSizes?.disconnect();
    this.sectionSizes = undefined;
    this.scrollContainer?.removeEventListener("scroll", this.onScroll);
    this.scrollContainer = undefined;
    this.scrollExtent?.disconnect();
    this.scrollExtent = undefined;
    this.areaObserver?.observer.disconnect();
    this.areaObserver = undefined;
    this.areaSize = undefined;
    clearTimeout(this.scrollTimer);
    this.scrollTimer = undefined;
    this.notifyScroll();
  }

  private notifyScroll = () => {
    for (const listener of this.scrollWatchers) listener();
  };

  watchScroll(listener: () => void): () => void {
    this.scrollWatchers.add(listener);
    return () => this.scrollWatchers.delete(listener);
  }

  scrollMetrics(): ReaderScrollMetrics | null {
    if (!this.continuous || !this.ready || this.disposed) return null;
    // The whole book's length is known once its sections have loaded. A chapter view's
    // chapter is loaded as it shows.
    if ((this.openingSections || this.sectionsLoading) && !this.chapterView) return null;
    const manager = this.manager();
    const container = manager?.container;
    if (!container) return null;
    if (manager.settings?.axis !== "horizontal")
      return {
        axis: "vertical",
        reversed: false,
        position: container.scrollTop,
        length: Math.max(0, container.scrollHeight - container.clientHeight),
        visible: container.clientHeight,
      };
    return {
      axis: "horizontal",
      reversed: !!this.rendition && readingDirection(this.rendition) === "rtl",
      // A right-to-left book scrolls from 0 to negative offsets.
      position: Math.abs(container.scrollLeft),
      length: Math.max(0, container.scrollWidth - container.clientWidth),
      visible: container.clientWidth,
    };
  }

  scrollToPosition(position: number): void {
    const metrics = this.scrollMetrics();
    const container = this.manager()?.container;
    if (!metrics || !container || this.turnPending || this.layoutPending) return;
    if (!Number.isFinite(position)) return;
    const target = Math.min(metrics.length, Math.max(0, position));
    if (metrics.axis === "vertical") container.scrollTop = target;
    else container.scrollLeft = metrics.reversed ? -target : target;
  }

  private onScroll = () => {
    this.notifyScroll();
    clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = undefined;
      void this.settleScroll();
    }, SCROLL_SETTLE_MS);
  };

  settlePosition(): void {
    if (this.scrollTimer === undefined || !this.continuous || !this.ready || this.disposed) return;
    if (this.turnPending || this.layoutPending || this.reflowPending()) return;
    const settled = this.continuousPosition();
    if (
      !settled ||
      (this.published?.spineIndex === settled.locator.spineIndex &&
        this.published.progress === settled.locator.progress)
    )
      return;
    // Published at once, as the settle would; that settle then finds it published.
    this.jumpedEntryId = undefined;
    this.reflowAnchor = undefined;
    this.progressRevision++;
    this.settledAnchor = anchorAt(settled);
    this.published = { spineIndex: settled.locator.spineIndex, progress: settled.locator.progress };
    this.onLocationChanged?.(settled.locator);
    this.publishProgress(settled);
  }

  /**
   * Once a continuous book stops scrolling, its first character in view is the reading
   * point: it is published like a turn's, unless it is the one already published, as
   * when EPUB.js keeps it in view while adding a section. A navigation publishes its
   * own point.
   */
  private async settleScroll(): Promise<void> {
    const rendition = this.rendition;
    const book = this.book;
    if (!rendition || !book || !this.continuous || !this.ready || this.disposed) return;
    if (this.turnPending || this.layoutPending) return;
    // Until the host's size is followed, the view is where EPUB.js's own layout left it,
    // and the reading point is the one kept from before, which that reflow publishes.
    if (this.reflowPending()) return;
    const settled = this.continuousPosition();
    if (this.axisConflict) {
      if (!settled) return;
      this.turnPending = true;
      this.onPageTurnsChanged?.(unavailable);
      try {
        await this.redisplay(rendition, book, anchorAt(settled));
        if (this.disposed) return;
        await this.publishLocation();
      } finally {
        this.turnPending = false;
        if (!this.disposed) await this.refreshPageTurns();
      }
      return;
    }
    const kept =
      settled &&
      this.published?.spineIndex === settled.locator.spineIndex &&
      this.published.progress === settled.locator.progress;
    if (settled && !kept) {
      this.jumpedEntryId = undefined;
      this.reflowAnchor = undefined;
      await this.publishLocation();
    }
    await this.refreshPageTurns();
  }

  scrollBy(distance: number): boolean {
    if (!this.continuous || !this.ready || this.disposed) return true;
    if (this.turnPending || this.layoutPending || !Number.isFinite(distance)) return true;
    // Reading on at a chapter's end, or back at its start, turns to the next chapter.
    if (distance && this.atChapterEdge(distance > 0 ? "advance" : "retreat")) return false;
    this.scrollReading(distance);
    return true;
  }

  /** Scroll a continuous book by a distance along its reading order. */
  private scrollReading(distance: number): void {
    const manager = this.manager();
    const container = manager?.container;
    if (!container || !distance) return;
    if (manager.settings?.axis !== "horizontal") container.scrollTop += distance;
    else if (this.rendition && readingDirection(this.rendition) === "rtl")
      container.scrollLeft -= distance;
    else container.scrollLeft += distance;
  }

  /** Wait for EPUB.js to add and remove sections after a scroll, in its queue. */
  private async managerSettled(): Promise<void> {
    // EPUB.js checks for sections to add 30ms after the last scroll event.
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (this.disposed) return;
    const manager = this.manager();
    // A section that never finishes rendering must not hold the Reader, so each wait
    // is bounded like the wait for a relocation.
    await settledWithin(manager?.q?.enqueue(() => undefined));
    // Its earlier update may have queued an off-screen view's destroy just before a
    // jump moved that view on screen. Refresh it after those queued destroys settle.
    if (!this.disposed) await settledWithin(manager?.update?.());
    await settledWithin(manager?.q?.enqueue(() => undefined));
  }

  /**
   * Scroll a continuous book so a point of a displayed section begins the reading area,
   * again once EPUB.js has added the sections around it, which can move it.
   */
  private async scrollToPoint(
    contents: EpubPageContents,
    point: Range | Element,
    valid: () => boolean = () => !this.disposed,
  ): Promise<void> {
    if (!valid()) return;
    if (this.chapterView) {
      await this.showChapterOf(contents, point);
      if (!valid()) return;
      // A chapter's start shows from the start of its scroll, so a heading whose first
      // character is smaller than the rest shows whole.
      if (this.atChapterStart(contents, point)) {
        this.scrollToChapterEdge("start");
        await this.managerSettled();
        if (!valid()) return;
        this.applyChapterBounds();
        this.scrollToChapterEdge("start");
        return;
      }
    }
    this.alignPoint(contents, point);
    for (let pass = 0; pass < 2; pass++) {
      await this.managerSettled();
      if (!valid()) return;
      if (this.chapterView) this.applyChapterBounds();
      if (this.alignPoint(contents, point) < 1) return;
    }
  }

  /** Scroll so the point's line begins the reading area; the distance scrolled. */
  private alignPoint(contents: EpubPageContents, point: Range | Element): number {
    const container = this.manager()?.container;
    const frame = contents.document.defaultView?.frameElement;
    const box =
      frame &&
      ((point as Element).nodeType === Node.ELEMENT_NODE
        ? (point as Element).getBoundingClientRect()
        : pointRect(point as Range));
    if (!container || !frame || !box) return 0;
    const span = this.blockSpan();
    const [start] = span(pageBox(frame.getBoundingClientRect(), box));
    const distance = start - span(container.getBoundingClientRect())[0];
    this.scrollReading(distance);
    return Math.abs(distance);
  }

  /** Scroll a continuous book to the start of a displayed section. */
  private async showSectionStart(rendition: Rendition, spineIndex: number): Promise<boolean> {
    // EPUB.js can prepend several earlier sections during a distant jump, leaving the
    // requested section outside the viewport and its iframe unloaded. Bring its view
    // on screen before asking for its first content point.
    for (let pass = 0; pass < 3; pass++) {
      const manager = this.manager();
      const container = manager?.container;
      const view = manager?.views?.all().find((item) => item.section.index === spineIndex);
      if (container && view) {
        const span = this.blockSpan();
        this.scrollReading(
          span(view.element.getBoundingClientRect())[0] -
            span(container.getBoundingClientRect())[0],
        );
        await this.managerSettled();
      }
      const contents = sectionContents(rendition, spineIndex);
      const body = contents?.document.body;
      if (contents && body) {
        const start = contents.document.createRange();
        start.selectNodeContents(body);
        start.collapse(true);
        await this.scrollToPoint(contents, start);
        return true;
      }
      if (!view || this.disposed) return false;
    }
    return false;
  }

  /**
   * A rectangle's extent along a continuous book's reading order, in viewport pixels:
   * down for horizontal text, and leftwards for vertical text read right to left.
   */
  private blockSpan(): BlockSpan {
    const manager = this.manager();
    const rtl = !!this.rendition && readingDirection(this.rendition) === "rtl";
    if (manager?.settings?.axis !== "horizontal") return (rect) => [rect.top, rect.bottom];
    return rtl ? (rect) => [-rect.right, -rect.left] : (rect) => [rect.left, rect.right];
  }

  /**
   * The reading point of a continuous book: its first character (or image) at least
   * half in view, in reading order across the displayed sections, and the point just
   * after its last one. With nothing in view, the first character after it. A chapter
   * view shows nothing outside its chapter, even where its reading area goes beyond it.
   */
  private continuousPosition(): DisplayedPosition | undefined {
    const manager = this.manager();
    const container = manager?.container;
    // A long book's released sections hold their places among the loaded ones.
    let views = (
      (this.limitsLoadedSections ? manager?.views?.all() : manager?.views?.displayed()) ?? []
    ).filter((view) => !this.collapsedViews.has(view.element));
    if (!container || !views.length) return undefined;
    const span = this.blockSpan();
    let area = span(container.getBoundingClientRect());
    if (this.chapterView && this.shownChapter !== undefined) {
      const first = views[0].element;
      const last = views[views.length - 1].element;
      area = [
        Math.max(area[0], span(first.getBoundingClientRect())[0] + this.clippedStart(first)),
        Math.min(area[1], span(last.getBoundingClientRect())[1]),
      ];
    }
    if (this.limitsLoadedSections) {
      const start = area[0];
      views = views.slice(
        firstIndex(views, (view) => span(view.element.getBoundingClientRect())[1] > start),
      );
    }
    let pageStart: PagePoint | undefined;
    let pageEnd: PagePoint | undefined;
    for (const view of views) {
      const document = view.contents?.document;
      const frame = document?.defaultView?.frameElement;
      if (!document?.body || !frame) {
        if (this.limitsLoadedSections) {
          // The text in view is unknown until the sections there load.
          const [start, end] = span(view.element.getBoundingClientRect());
          if (pageStart && start >= area[1]) break;
          if (end > start) return undefined;
        }
        continue;
      }
      const [, end] = span(frame.getBoundingClientRect());
      if (end <= area[0]) continue;
      const found = viewportEdges(document, frame.getBoundingClientRect(), area, span);
      const spineIndex = view.section.index;
      if (found.first && !pageStart) pageStart = { spineIndex, document, ...found.first };
      if (found.last) pageEnd = { spineIndex, document, ...found.last };
      if (found.beyond) break;
    }
    if (!pageStart) return undefined;
    const section = this.book?.spine.get(pageStart.spineIndex) as { href?: string } | null;
    if (!section?.href) return undefined;
    const progress =
      continuousTextProgress(pageStart.document, pageStart.node, pageStart.offset) ?? 0;
    return {
      locator: {
        spineIndex: pageStart.spineIndex,
        sectionKey: sectionKey(section.href),
        progress: Math.min(1, Math.max(0, progress)),
      },
      atEnd: this.continuousEdges().atEnd,
      pageStart,
      pageEnd,
    };
  }

  /**
   * Whether a continuous book shows its first section's start, or its last one's end: in
   * a chapter view, whether it shows its first chapter's start or its last chapter's end.
   */
  private continuousEdges(): { atStart: boolean; atEnd: boolean } {
    if (this.chapterView && this.shownChapter !== undefined) {
      const { atStart, atEnd } = this.scrollEdges();
      return {
        atStart: atStart && this.shownChapter === 0,
        atEnd: atEnd && this.shownChapter === this.chapters.length - 1,
      };
    }
    const manager = this.manager();
    const container = manager?.container;
    const views = manager?.views?.displayed() ?? [];
    const first = views[0];
    const last = views.at(-1);
    if (!container || !first || !last) return { atStart: true, atEnd: true };
    const span = this.blockSpan();
    const area = span(container.getBoundingClientRect());
    return {
      atStart:
        !first.section.prev() && span(first.element.getBoundingClientRect())[0] >= area[0] - 1,
      atEnd: !last.section.next() && span(last.element.getBoundingClientRect())[1] <= area[1] + 1,
    };
  }

  /** Whether a continuous book is scrolled to its start or its end. */
  private scrollEdges(): { atStart: boolean; atEnd: boolean } {
    const manager = this.manager();
    const container = manager?.container;
    if (!container) return { atStart: true, atEnd: true };
    const horizontal = manager.settings?.axis === "horizontal";
    // A right-to-left book scrolls from 0 to negative offsets.
    const position = horizontal ? Math.abs(container.scrollLeft) : container.scrollTop;
    const length = horizontal
      ? container.scrollWidth - container.clientWidth
      : container.scrollHeight - container.clientHeight;
    return { atStart: position <= 1, atEnd: position >= length - 1 };
  }

  /** Scroll a continuous book to its start or its end. */
  private scrollToChapterEdge(edge: "start" | "end"): void {
    const manager = this.manager();
    const container = manager?.container;
    if (!container) return;
    if (manager.settings?.axis !== "horizontal") {
      container.scrollTop = edge === "start" ? 0 : container.scrollHeight - container.clientHeight;
      return;
    }
    const length = container.scrollWidth - container.clientWidth;
    const rtl = !!this.rendition && readingDirection(this.rendition) === "rtl";
    container.scrollLeft = edge === "start" ? 0 : rtl ? -length : length;
  }

  /**
   * Whether a chapter view is scrolled to its chapter's end, reading on, or its start,
   * reading back, and another chapter follows or precedes it.
   */
  private atChapterEdge(direction: "advance" | "retreat"): boolean {
    const shown = this.shownChapter;
    if (!this.chapterView || shown === undefined) return false;
    const { atStart, atEnd } = this.scrollEdges();
    return direction === "advance"
      ? atEnd && shown + 1 < this.chapters.length
      : atStart && shown > 0;
  }

  /**
   * Where a chapter view's chapters begin, in reading order: at the book's start and at
   * each navigable contents destination in a linear section, as in book progress. A
   * missing anchor begins its chapter at its section's start. Starts with no counted text
   * between them share one chapter, which begins at the first of them, and a start with
   * no counted text after it begins none. Without destinations, each linear section with
   * counted text begins a chapter. The text is read from each section's document.
   */
  private async findChapterStarts(book: Book): Promise<ChapterStart[]> {
    const sections: Array<{ linear?: boolean; url?: string; document?: Document }> = [];
    book.spine.each((section: (typeof sections)[number]) => sections.push(section));
    const fragments = new Map<number, Set<string>>();
    for (const destination of this.destinations.values()) {
      const index = sections.indexOf(book.spine.get(destination) as (typeof sections)[number]);
      if (index < 0 || !sections[index].linear) continue;
      if (!fragments.has(index)) fragments.set(index, new Set());
      fragments.get(index)?.add(destination.split("#")[1] ?? "");
    }
    const candidates: Array<ChapterStart & { offset: number; raw: number }> = [];
    let total = 0;
    for (const [index, section] of sections.entries()) {
      if (!section.linear) continue;
      if (!candidates.length) candidates.push({ spineIndex: index, offset: 0, raw: -1 });
      let document: Document | undefined = section.document;
      if (!document?.body && section.url) {
        document = (await book.load(section.url).catch(() => undefined)) as Document | undefined;
        if (this.disposed) return [];
      }
      if (!document?.body) continue;
      const length = countUnits(readableText(document), "characters");
      if (!fragments.size && length > 0)
        candidates.push({ spineIndex: index, offset: total, raw: 0 });
      for (const fragment of fragments.get(index) ?? []) {
        const anchor = anchorPosition(document, fragment);
        candidates.push({
          spineIndex: index,
          anchorId: anchor.id,
          offset: total + Math.min(anchor.units.characters, length),
          raw: anchor.raw,
        });
      }
      total += length;
    }
    candidates.sort((a, b) => a.offset - b.offset || a.spineIndex - b.spineIndex || a.raw - b.raw);
    const starts: ChapterStart[] = [];
    let previous: number | undefined;
    for (const { spineIndex, anchorId, offset } of candidates) {
      if (previous !== undefined && (offset === previous || offset >= total)) continue;
      previous = offset;
      starts.push(anchorId === undefined ? { spineIndex } : { spineIndex, anchorId });
    }
    return starts;
  }

  /** VN groups restart at section boundaries and authored chapter destinations. */
  private async findVnStarts(book: Book): Promise<ChapterStart[]> {
    const sections: Array<{ linear?: boolean; url?: string; document?: Document }> = [];
    book.spine.each((section: (typeof sections)[number]) => sections.push(section));
    const starts: ChapterStart[] = [];
    for (const [spineIndex, section] of sections.entries()) {
      if (this.disposed) return [];
      if (!section.linear) continue;
      const document =
        section.document ??
        ((section.url ? await book.load(section.url) : undefined) as Document | undefined);
      if (this.disposed) return [];
      const blocks = document ? this.blocks(document) : [];
      const anchors = document
        ? [...this.destinations.values()].flatMap((destination) => {
            if (book.spine.get(destination) !== section) return [];
            const anchor = document.getElementById(destination.split("#")[1] ?? "");
            return anchor ? [anchor] : [];
          })
        : [];
      const groups = vnGroupStarts(blocks, this.presentation.vnParagraphs, anchors);
      if (!groups.length) starts.push({ spineIndex });
      else starts.push(...groups.map((blockIndex) => ({ spineIndex, blockIndex })));
      // Preflight bounds book bytes; cap derived navigation independently.
      if (starts.length > 100_000) throw new EpubResourceLimit();
    }
    return starts;
  }

  /** Show the chapter holding a point of a displayed section, in a chapter view. */
  private async showChapterOf(contents: EpubPageContents, point: Range | Element): Promise<void> {
    const book = this.book;
    if (!book || contents.sectionIndex === undefined) return;
    if (this.vnView) {
      this.vnStarts ??= this.findVnStarts(book);
      this.chapters = await this.vnStarts;
    } else {
      this.chapterStarts ??= this.findChapterStarts(book);
      this.chapters = await this.chapterStarts;
    }
    if (this.disposed || !this.chapterView) return;
    this.vnReveal.clear();
    this.shownChapter = chapterAt(this.chapters, contents.sectionIndex, contents.document, point);
    this.applyChapterBounds();
    // The Reader scrolls to the point itself.
    this.resyncSectionExtents();
  }

  /** Show the chapter of the first character in view and keep that character in view. */
  private async showReadingChapter(): Promise<void> {
    const rendition = this.rendition;
    const start = this.continuousPosition()?.pageStart;
    const contents = rendition && start && sectionContents(rendition, start.spineIndex);
    if (!start || !contents || contents.document !== start.document) return;
    const point = start.document.createRange();
    point.setStart(start.node, start.offset);
    point.collapse(true);
    await this.scrollToPoint(contents, point);
  }

  /**
   * Show only the chapter a chapter view shows: collapse the sections outside it, and clip
   * the sections it begins or ends within at the contents destinations there. Without a
   * shown chapter, every section shows whole.
   */
  private applyChapterBounds(): void {
    const views = this.manager()?.views?.all() ?? [];
    // Measure every clip before changing any.
    const clips = views.map((view) => this.chapterClip(view));
    views.forEach((view, index) => this.setClip(view.element, clips[index]));
    // A VN group's text is masked before it first paints, never shown whole for a moment.
    if (this.vnView && this.ready) this.updateVnReveal();
  }

  private clipView(view: EpubView): void {
    this.setClip(view.element, this.chapterClip(view));
    if (this.vnView && this.ready) this.updateVnReveal();
  }

  /**
   * How a section shows in the shown chapter: not at all, or from a distance along the
   * reading order to another. A section where the chapter begins or ends at an anchor
   * stays collapsed until it is rendered and the anchor can be measured.
   */
  private chapterClip(view: EpubView): ChapterClip | undefined {
    const shown = this.shownChapter;
    const start = shown === undefined ? undefined : this.chapters[shown];
    if (!this.chapterView || shown === undefined || !start) return undefined;
    const end = this.chapters[shown + 1];
    const index = view.section.index;
    if (index < start.spineIndex || (end && index > end.spineIndex)) return "collapsed";
    // A VN group never crosses a section, even where the next one begins after some space.
    if (this.vnView && index !== start.spineIndex) return "collapsed";
    const sliced =
      index === start.spineIndex && (start.anchorId !== undefined || start.blockIndex !== undefined)
        ? this.sliceOffset(view, start)
        : 0;
    // Furigana standing out before a VN group's first line show with it.
    const ink = typeof sliced === "number" ? this.vnInkStart(view, start) : undefined;
    const from = ink === undefined || typeof sliced !== "number" ? sliced : Math.min(sliced, ink);
    const to =
      end && index === end.spineIndex
        ? end.anchorId === undefined && end.blockIndex === undefined
          ? 0
          : (this.vnGroupEnd(view, start, end) ?? this.sliceOffset(view, end))
        : (this.vnGroupEnd(view, start, end) ?? Infinity);
    if (typeof from !== "number" || typeof to !== "number" || to <= from) return "collapsed";
    return {
      from,
      to,
      lead: this.vnView
        ? this.vnLead(view, from, to)
        : index === start.spineIndex
          ? (this.presentation.fontSize ?? readerFontSize.default) * 2
          : 0,
      across: this.vnAcross(view, start, end),
    };
  }

  /**
   * How far a VN group narrower than the reading area moves across the reading order so
   * that it shows centered there too: horizontally in horizontal text, vertically in
   * vertical text. Its lines keep their authored alignment to one another, and a group as
   * wide as the area barely moves. Zero outside VN or before the section is rendered.
   */
  private vnAcross(view: EpubView, start: ChapterStart, end: ChapterStart | undefined): number {
    const document = view.contents?.document;
    const frame = document?.defaultView?.frameElement;
    const container = this.manager()?.container;
    if (
      !this.vnView ||
      start.blockIndex === undefined ||
      start.spineIndex !== view.section.index ||
      !document ||
      !frame ||
      !container
    )
      return 0;
    const blocks = this.blocks(document);
    const last =
      end?.spineIndex === start.spineIndex && end.blockIndex !== undefined
        ? end.blockIndex
        : blocks.length;
    const across = this.acrossSpan();
    const range = document.createRange();
    let low = Infinity;
    let high = -Infinity;
    for (const block of blocks.slice(start.blockIndex, last)) {
      range.selectNodeContents(block.element);
      for (const box of range.getClientRects()) {
        if (!box.width && !box.height) continue;
        const [boxStart, boxEnd] = across(box);
        low = Math.min(low, boxStart);
        high = Math.max(high, boxEnd);
      }
    }
    if (!(high > low)) return 0;
    // Where the frame starts before the move already made, so measuring again keeps it.
    const frameStart = across(frame.getBoundingClientRect())[0] - this.acrossMove(view.element);
    const [areaStart, areaEnd] = across(container.getBoundingClientRect());
    const move = Math.round((areaStart + areaEnd) / 2 - frameStart - (low + high) / 2);
    return Math.abs(move) < 2 ? 0 : move;
  }

  /** A box's extent across the reading order: horizontal for horizontal text. */
  private acrossSpan(): BlockSpan {
    return this.manager()?.settings?.axis === "horizontal"
      ? (rect) => [rect.top, rect.bottom]
      : (rect) => [rect.left, rect.right];
  }

  /** The style property a VN group moves across the reading order with. */
  private acrossProperty(): "margin-top" | "margin-left" {
    return this.manager()?.settings?.axis === "horizontal" ? "margin-top" : "margin-left";
  }

  /** How far a section was moved across the reading order to center its VN group. */
  private acrossMove(element: HTMLElement): number {
    return parseFloat(element.style.getPropertyValue(this.acrossProperty())) || 0;
  }

  /**
   * Where a VN group's first block's text, ruby and images begin along the reading order,
   * never before the section's start. Undefined outside VN or before it is rendered.
   */
  private vnInkStart(view: EpubView, start: ChapterStart): number | undefined {
    const document = view.contents?.document;
    const frame = document?.defaultView?.frameElement;
    if (!this.vnView || start.blockIndex === undefined || !document || !frame) return undefined;
    const first = this.blocks(document)[start.blockIndex];
    if (!first) return undefined;
    const range = document.createRange();
    range.selectNodeContents(first.element);
    const origin = frame.getBoundingClientRect();
    const span = this.blockSpan();
    const starts = [...range.getClientRects()]
      .filter((box) => box.width || box.height)
      .map((box) => span(pageBox(origin, box))[0] - span(origin)[0]);
    return starts.length ? Math.max(0, Math.floor(Math.min(...starts))) : undefined;
  }

  /**
   * Where a VN group's last block ends along the reading order, so that blank paragraphs
   * and margins after it, and the next group's ruby, never show with it. Undefined outside
   * VN or before the section is rendered.
   */
  private vnGroupEnd(
    view: EpubView,
    start: ChapterStart,
    end: ChapterStart | undefined,
  ): number | undefined {
    const document = view.contents?.document;
    const frame = document?.defaultView?.frameElement;
    if (
      !this.vnView ||
      start.blockIndex === undefined ||
      start.spineIndex !== view.section.index ||
      !document ||
      !frame
    )
      return undefined;
    const blocks = this.blocks(document);
    const last =
      blocks[(end?.spineIndex === start.spineIndex ? end.blockIndex! : blocks.length) - 1];
    if (!last) return undefined;
    const range = document.createRange();
    range.selectNodeContents(last.element);
    let text: Node | null = null;
    const walker = document.createTreeWalker(last.element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) text = node;
    if (text) range.setEnd(text, (text as Text).data.length);
    const origin = frame.getBoundingClientRect();
    const span = this.blockSpan();
    const ends = [...range.getClientRects()]
      .filter((box) => box.width || box.height)
      .map((box) => span(pageBox(origin, box))[1] - span(origin)[0]);
    return ends.length ? Math.ceil(Math.max(...ends)) : undefined;
  }

  /**
   * How far a VN group shorter than the reading area begins along the reading order, so
   * that it shows centered: vertically in horizontal text, horizontally in vertical text.
   */
  private vnLead(view: EpubView, from: number, to: number): number {
    const frame = view.contents?.document?.defaultView?.frameElement;
    const container = this.manager()?.container;
    if (!this.vnView || !frame || !container) return 0;
    const span = this.blockSpan();
    const [start, end] = span(frame.getBoundingClientRect());
    const [areaStart, areaEnd] = span(container.getBoundingClientRect());
    const shown = Math.min(to, end - start) - from;
    return Math.max(0, Math.floor((areaEnd - areaStart - shown) / 2));
  }

  /**
   * Collapse a section to nothing along the reading order, or clip what lies before and
   * after its part of the chapter. The part before lies beyond the scroll's start, where
   * it cannot be reached, or under a clip path once a VN lead centers the part; the part
   * after is cut off by the section's own overflow.
   */
  private setClip(element: HTMLElement, clip: ChapterClip | undefined): void {
    const horizontal = this.manager()?.settings?.axis === "horizontal";
    const rtl = !!this.rendition && readingDirection(this.rendition) === "rtl";
    const extent = horizontal ? "max-width" : "max-height";
    const margin = horizontal ? (rtl ? "margin-right" : "margin-left") : "margin-top";
    const values = new Map<string, string>();
    if (clip === "collapsed") values.set(extent, "0px");
    else if (clip) {
      const offset = clip.lead - clip.from;
      if (offset) values.set(margin, `${offset}px`);
      // A lead brings what is clipped before the chapter/group back into view; hide it there.
      if (clip.lead > 0 && clip.from > 0)
        values.set(
          "clip-path",
          horizontal
            ? rtl
              ? `inset(0px ${clip.from}px 0px 0px)`
              : `inset(0px 0px 0px ${clip.from}px)`
            : `inset(${clip.from}px 0px 0px 0px)`,
        );
      if (Number.isFinite(clip.to)) values.set(extent, `${clip.to}px`);
      if (clip.across) values.set(this.acrossProperty(), `${clip.across}px`);
    }
    for (const property of CHAPTER_CLIP_PROPERTIES) {
      const value = values.get(property) ?? "";
      if (element.style.getPropertyValue(property) === value) continue;
      if (value) element.style.setProperty(property, value, "important");
      else element.style.removeProperty(property);
    }
    if (clip === "collapsed") this.collapsedViews.add(element);
    else this.collapsedViews.delete(element);
    if (clip && clip !== "collapsed" && clip.from > 0) this.clippedStarts.set(element, clip.from);
    else this.clippedStarts.delete(element);
  }

  /** How much of a section is clipped before the shown chapter. */
  private clippedStart(element: Element): number {
    return this.clippedStarts.get(element) ?? 0;
  }

  /**
   * How far along the reading order a rendered section's element with an ID begins: at
   * its first character or, without text, its element box, as contents jumps align it,
   * or at its own box where that begins first, as a heading's line does when its first
   * character is smaller than the rest. Null when the section has no such element;
   * undefined until the section is rendered.
   */
  private sliceOffset(view: EpubView, start: ChapterStart): number | null | undefined {
    const document = view.contents?.document;
    const frame = document?.defaultView?.frameElement;
    if (!document?.body || !frame) return undefined;
    const anchor = sliceAnchor(start, document, this.blocks(document));
    if (!anchor) return null;
    const point = document.createRange();
    point.selectNodeContents(anchor);
    point.collapse(true);
    const origin = frame.getBoundingClientRect();
    const span = this.blockSpan();
    // A heading's ruby can stand outside both its base character and block box.
    const ruby = Array.from(anchor.querySelectorAll("rt"), (element) =>
      element.getBoundingClientRect(),
    );
    const starts = [pointRect(point), anchor.getBoundingClientRect(), ...ruby]
      .filter((box) => box && (box.width || box.height))
      .map((box) => span(pageBox(origin, box!))[0] - span(origin)[0]);
    return starts.length ? Math.max(0, Math.min(...starts)) : 0;
  }

  /** Whether a point of a displayed section begins the shown chapter, with no text before it. */
  private atChapterStart(contents: EpubPageContents, point: Range | Element): boolean {
    const start = this.shownChapter === undefined ? undefined : this.chapters[this.shownChapter];
    const document = contents.document;
    if (!start || start.spineIndex !== contents.sectionIndex || !document.body) return false;
    const before = document.createRange();
    const anchor = sliceAnchor(start, document, this.blocks(document));
    if (anchor?.parentNode) before.setStartBefore(anchor);
    else before.setStart(document.body, 0);
    try {
      if ((point as Element).nodeType === Node.ELEMENT_NODE) before.setEndBefore(point as Element);
      else before.setEnd((point as Range).startContainer, (point as Range).startOffset);
    } catch {
      return false;
    }
    return !before.toString().trim();
  }

  /**
   * A presentation this book can take: fixed-layout pages keep their typography, writing
   * mode, text orientation, paragraph margins, furigana, unblurred images, colors and
   * spreads, and turn one at a time.
   */
  private normalize(presentation?: ReaderPresentation): NormalizedPresentation {
    const next = normalizePresentation(presentation);
    return this.fixedLayout
      ? {
          ...next,
          fontPair: undefined,
          fontFamilyGroup1: undefined,
          fontFamilyGroup2: undefined,
          fontSize: undefined,
          lineHeight: undefined,
          fontWeight: undefined,
          paragraphIndent: undefined,
          paragraphMargin: undefined,
          letterSpacing: undefined,
          wordSpacing: undefined,
          writingMode: undefined,
          textOrientation: undefined,
          textJustification: false,
          prettyTextWrap: false,
          hideFurigana: false,
          furiganaStyle: "hide",
          blurImage: false,
          blurMode: "all",
          textColor: undefined,
          selectionColor: undefined,
          highlightColor: undefined,
          pageLayout: undefined,
          viewMode: "paginated",
          centerImages: false,
        }
      : next;
  }

  private manager(): EpubManager | undefined {
    return (this.rendition as unknown as { manager?: EpubManager } | undefined)?.manager;
  }

  /**
   * The gap EPUB.js leaves between horizontal columns, half of it on each outer side, so
   * every page has the chosen margin on its left and right, including both pages of a
   * spread. Without a chosen margin, a maximum text width keeps 20px on each side, and
   * otherwise EPUB.js's automatic gap, a twelfth of the width, applies. Vertical
   * sections keep it too, because their gap is the space above and below each page;
   * their left and right margins are styled in each section instead. Many vertical
   * books say so only in their CSS, so the axis is the one EPUB.js found for the
   * displayed section. A margin never takes more than a quarter of a page, so at least
   * half of it keeps text.
   */
  private pageGap(): number | undefined {
    const margin = this.presentation.sideMargin;
    const manager = this.manager();
    if (manager?.settings?.axis === "vertical") return undefined;
    if (margin === undefined) return this.presentation.maxWidth === undefined ? undefined : 40;
    const width = manager?._stageSize?.width ?? this.host?.clientWidth ?? 0;
    const layout = manager?.layout;
    const pages = layout?._spread && width >= (layout._minSpreadWidth ?? 800) ? 2 : 1;
    return 2 * Math.min(margin, Math.floor(width / pages / 4));
  }

  /** The first displayed character, kept as a reading point across a reflow. */
  private async displayedAnchor(): Promise<ReflowAnchor | undefined> {
    const settled = await this.displayedLocator();
    return settled && anchorAt(settled);
  }

  /**
   * The contents entries of navigation items whose links are relative to `base`, with each
   * destination recorded, and whether an entry names a document the book cannot open.
   */
  private async normalizeContents(
    items: unknown,
    book: Book,
    navigation?: { landmark?(type: string): unknown },
    base = navigationBase(book),
  ): Promise<{ entries: ReaderContentsEntry[]; leadsNowhere: boolean }> {
    if (!Array.isArray(items)) return { entries: [], leadsNowhere: false };
    // Entries whose document is not in the spine, resolved once the tree is built.
    const offSpine: Array<{ entry: ReaderContentsEntry; path: string }> = [];
    const normalize = (nodes: unknown[], trail: string): ReaderContentsEntry[] =>
      nodes.flatMap((raw, index) => {
        if (!raw || typeof raw !== "object") return [];
        const item = raw as { label?: unknown; href?: unknown; subitems?: unknown };
        const label = typeof item.label === "string" ? item.label : "";
        const id = `${trail}${index}`;
        // An entry without a label, such as a part titled with an ideographic space, shows
        // its own entries in its place.
        if (!label.trim())
          return Array.isArray(item.subitems) ? normalize(item.subitems, `${id}.`) : [];
        const href = typeof item.href === "string" ? item.href : "";
        const entry: ReaderContentsEntry = { id, label, navigable: false, children: [] };
        const target = resolveNavHref(href, base);
        if (target !== null) {
          entry.navigable = true;
          if (book.spine.get(target)) this.destinations.set(id, target);
          else if (book.spine.get(href)) this.destinations.set(id, href);
          else offSpine.push({ entry, path: target.split("#")[0] });
        }
        entry.children = Array.isArray(item.subitems) ? normalize(item.subitems, `${id}.`) : [];
        return [entry];
      });
    const entries = normalize(items, "toc.");
    let leadsNowhere = false;
    if (offSpine.length) {
      // A converter can drop a book's own cover page from the spine and add its own cover
      // page in its place, leaving the contents pointing at the dropped page. An image-only
      // page outside the spine therefore opens the declared cover page. EPUB.js displays
      // only spine documents, so any other entry outside the spine is not navigable.
      const cover = await spineCoverPage(book, navigation, navigationBase(book));
      for (const { entry, path } of offSpine) {
        if (cover && (await imageOnlyPage(book, path))) this.destinations.set(entry.id, cover);
        else {
          entry.navigable = false;
          leadsNowhere = true;
        }
      }
    }
    return { entries, leadsNowhere };
  }

  private async turnPage(direction: "advance" | "retreat"): Promise<void> {
    const rendition = this.rendition;
    if (!rendition || this.disposed || this.turnPending || this.layoutPending) return;
    this.turnPending = true;
    this.jumpedEntryId = undefined;
    this.reflowAnchor = undefined;
    try {
      if (this.continuous) {
        if (this.atChapterEdge(direction)) {
          // A chapter view shows the next chapter from its start, or the previous one
          // from its end, once its sections have loaded.
          const chapter = (this.shownChapter ?? 0) + (direction === "advance" ? 1 : -1);
          if (this.sectionsLoading && !this.chapterLoaded(chapter)) {
            await this.sectionsLoaded();
            if (this.disposed) return;
          }
          this.shownChapter = chapter;
          this.applyChapterBounds();
          this.resyncSectionExtents();
          this.scrollToChapterEdge(direction === "advance" ? "start" : "end");
        } else {
          // A continuous book moves by most of the reading area, keeping a little in view.
          const container = this.manager()?.container;
          const extent = this.scrollsHorizontally()
            ? (container?.clientWidth ?? 0)
            : (container?.clientHeight ?? 0);
          const distance = Math.round(extent * CONTINUOUS_PAGE);
          this.scrollReading(direction === "advance" ? distance : -distance);
        }
        await this.managerSettled();
        if (this.disposed) return;
        await this.refreshPageTurns();
        await this.publishLocation();
        return;
      }
      const before =
        direction === "retreat" ? await this.currentBookLocation(rendition) : undefined;
      if (this.disposed) return;
      const moved = this.waitForRelocation(rendition);
      this.turningPage = true;
      try {
        if (direction === "advance") await rendition.next();
        else await rendition.prev();
      } finally {
        this.turningPage = false;
        this.releaseHeldViews?.();
      }
      const relocated = await this.navigatedLocation(rendition, moved);
      if (this.disposed) return;
      const after = relocated ?? (await this.currentBookLocation(rendition));
      // Both pages of an image spread are in view already, as is a fixed-layout page.
      if (direction === "retreat" && !this.showsImageSpread() && !this.fixedLayout) {
        if (
          !this.disposed &&
          before?.start?.index !== undefined &&
          after?.start?.index !== undefined &&
          after.start.index < before.start.index
        ) {
          // EPUB.js can land on page one when retreating across a spine edge.
          // Target the previous section's final content in the current layout,
          // paging vertical sections by height like any other point.
          const contents =
            sectionContents(rendition, after.start.index) ??
            (rendition.getContents() as unknown as EpubPageContents[]).at(-1);
          const point = contents && lastContentPoint(contents);
          const href =
            after.start.href ??
            (this.book?.spine.get(after.start.index) as { href?: string } | null)?.href;
          if (contents && point && href) {
            const positioned = this.waitForRelocation(rendition);
            await this.displayPoint(rendition, contents, point, href, positioned);
            await this.navigatedLocation(rendition, positioned);
          }
        }
      }
      if (!this.disposed) await this.refreshPageTurns();
      await this.publishLocation();
    } finally {
      this.turnPending = false;
    }
  }

  private async restore(rendition: Rendition, book: Book, locator: ReaderLocator, strict = false) {
    const section = book.spine.get(locator.spineIndex) as { href?: string } | null;
    if (!section?.href) return false;
    // After a relink, the same spine position may hold a different section.
    if (locator.sectionKey && locator.sectionKey !== sectionKey(section.href)) return false;
    try {
      const relocation = this.waitForRelocation(rendition);
      await rendition.display(section.href);
      if (this.disposed) return false;
      if (this.continuous && !(await this.showSectionStart(rendition, locator.spineIndex)))
        return false;
      const contents = sectionContents(rendition, locator.spineIndex);
      const point =
        contents && locator.progress > 0 && pointAtProgress(contents.document, locator.progress);
      // Resume retains its authored-start fallback. A bookmark must resolve its point.
      if (strict && (!contents || (locator.progress > 0 && !point))) return false;
      if (point) await this.displayPoint(rendition, contents, point, section.href, relocation);
      return !this.disposed;
    } catch {
      return false;
    }
  }

  /** Show the page of the displayed section that contains a text point. */
  private async displayPoint(
    rendition: Rendition,
    contents: EpubPageContents,
    point: Range,
    sectionHref: string,
    relocation?: Promise<DisplayedBookLocation | undefined>,
    valid: () => boolean = () => !this.disposed,
  ): Promise<void> {
    if (!valid()) return;
    if (this.continuous) {
      await this.scrollToPoint(contents, point, valid);
      return;
    }
    const root = contents.document.documentElement;
    const vertical = contents.document.defaultView
      ?.getComputedStyle(root)
      .writingMode?.startsWith("vertical");
    if (!vertical) {
      const { target, release } = horizontalTarget(contents, point, sectionHref);
      try {
        await rendition.display(target);
      } finally {
        release?.();
      }
      return;
    }
    // EPUB.js's vertical moveTo rounds a target to the horizontal page width, so
    // display(cfi) can miss the page. Its next() pages by height; scroll by the same
    // page height once rather than once per page, which is slow in a long section.
    const pageHeight = this.host?.clientHeight ?? 0;
    const top = pointTop(point);
    await rendition.display(sectionHref);
    if (!valid() || !pageHeight || top === null) return;
    const total = (await this.settledLocation(rendition, relocation))?.start?.displayed?.total ?? 1;
    const pages = Math.min(total - 1, Math.floor(top / pageHeight));
    const manager = (rendition as unknown as { manager?: EpubManager }).manager;
    if (!valid() || pages <= 0 || !manager) return;
    const moved = this.waitForRelocation(rendition);
    manager.scrollBy(0, pages * manager.layout.height, true);
    void rendition.reportLocation();
    await this.navigatedLocation(rendition, moved);
  }

  /** Report the first displayed text position as a locator and as book progress. */
  private async publishLocation(
    relocation?: Promise<DisplayedBookLocation | undefined>,
    valid: () => boolean = () => !this.disposed,
  ): Promise<void> {
    const revision = ++this.progressRevision;
    const settled = await this.displayedLocator(relocation);
    if (!settled || !valid()) return;
    this.updateVnReveal();
    await this.refreshPageTurns();
    this.settledAnchor = anchorAt(settled);
    this.published = { spineIndex: settled.locator.spineIndex, progress: settled.locator.progress };
    this.onLocationChanged?.(settled.locator);
    if (revision === this.progressRevision) this.publishProgress(settled);
  }

  private publishProgress({ locator, atEnd, pageStart, pageEnd }: DisplayedPosition): void {
    const counts = this.progressCounts;
    if (!counts || this.disposed) return;
    // Without a resolvable page start, estimate from the locator's own text fraction.
    const current =
      (pageStart && this.bookOffset(counts, pageStart)) ??
      fractionOffset(counts, locator.spineIndex, locator.progress);
    if (current === undefined) return;
    // The final page reports the whole book; otherwise count the text before the page.
    const start = atEnd ? counts.total : current;
    const endOffset = pageEnd && this.bookOffset(counts, pageEnd);
    const end = atEnd ? counts.total : Math.max(start, endOffset ?? start);
    // A chapter that begins anywhere on the displayed page is the current one, so a
    // heading mid-page starts its chapter at 0.
    const starts = counts.chapterStarts;
    // A chapter view's chapter is the one it shows, including text-less pages at its end,
    // such as illustrations before the next chapter's start.
    const shown = this.shownChapterOffset(counts);
    let chapter = 0;
    while (
      chapter + 1 < starts.length &&
      (shown === undefined
        ? starts[chapter + 1] <= start || starts[chapter + 1] < end
        : starts[chapter + 1] <= shown)
    )
      chapter++;
    // A heading with nothing counted, such as an image, can be the last content of the
    // page before its chapter's text. Its chapter then starts at the page's end.
    if (
      !atEnd &&
      shown === undefined &&
      pageEnd &&
      starts[chapter + 1] === end &&
      this.headingDisplayed(counts, end, pageEnd)
    )
      chapter++;
    const chapterEnd = starts[chapter + 1] ?? counts.total;
    const chapterTotal = chapterEnd - starts[chapter];
    // Like the book, a chapter reports its whole length once its last unit is displayed.
    const chapterCurrent =
      atEnd || end >= chapterEnd
        ? chapterTotal
        : Math.min(chapterTotal, Math.max(0, start - starts[chapter]));
    const entryId =
      this.jumpedEntryId ??
      chapterEntryId(counts.chapterEntries, starts[chapter], locator.spineIndex);
    this.onProgressChanged?.({
      unit: counts.unit,
      current: start,
      total: counts.total,
      chapter: { current: chapterCurrent, total: chapterTotal, ...(entryId && { entryId }) },
    });
  }

  /** The book offset where a chapter view's shown chapter begins. */
  private shownChapterOffset(counts: BookProgressCounts): number | undefined {
    const start = this.shownChapter === undefined ? undefined : this.chapters[this.shownChapter];
    const rendition = this.rendition;
    if (!this.chapterView || !start || !rendition) return undefined;
    const document = sectionContents(rendition, start.spineIndex)?.document;
    const anchor = document ? sliceAnchor(start, document, this.blocks(document)) : null;
    if (!document || !anchor) return counts.before[start.spineIndex];
    return this.bookOffset(counts, {
      spineIndex: start.spineIndex,
      document,
      node: anchor,
      offset: 0,
    });
  }

  /** Whether the heading of a contents entry starting at a book offset is displayed. */
  private headingDisplayed(counts: BookProgressCounts, offset: number, pageEnd: PagePoint) {
    const host = this.host;
    return (
      !!host &&
      counts.chapterEntries.some(
        (entry) =>
          entry.offset === offset &&
          entry.spineIndex === pageEnd.spineIndex &&
          !!entry.anchorId &&
          anchorDisplayed(host, pageEnd.document, entry.anchorId),
      )
    );
  }

  /**
   * The book offset of a displayed point. The displayed document can differ slightly
   * from the counted one, so its units scale to the counted section, and a point with
   * nothing counted before or after it maps exactly to the section's start or end.
   */
  private bookOffset(counts: BookProgressCounts, point: PagePoint): number | undefined {
    const before = counts.before[point.spineIndex];
    if (before === undefined) return undefined;
    const length = counts.lengths[point.spineIndex] ?? 0;
    const rendered = readableUnits(point.document, counts.unit);
    const prior = readableUnitsBefore(point.document, point, counts.unit);
    const local =
      prior >= rendered ? length : prior <= 0 ? 0 : Math.round((prior / rendered) * length);
    return before + Math.min(length, local);
  }

  /**
   * Count the readable characters and words of every linear spine section, choose the
   * book's unit from its script, and resolve each contents destination to a chapter
   * start in that unit. Each section is parsed from the in-memory archive, independent
   * of the rendition, and the count yields between sections so turns stay responsive.
   */
  /**
   * Consecutive image-only sections share spreads two by two, in reading order. A cover
   * stays alone: the first page of the reading order, which a book whose declared cover
   * lies outside it opens on in its place, and the cover page the book declares. An image
   * page left over shares its spread with the section of text right after it, a new
   * chapter's included, rather than a blank page.
   */
  private pairImagePages(
    sections: Array<{ linear?: boolean }>,
    imagePages: Set<number>,
    coverIndex: number,
    textPages: Set<number>,
  ): void {
    const linear = [...sections.keys()].filter((index) => sections[index].linear);
    this.imageSpreads = new Map();
    this.textPartners = new Set();
    let waiting: number | undefined;
    for (const index of linear) {
      if (imagePages.has(index) && index !== linear[0] && index !== coverIndex) {
        if (waiting === undefined) waiting = index;
        else {
          this.imageSpreads.set(waiting, index).set(index, waiting);
          waiting = undefined;
        }
        continue;
      }
      if (waiting !== undefined && textPages.has(index)) {
        this.imageSpreads.set(waiting, index).set(index, waiting);
        this.textPartners.add(index);
      }
      waiting = undefined;
    }
    void this.matchShownImageSpread();
  }

  /** Pair or separate the shown image pages once the pairs are known, between navigations. */
  private async matchShownImageSpread(): Promise<void> {
    const rendition = this.rendition;
    if (!rendition || !this.ready || this.disposed || this.turnPending || this.layoutPending)
      return;
    this.turnPending = true;
    try {
      const anchor = await this.displayedAnchor();
      if (this.disposed) return;
      const before = this.manager()
        ?.views?.all()
        .map((view) => view.section.index);
      await this.matchImageSpread(rendition);
      if (this.disposed) return;
      const after = this.manager()
        ?.views?.all()
        .map((view) => view.section.index);
      if (before?.join() === after?.join()) return;
      // A text section shown again beside its image page keeps the page being read.
      if (anchor && this.book) await this.displayAnchor(rendition, this.book, anchor);
      if (this.disposed) return;
      await this.publishLocation();
    } finally {
      this.turnPending = false;
      if (!this.disposed) await this.refreshPageTurns();
    }
    await this.applySkippedPresentation();
  }

  /** Read every linear section for its counted text, page kind and anchors, between turns. */
  private async measureSections(
    book: Book,
    sections: Array<{ linear?: boolean; url?: string }>,
    anchors: Map<number, Set<string>>,
    signal: AbortSignal,
  ): Promise<SectionMeasures | undefined> {
    const measures: SectionMeasures = {
      sections: [],
      imagePages: new Set(),
      textPages: new Set(),
      resolved: new Set(),
      asked: anchors,
      script: { cjk: 0, letters: 0 },
    };
    const { imagePages, textPages, resolved, script } = measures;
    for (const [index, section] of sections.entries()) {
      await nextTask();
      if (signal.aborted || this.disposed) return undefined;
      const counts = { length: unitCounts(""), anchors: new Map<string, AnchorPosition>() };
      if (section.linear && section.url) {
        try {
          const document = (await book.load(section.url)) as Document | undefined;
          if (document?.body) {
            const text = readableText(document);
            if (showsOneImage(document)) imagePages.add(index);
            else if (text.trim()) textPages.add(index);
            counts.length = unitCounts(text);
            const letters = scriptCounts(text);
            script.cjk += letters.cjk;
            script.letters += letters.letters;
            for (const fragment of anchors.get(index) ?? []) {
              counts.anchors.set(fragment, anchorPosition(document, fragment));
              try {
                if (!fragment || document.getElementById(decodeURIComponent(fragment)))
                  resolved.add(`${index}#${fragment}`);
              } catch {
                /* Invalid fragments remain unavailable. */
              }
            }
          }
        } catch {
          // A section that cannot be read cannot be displayed either; it adds nothing.
        }
      }
      measures.sections.push(counts);
    }
    return signal.aborted || this.disposed ? undefined : measures;
  }

  private async countProgress(book: Book): Promise<void> {
    const signal = this.navigationAbort.signal;
    const sections: Array<{ linear?: boolean; url?: string }> = [];
    book.spine.each((section: { linear?: boolean; url?: string }) => sections.push(section));
    // Destinations in contents order, and their anchors grouped by spine index:
    // "" for a section start, else a fragment ID.
    const targets: Array<{ id: string; index: number; fragment: string }> = [];
    const anchors = new Map<number, Set<string>>();
    for (const [id, destination] of this.destinations) {
      const index = sections.indexOf(book.spine.get(destination) as (typeof sections)[number]);
      if (index < 0) continue;
      const fragment = destination.split("#")[1] ?? "";
      targets.push({ id, index, fragment });
      if (!anchors.has(index)) anchors.set(index, new Set());
      anchors.get(index)?.add(fragment);
    }
    const url = this.contentUrl;
    const known = url === undefined ? undefined : measuredBooks.get(url);
    const measures =
      known && known.sections.length === sections.length && measuresAnchors(known, anchors)
        ? known
        : await this.measureSections(book, sections, anchors, signal);
    if (!measures || signal.aborted || this.disposed) return;
    if (url !== undefined) {
      measuredBooks.delete(url);
      measuredBooks.set(url, measures);
      for (const old of measuredBooks.keys()) {
        if (measuredBooks.size <= MEASURED_BOOKS) break;
        measuredBooks.delete(old);
      }
    }
    const { sections: measured, imagePages, textPages, resolved, script } = measures;
    const navigation = await book.loaded.navigation.catch(() => undefined);
    const cover = await spineCoverPage(book, navigation, navigationBase(book)).catch(() => null);
    if (signal.aborted || this.disposed) return;
    const coverIndex = cover ? sections.indexOf(book.spine.get(cover) as never) : -1;
    this.pairImagePages(sections, imagePages, coverIndex, textPages);
    const unit = progressUnit(script);
    const lengths = measured.map((section) => section.length[unit]);
    const before: number[] = [];
    let total = 0;
    for (const length of lengths) {
      before.push(total);
      total += length;
    }
    // An empty book keeps reading without progress numbers.
    if (!total) {
      const unavailable = (entries: ReaderContentsEntry[]): ReaderContentsEntry[] =>
        entries.map((entry) => ({
          ...entry,
          location: null,
          children: unavailable(entry.children),
        }));
      this.onContentsChanged?.(unavailable(this.contents));
      return;
    }
    // Destinations in unreadable or non-linear sections are skipped.
    const chapterEntries: ChapterEntry[] = targets.flatMap(({ id, index, fragment }) => {
      const anchor = measured[index].anchors.get(fragment);
      if (!anchor) return [];
      const offset = before[index] + Math.min(anchor.units[unit], lengths[index]);
      return [{ id, spineIndex: index, offset, raw: anchor.raw, anchorId: anchor.id }];
    });
    // Reading order; the stable sort keeps contents order for entries at one point.
    chapterEntries.sort(
      (a, b) => a.offset - b.offset || a.spineIndex - b.spineIndex || a.raw - b.raw,
    );
    let starts = chapterEntries.map((entry) => entry.offset);
    // Without usable contents, each linear section with counted text is a chapter.
    if (!starts.length) starts = before.filter((_, index) => lengths[index] > 0);
    // Contents order need not follow the spine; text before the first entry is a chapter too.
    const chapterStarts = [...new Set([0, ...starts])]
      .filter((start) => start < total)
      .sort((a, b) => a - b);
    this.progressCounts = { unit, before, lengths, total, chapterStarts, chapterEntries };
    const locations = new Map(
      chapterEntries
        .filter((entry) => {
          const target = targets.find((target) => target.id === entry.id);
          return target && resolved.has(`${target.index}#${target.fragment}`);
        })
        .map((entry) => [entry.id, entry.offset]),
    );
    const withLocations = (entries: ReaderContentsEntry[]): ReaderContentsEntry[] =>
      entries.map((entry) => {
        const current = locations.get(entry.id);
        return {
          ...entry,
          location: current === undefined ? null : { current, total, unit },
          children: withLocations(entry.children),
        };
      });
    this.onContentsChanged?.(withLocations(this.contents));
    // A turn that settles meanwhile publishes a newer value and wins.
    const revision = ++this.progressRevision;
    const settled = await this.displayedLocator();
    if (settled && revision === this.progressRevision) this.publishProgress(settled);
    if (!this.disposed) await this.refreshPageTurns();
  }

  /** The first displayed text position as a renderer-neutral locator. */
  private async displayedLocator(
    relocation?: Promise<DisplayedBookLocation | undefined>,
  ): Promise<DisplayedPosition | undefined> {
    const rendition = this.rendition;
    const book = this.book;
    if (!rendition || !book || this.disposed) return undefined;
    if (this.continuous) return this.continuousPosition();
    const location = await this.settledLocation(rendition, relocation);
    const start = location?.start;
    if (this.disposed || start?.index === undefined) return undefined;
    const href = start.href ?? (book.spine.get(start.index) as { href?: string } | null)?.href;
    if (!href) return undefined;
    const page = start.displayed?.page ?? 1;
    const total = start.displayed?.total ?? 1;
    let progress = total > 1 ? (page - 1) / total : 0;
    const pageStart = pagePoint(rendition, this.host, start.index, start.cfi, "start");
    if (pageStart) {
      progress = textProgress(pageStart.document, pageStart.node, pageStart.offset) ?? progress;
    }
    return {
      locator: {
        spineIndex: start.index,
        sectionKey: sectionKey(href),
        progress: Math.min(1, Math.max(0, progress)),
      },
      atEnd: atBookEnd(location, this.lastSpineIndex),
      pageStart,
      pageEnd: pagePoint(rendition, this.host, location?.end?.index, location?.end?.cfi, "end"),
    };
  }

  private waitForRelocation(rendition: Rendition): Promise<DisplayedBookLocation | undefined> {
    return new Promise((resolve) => {
      const signal = this.navigationAbort.signal;
      let done = false;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (location?: DisplayedBookLocation) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        rendition.off("relocated", onLocation);
        signal.removeEventListener("abort", onAbort);
        resolve(location);
      };
      const onLocation = (location: DisplayedBookLocation) => finish(location);
      const onAbort = () => finish();
      rendition.on("relocated", onLocation);
      signal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => finish(), 1500);
      if (signal.aborted) finish();
    });
  }

  /** EPUB.js reports an empty location until a newly displayed section relocates. */
  private async settledLocation(
    rendition: Rendition,
    relocation?: Promise<DisplayedBookLocation | undefined>,
  ): Promise<DisplayedBookLocation | undefined> {
    const current = await this.currentBookLocation(rendition);
    if (current?.start?.index !== undefined || !relocation) return current;
    const relocated = await this.navigatedLocation(rendition, relocation);
    if (this.disposed) return undefined;
    const latest = await this.currentBookLocation(rendition);
    return latest?.start?.index !== undefined ? latest : relocated;
  }

  /**
   * The location a resolved EPUB.js navigation displays. EPUB.js reports a relocation
   * from one animation frame and stays silent when the new view is not sized by then,
   * as it can be after leaving a text-less page. The rendition's own location is
   * therefore also read on each later frame, and the first one found settles the turn.
   */
  private async navigatedLocation(
    rendition: Rendition,
    relocation: Promise<DisplayedBookLocation | undefined>,
  ): Promise<DisplayedBookLocation | undefined> {
    let settled = false;
    const located = (async () => {
      while (!settled && !this.disposed) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (settled || this.disposed) break;
        const location = await this.currentBookLocation(rendition).catch(() => undefined);
        if (location?.start && location.end) return location;
      }
      return undefined;
    })();
    try {
      return await Promise.race([relocation, located]);
    } finally {
      settled = true;
    }
  }

  private async currentBookLocation(
    rendition: Rendition,
  ): Promise<DisplayedBookLocation | undefined> {
    return (await Promise.resolve(rendition.currentLocation())) as
      DisplayedBookLocation | undefined;
  }

  private async refreshPageTurns(): Promise<void> {
    const rendition = this.rendition;
    if (!rendition || this.disposed || this.layoutPending) return;
    const revision = ++this.locationRevision;
    if (this.continuous) {
      const { atStart, atEnd } = this.continuousEdges();
      this.onPageTurnsChanged?.({
        canAdvance: !atEnd,
        canRetreat: !atStart,
        forwardArrow: this.forwardArrow,
        ...(this.vnView && {
          vnRevealing: this.vnReveal.revealing,
          ...(!this.vnReveal.supported
            ? { vnNotice: "instant-text" as const }
            : this.shownChapter !== undefined &&
                this.chapters[this.shownChapter]?.blockIndex === undefined
              ? { vnNotice: "whole-section" as const }
              : {}),
        }),
        scrollAxis: this.manager()?.settings?.axis === "horizontal" ? "horizontal" : "vertical",
      });
      return;
    }
    const location = await this.currentBookLocation(rendition);
    if (this.disposed || this.layoutPending || revision !== this.locationRevision) return;
    this.onPageTurnsChanged?.({
      canAdvance: !!location?.end && !atBookEnd(location, this.lastSpineIndex),
      canRetreat: !!location?.start && !location.atStart,
      forwardArrow: this.forwardArrow,
      ...this.paginatedChapterEdges(location),
      ...(this.requestedVn && this.fixedLayout && { vnNotice: "fixed-layout" as const }),
    });
  }

  /** Use laid-out page edges, including text-less spine pages and in-section chapters. */
  private paginatedChapterEdges(
    location?: DisplayedBookLocation,
  ): Pick<ReaderPageTurnAvailability, "advanceChapter" | "retreatChapter"> {
    const start = location?.start;
    const end = location?.end;
    let advance =
      !!end?.displayed?.total &&
      (end.displayed.page ?? 0) >= end.displayed.total &&
      !atBookEnd(location, this.lastSpineIndex);
    let retreat =
      start?.index !== undefined &&
      start.index > this.firstSpineIndex &&
      start.displayed?.page === 1;
    const counts = this.progressCounts;
    const rendition = this.rendition;
    if (counts && rendition) {
      const first = pagePoint(rendition, this.host, start?.index, start?.cfi, "start");
      const last = pagePoint(rendition, this.host, end?.index, end?.cfi, "end");
      const from = first && this.bookOffset(counts, first);
      const to = last && this.bookOffset(counts, last);
      if (from !== undefined && to !== undefined) {
        let chapter = 0;
        while (
          chapter + 1 < counts.chapterStarts.length &&
          (counts.chapterStarts[chapter + 1] <= from || counts.chapterStarts[chapter + 1] < to)
        )
          chapter++;
        const next = counts.chapterStarts[chapter + 1];
        advance ||= next !== undefined && to >= next;
        retreat ||= chapter > 0 && from <= counts.chapterStarts[chapter];
      }
    }
    return { ...(advance && { advanceChapter: true }), ...(retreat && { retreatChapter: true }) };
  }

  private onRendered = (_section?: unknown, view?: EpubView) => {
    this.restyleIfStale(view?.contents);
    // A long continuous book releases the sections it lays out far from its reading area.
    if (view && this.limitsLoadedSections) {
      this.renderedViews.add(view);
      void this.loadNearbySections(false);
    }
    // A section rendered only now can hold the shown chapter's start or end.
    if (this.chapterView) this.applyChapterBounds();
    this.registerContentDocuments(view?.contents);
  };

  /**
   * Follow the displayed section documents: styled, watched and painted as they arrive,
   * and released once discarded. When one section has just rendered, only it is new.
   */
  private registerContentDocuments(rendered?: EpubPageContents) {
    if (this.disposed || !this.rendition) return;
    const displayed = this.rendition.getContents() as unknown as EpubPageContents[];
    const documents = displayed.map((contents) => contents.document);
    const shown = new Set(documents);
    for (const [document, pending] of this.notePaint) {
      if (shown.has(document)) continue;
      pending.active = false;
      pending.clear();
      this.notePaint.delete(document);
    }
    for (const [document, clear] of this.selectionPaint) {
      if (shown.has(document)) continue;
      clear();
      this.selectionPaint.delete(document);
    }
    const arrived = rendered ? displayed.filter((contents) => contents === rendered) : displayed;
    for (const contents of arrived) {
      this.blurDocument(contents.document, contents.sectionIndex ?? -1);
      this.furiganaDocument(contents.document, contents.sectionIndex ?? -1);
    }
    this.imageBlur.watchDocuments(documents);
    this.furigana.watchDocuments(documents);
    for (const contents of arrived) {
      if (!contents.document) continue;
      this.watchSelection(contents.document);
      if (!this.selectionPaint.has(contents.document))
        this.selectionPaint.set(contents.document, paintSelection(contents.document));
      this.paintNotes(contents);
      this.onContentDocument?.(contents.document);
    }
  }

  /**
   * Report the reader's selection in a displayed section: only its text and where it shows.
   * Documents EPUB.js has discarded stop being watched as the next one arrives.
   */
  private watchSelection(document: Document) {
    if (!this.onSelectionChanged || this.selectionWatches.has(document)) return;
    for (const [previous, cleanup] of this.selectionWatches) {
      if (previous.defaultView) continue;
      if (this.pointerScan?.ranges[0]?.startContainer.ownerDocument === previous)
        this.invalidateSelection();
      cleanup();
      this.selectionWatches.delete(previous);
    }
    this.selectionWatches.set(
      document,
      watchTextSelection(
        document,
        () => this.host,
        (selection) => {
          if (!selection) {
            this.invalidateSelection();
            return;
          }
          if (selection.scanId === undefined) this.highlightPointerMatch(null);
          if (this.vnReveal.revealing) this.vnReveal.finish();
          this.selectionActive = true;
          this.onSelectionChanged?.(selection);
        },
        (ranges) => {
          this.highlightPointerMatch(null);
          const id = ++this.scanIds;
          this.pointerScan = { id, ranges };
          return id;
        },
        this.lookupTriggers,
      ),
    );
  }

  /** A reflow makes the reported rectangle stale, even if the browser keeps its range. */
  private invalidateSelection() {
    for (const watch of this.selectionWatches.values()) watch.cancelPending();
    this.highlightPointerMatch(null);
    if (!this.selectionActive) return;
    this.selectionActive = false;
    this.onSelectionChanged?.(null);
  }

  highlightPointerMatch(scanId: number | null, length = 0): void {
    if (scanId !== null && this.pointerScan?.id !== scanId) return;
    this.clearPointerPaint?.();
    this.clearPointerPaint = undefined;
    if (scanId === null) {
      this.pointerScan = undefined;
      return;
    }
    if (!Number.isInteger(length) || length <= 0 || length > 256) return;
    const ranges = this.pointerScan!.ranges;
    const document = ranges[0]?.startContainer.ownerDocument;
    if (!document?.defaultView) return;
    const matched: Range[] = [];
    let remaining = length;
    for (const range of ranges) {
      const characters = [...range.toString()];
      const taken = characters.slice(0, remaining);
      const part = range.cloneRange();
      part.setEnd(part.startContainer, part.startOffset + taken.join("").length);
      matched.push(part);
      remaining -= taken.length;
      if (!remaining) break;
    }
    // A response must describe a start that exists in this scan.
    if (remaining) return;
    this.clearPointerPaint = paintLookupMatch(document, matched);
  }

  dispose(): void {
    if (this.disposed) return;
    this.highlightPointerMatch(null);
    this.clearSearchMatch();
    this.clearNoteHighlights();
    this.noteHighlights = [];
    for (const clear of this.selectionPaint.values()) clear();
    this.selectionPaint.clear();
    this.disposed = true;
    this.vnReveal.dispose();
    this.ready = false;
    this.reflowAnchor = undefined;
    this.settledAnchor = undefined;
    this.pointerScan = undefined;
    this.sectionHooks = [];
    this.restoreAxis?.();
    this.hostObserver?.disconnect();
    clearTimeout(this.hostSizeTimer);
    this.releaseScrolling();
    this.releaseHeldViews?.();
    this.releaseHeldViews = undefined;
    this.request?.abort();
    this.request = undefined;
    this.navigationAbort.abort();
    this.destinations.clear();
    this.searchRevision++;
    this.releaseSearch?.();
    this.releaseSearch = undefined;
    this.searchDestinations.clear();
    this.searchLabels.clear();
    this.imageRevision++;
    this.imageDestinations.clear();
    this.imageCatalog = null;
    for (const controller of this.imageLoads) controller.abort();
    this.imageLoads.clear();
    for (const url of this.imageUrls) URL.revokeObjectURL(url);
    this.imageUrls.clear();
    this.bookmarkSections.clear();
    this.imageBlur.dispose();
    this.furigana.dispose();
    this.blurBoundary = undefined;
    this.headingTargets.clear();
    this.inkShifts.clear();
    this.locationRevision++;
    this.onPageTurnsChanged = undefined;
    this.onLocationChanged = undefined;
    this.onProgressChanged = undefined;
    this.progressCounts = undefined;
    this.rendition?.off("relocated", this.onRelocated);
    this.rendition?.off("resized", this.onResized);
    this.rendition?.off("rendered", this.onRendered);
    this.onContentDocument = undefined;
    this.onSelectionChanged = undefined;
    this.selectionActive = false;
    for (const cleanup of this.selectionWatches.values()) cleanup();
    this.selectionWatches.clear();

    try {
      if (this.book) releaseBook(this.book);
    } finally {
      this.rendition = undefined;
      this.book = undefined;
      this.host?.replaceChildren();
      this.host?.style?.removeProperty(SIDE_INSET);
      this.host?.style?.removeProperty(MAX_HEIGHT);
      this.host?.style?.removeProperty("--reader-max-width");
      this.host = undefined;
    }
  }
}

/** How long the Reader waits for EPUB.js to add or show continuous sections. */
const SECTIONS_SETTLE_LIMIT_MS = 1500;
/**
 * How long the rest of a continuous book may go on loading, after it shows, without adding
 * a section before the Reader stops waiting for it.
 */
const SECTIONS_LOAD_LIMIT_MS = 10_000;

/** The first of the items a test holds for, given it holds for every item after one it holds for. */
function firstIndex<T>(items: T[], test: (item: T) => boolean): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (test(items[middle])) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** A promise's settlement, or the limit's end if it comes first. */
async function settledWithin(
  task: Promise<unknown> | undefined,
  limit = SECTIONS_SETTLE_LIMIT_MS,
): Promise<void> {
  if (!task) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task.catch(() => undefined),
      new Promise((resolve) => (timer = setTimeout(resolve, limit))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A turn of the event loop between sections. A zero timeout is clamped to 4 ms once
 * timeouts nest, which sections read from memory never interrupt; a message is not.
 */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

/** Where a chapter begins: at a section's start, or at an element of it by ID. */
interface ChapterStart {
  spineIndex: number;
  blockIndex?: number;
  anchorId?: string;
}

function sliceAnchor(start: ChapterStart, document: Document, blocks?: VnBlock[]): Element | null {
  return start.blockIndex !== undefined
    ? ((blocks ?? vnBlocks(document))[start.blockIndex]?.element ?? null)
    : start.anchorId === undefined
      ? null
      : document.getElementById(start.anchorId);
}

/**
 * How a section shows in a chapter view: not at all, or from a distance along the reading
 * order to another, which is infinite for its end, with chapter clearance or VN centering
 * along the reading order (`lead`) and across it (`across`).
 */
type ChapterClip = "collapsed" | { from: number; to: number; lead: number; across: number };

/** The style properties a chapter view collapses and clips sections with. */
const CHAPTER_CLIP_PROPERTIES = [
  "max-height",
  "max-width",
  "margin-top",
  "margin-left",
  "margin-right",
  "clip-path",
] as const;

/** The chapter holding a point of a displayed section: the last one starting at or before it. */
function chapterAt(
  chapters: ChapterStart[],
  spineIndex: number,
  document: Document,
  point: Range | Element,
): number | undefined {
  let found: number | undefined;
  const blocks = chapters.some((start) => start.blockIndex !== undefined)
    ? vnBlocks(document)
    : undefined;
  for (const [index, start] of chapters.entries()) {
    if (!startsAtOrBefore(start, spineIndex, document, point, blocks)) break;
    found = index;
  }
  return found ?? (chapters.length ? 0 : undefined);
}

function startsAtOrBefore(
  start: ChapterStart,
  spineIndex: number,
  document: Document,
  point: Range | Element,
  blocks?: VnBlock[],
): boolean {
  if (start.spineIndex !== spineIndex) return start.spineIndex < spineIndex;
  const anchor = sliceAnchor(start, document, blocks);
  if (!anchor?.parentNode) return true;
  const boundary = document.createRange();
  boundary.setStartBefore(anchor);
  let node: Node | null;
  let offset: number;
  if ((point as Element).nodeType === Node.ELEMENT_NODE) {
    node = (point as Element).parentNode;
    offset = node ? (Array.prototype.indexOf.call(node.childNodes, point) as number) : 0;
  } else {
    node = (point as Range).startContainer;
    offset = (point as Range).startOffset;
  }
  try {
    if (!node || boundary.comparePoint(node, offset) >= 0) return true;
    // Blank space before the start is no content, so a section's own start, before its
    // first block, is in the section's first chapter rather than the one before it.
    const between = document.createRange();
    between.setStart(node, offset);
    between.setEndBefore(anchor);
    return (
      !between.toString().trim() &&
      !between.cloneContents().querySelector([...MEDIA_ELEMENTS].join(", "))
    );
  } catch {
    return true;
  }
}

/** A box in a section document's coordinates, placed in the Reader's viewport. */
function pageBox(
  origin: DOMRect,
  box: Pick<DOMRect, "top" | "left" | "width" | "height">,
): Pick<DOMRect, "top" | "bottom" | "left" | "right"> {
  return {
    top: origin.top + box.top,
    bottom: origin.top + box.top + box.height,
    left: origin.left + box.left,
    right: origin.left + box.left + box.width,
  };
}

/** A rectangle's start and end along a continuous book's reading order. */
type BlockSpan = (rect: Pick<DOMRect, "top" | "bottom" | "left" | "right">) => [number, number];

/** The page progression EPUB.js lays out and scrolls sections in. */
function readingDirection(rendition: Rendition): string | undefined {
  return (rendition as unknown as { settings?: { direction?: string } }).settings?.direction;
}

/** EPUB.js's hooks for each section document it loads, which renditions add to. */
function sectionHookList(book: Book): unknown[] {
  const hooks = (book.spine.hooks.content as unknown as { hooks?: unknown[] }).hooks;
  return Array.isArray(hooks) ? hooks : [];
}

/**
 * The first and last characters, or images, of a displayed section document whose
 * middle lies within an extent along the reading order, and whether the document goes
 * on beyond it. With nothing in view, the first is the first character after it.
 * Whitespace and ruby annotations are passed over.
 */
function viewportEdges(
  document: Document,
  origin: DOMRect,
  area: [number, number],
  span: BlockSpan,
): { first?: TextPoint; last?: TextPoint; beyond: boolean } {
  let first: TextPoint | undefined;
  let last: TextPoint | undefined;
  const extent = (rects: ArrayLike<DOMRect>): [number, number] | undefined => {
    let start = Infinity;
    let end = -Infinity;
    for (const rect of Array.from(rects)) {
      if (!rect.width && !rect.height) continue;
      const [s, e] = span({
        top: origin.top + rect.top,
        bottom: origin.top + rect.bottom,
        left: origin.left + rect.left,
        right: origin.left + rect.right,
      });
      start = Math.min(start, s);
      end = Math.max(end, e);
    }
    return start <= end ? [start, end] : undefined;
  };
  const probe = document.createRange();
  const body = document.body;
  let node: Node | null = body.firstChild;
  const next = (from: Node, descend: boolean) => followingNode(body, from, descend);
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      const name = element.localName;
      if (name === "rt" || name === "rp") {
        node = next(node, false);
        continue;
      }
      if (MEDIA_ELEMENTS.has(name)) {
        const box = extent([element.getBoundingClientRect()]);
        const parent = element.parentNode;
        if (box && parent) {
          const index = Array.prototype.indexOf.call(parent.childNodes, element) as number;
          const middle = (box[0] + box[1]) / 2;
          if (middle > area[1])
            return { first: first ?? { node: parent, offset: index }, last, beyond: true };
          if (middle >= area[0]) {
            first ??= { node: parent, offset: index };
            last = { node: parent, offset: index + 1 };
          }
        }
        node = next(node, false);
        continue;
      }
      node = next(node, true);
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE && (node as Text).data.trim()) {
      const text = node as Text;
      probe.selectNodeContents(text);
      const whole = extent(probe.getClientRects());
      if (whole && whole[1] > area[0]) {
        if (whole[0] >= area[1]) {
          const offset = text.data.search(/\S/);
          return { first: first ?? { node: text, offset }, last, beyond: true };
        }
        for (let index = 0; index < text.data.length;) {
          const length = (text.data.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
          if (text.data.slice(index, index + length).trim()) {
            probe.setStart(text, index);
            probe.setEnd(text, index + length);
            const box = extent(probe.getClientRects());
            if (box) {
              const middle = (box[0] + box[1]) / 2;
              if (middle > area[1])
                return { first: first ?? { node: text, offset: index }, last, beyond: true };
              if (middle >= area[0]) {
                first ??= { node: text, offset: index };
                last = { node: text, offset: index + length };
              }
            }
          }
          index += length;
        }
      }
    }
    node = next(node, false);
  }
  return { first, last, beyond: false };
}

/** Elements displayed as one box without text of their own, such as illustrations. */
const MEDIA_ELEMENTS = new Set(["img", "svg", "image", "video"]);

/** The node after another in a body's document order, into its children or past them. */
function followingNode(body: Node, from: Node, descend: boolean): Node | null {
  if (descend && from.firstChild) return from.firstChild;
  for (let at: Node | null = from; at && at !== body; at = at.parentNode) {
    if (at.nextSibling) return at.nextSibling;
  }
  return null;
}

/** A point just before a child node, in its parent. */
function pointBefore(child: Node): TextPoint | undefined {
  const parent = child.parentNode;
  if (!parent) return undefined;
  return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, child) as number };
}

/** Whether a rendered box, in a section document's coordinates, overlaps the reading area. */
function withinArea(
  origin: DOMRect,
  area: DOMRect,
  box: Pick<DOMRect, "top" | "left" | "width" | "height">,
): boolean {
  if (!box.width && !box.height) return false;
  const top = origin.top + box.top;
  const left = origin.left + box.left;
  return (
    top < area.bottom &&
    top + box.height > area.top &&
    left < area.right &&
    left + box.width > area.left
  );
}

/**
 * The first character or image after a node, in reading order, rendered within the
 * reading area, skipping ruby annotations as the page start does.
 */
function firstDisplayedAfter(
  host: HTMLElement,
  document: Document,
  after: Node,
): TextPoint | undefined {
  const frame = document.defaultView?.frameElement;
  const body = document.body;
  if (!frame || !body?.contains(after)) return undefined;
  const origin = frame.getBoundingClientRect();
  const area = host.getBoundingClientRect();
  const probe = document.createRange();
  const shown = (box: DOMRect | undefined) => !!box && withinArea(origin, area, box);
  for (let node = followingNode(body, after, false); node;) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const name = (node as Element).localName;
      if (MEDIA_ELEMENTS.has(name) && shown((node as Element).getBoundingClientRect()))
        return pointBefore(node);
      const descend = name !== "rt" && name !== "rp" && !MEDIA_ELEMENTS.has(name);
      node = followingNode(body, node, descend);
      continue;
    }
    const text = node as Text;
    if (node.nodeType === Node.TEXT_NODE && text.data.trim()) {
      probe.selectNodeContents(text);
      // Only a text node rendered partly within the area is searched character by character.
      if (Array.from(probe.getClientRects?.() ?? []).some(shown)) {
        for (let index = 0; index < text.data.length;) {
          const length = (text.data.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
          probe.setStart(text, index);
          probe.setEnd(text, index + length);
          if (text.data.slice(index, index + length).trim() && shown(probe.getClientRects()[0]))
            return { node: text, offset: index };
          index += length;
        }
      }
    }
    node = followingNode(body, node, false);
  }
  return undefined;
}

const pageMeasured = new WeakSet<EpubPageContents>();

/**
 * EPUB.js sizes a paginated section to its text's width plus the body's side padding. Text
 * that begins at the body's very edge, before the padding, already spans the left padding,
 * which then counts twice: a section whose last page is full gained an empty page after it.
 * A glyph that overhangs the body's left edge widens the text by as much again, so the
 * width runs from the body's edge, whatever lies before it. Right-to-left columns run
 * from the body's right edge, and all but the first lie to the left of the body.
 */
function pageTextWidth(contents: EpubPageContents): void {
  const measure = contents.textWidth?.bind(contents);
  if (!measure || pageMeasured.has(contents)) return;
  pageMeasured.add(contents);
  contents.textWidth = () => {
    const width = measure();
    const body = contents.document?.body;
    const view = contents.document?.defaultView;
    if (!body || !view) return width;
    const range = contents.document.createRange();
    if (typeof range.getBoundingClientRect !== "function") return width;
    range.selectNodeContents(body);
    const text = range.getBoundingClientRect();
    const box = body.getBoundingClientRect();
    const style = view.getComputedStyle(body);
    const rtl = style.direction === "rtl" && !style.writingMode?.startsWith("vertical");
    const start = rtl ? box.right - text.right : text.left - box.left;
    const padding = parseFloat(rtl ? style.paddingRight : style.paddingLeft) || 0;
    return start < padding ? width - Math.round(padding - start) : width;
  };
}

/** The side of a spread a fixed-layout page is set on, in the order the spread is read. */
type SpreadSide = "first" | "second" | "center";

/** Fixed-layout pages shown together, and the side a page alone on its spread is set on. */
interface FixedSpread<Page> {
  pages: Page[];
  alone?: SpreadSide;
}

/**
 * The side of a spread a fixed-layout page declares. A spread read left to right starts
 * on its left side, and one read right to left on its right side.
 */
function declaredSide(section: EpubSection, rtl: boolean): SpreadSide | undefined {
  const properties = new Set(
    (section.properties ?? []).map((property) => property.replace(/^rendition:/, "")),
  );
  if (properties.has("page-spread-center") || properties.has("spread-none")) return "center";
  const left = properties.has("page-spread-left");
  if (left === properties.has("page-spread-right")) return undefined;
  return left !== rtl ? "first" : "second";
}

/**
 * Group a fixed-layout book's pages, in reading order, into spreads by the sides they
 * declare. A book opens on a recto, so its first page stands alone on a spread's second
 * side unless it declares the first. A page that declares the second side stands alone
 * there, and one that declares the center stands alone between the two. Any other page
 * shares its spread with the next, unless that one starts a spread of its own.
 */
function fixedSpreads<Page>(
  pages: Page[],
  sides: Array<SpreadSide | undefined>,
): FixedSpread<Page>[] {
  const spreads: FixedSpread<Page>[] = [];
  for (let page = 0; page < pages.length;) {
    const side = sides[page];
    const following = sides[page + 1];
    const recto = side === "second" || (page === 0 && side !== "first");
    if (
      !recto &&
      side !== "center" &&
      page + 1 < pages.length &&
      following !== "first" &&
      following !== "center"
    ) {
      spreads.push({ pages: [pages[page], pages[page + 1]] });
      page += 2;
    } else {
      spreads.push({ pages: [pages[page]], alone: recto ? "second" : (side ?? "first") });
      page += 1;
    }
  }
  return spreads;
}

function hostSize(host: HTMLElement): { width: number; height: number } {
  return { width: host.clientWidth, height: host.clientHeight };
}

/** A settled page's first character as a reading point. */
function anchorAt(settled: DisplayedPosition): ReflowAnchor {
  return {
    spineIndex: settled.locator.spineIndex,
    progress: settled.locator.progress,
    point: settled.pageStart,
  };
}

function sectionContents(rendition: Rendition, index: number): EpubPageContents | undefined {
  // EPUB.js's bundled declaration says Contents, but runtime returns Contents[].
  return (rendition.getContents() as unknown as EpubPageContents[]).find(
    (contents) => contents.sectionIndex === index && contents.document?.body,
  );
}

interface BookProgressCounts {
  unit: ReaderProgressUnit;
  /** Per spine index: linear units before the section, and its own units (0 if non-linear). */
  before: number[];
  lengths: number[];
  total: number;
  /** Sorted, distinct book offsets where chapters begin; the first is always 0. */
  chapterStarts: number[];
  /** Resolved contents destinations in reading order. */
  chapterEntries: ChapterEntry[];
}

/** What a book-wide count reads from each section, which depends on its content alone. */
interface SectionMeasures {
  /** Per spine index: its counted text, and the anchors asked for in it. */
  sections: Array<{ length: UnitCounts; anchors: Map<string, AnchorPosition> }>;
  imagePages: Set<number>;
  textPages: Set<number>;
  /** Anchors found in their sections, as "index#fragment", of those asked for by spine index. */
  resolved: Set<string>;
  asked: Map<number, Set<string>>;
  script: { cjk: number; letters: number };
}

/**
 * The section measures of the last few books read in this session, by content URL. The URL
 * names the source version, so a book reopened unchanged is counted without rereading it.
 */
const MEASURED_BOOKS = 4;
const measuredBooks = new Map<string, SectionMeasures>();

/** Whether measures were taken for every anchor a count asks for. */
function measuresAnchors(measures: SectionMeasures, anchors: Map<number, Set<string>>): boolean {
  for (const [index, fragments] of anchors)
    for (const fragment of fragments) if (!measures.asked.get(index)?.has(fragment)) return false;
  return true;
}

interface ChapterEntry {
  id: string;
  spineIndex: number;
  /** Book units before the destination, and raw text before it within its section. */
  offset: number;
  raw: number;
  /** The fragment's element ID, or undefined for a section start. */
  anchorId?: string;
}

type UnitCounts = Record<ReaderProgressUnit, number>;

interface AnchorPosition {
  units: UnitCounts;
  raw: number;
  id?: string;
}

/**
 * The contents entry of the chapter starting at a book offset. Of several entries at
 * that offset, such as image-only sections or a part and its first chapter, it is the
 * last one in reading order at or before the displayed section, else the first.
 */
function chapterEntryId(
  entries: ChapterEntry[],
  start: number,
  spineIndex: number,
): string | undefined {
  const shared = entries.filter((entry) => entry.offset === start);
  let current = shared[0];
  for (const entry of shared) if (entry.spineIndex <= spineIndex) current = entry;
  return current?.id;
}

function unitCounts(text: string): UnitCounts {
  return { characters: countUnits(text, "characters"), words: countUnits(text, "words") };
}

/** Linear units before a point given as a fraction of its section's raw text. */
function fractionOffset(
  counts: BookProgressCounts,
  spineIndex: number,
  progress: number,
): number | undefined {
  const before = counts.before[spineIndex];
  if (before === undefined) return undefined;
  const length = counts.lengths[spineIndex] ?? 0;
  return Math.min(counts.total, before + Math.min(length, Math.round(progress * length)));
}

/** A displayed section's point from an EPUB.js page CFI: its range start or end. */
function pagePoint(
  rendition: Rendition,
  host: HTMLElement | undefined,
  spineIndex: number | undefined,
  cfi: string | undefined,
  edge: "start" | "end",
): PagePoint | undefined {
  if (spineIndex === undefined || !cfi) return undefined;
  const contents = sectionContents(rendition, spineIndex);
  if (!contents?.range) return undefined;
  try {
    const range = contents.range(cfi);
    const node = edge === "start" ? range.startContainer : range.endContainer;
    if (!contents.document.body?.contains(node)) return undefined;
    const reported = edge === "start" ? range.startOffset : range.endOffset;
    if (!host) return { spineIndex, document: contents.document, node, offset: reported };
    const offset = displayedTextOffset(host, contents.document, node, reported, edge);
    if (offset !== undefined) return { spineIndex, document: contents.document, node, offset };
    // EPUB.js starts a page holding no text of its own, such as an illustration after a
    // section's last paragraph, at text on an earlier page. Its first displayed content,
    // such as that image, follows.
    const shown = firstDisplayedAfter(host, contents.document, node);
    return { spineIndex, document: contents.document, ...(shown ?? { node, offset: reported }) };
  } catch {
    // EPUB.js could not resolve its own CFI in this document.
    return undefined;
  }
}

/**
 * EPUB.js splits text into ranges only at spaces, so in text without spaces, such as
 * Japanese, it reports the start of a text node that begins on an earlier page and the
 * end of one that continues on a later page. When the first rendered character from a
 * page-start offset (or the last before a page-end offset) lies outside the reading
 * area, the offset moves to the first displayed character (or just past the last). A
 * page start whose node has characters from it rendered outside the reading area and
 * none inside is undefined.
 */
function displayedTextOffset(
  host: HTMLElement,
  document: Document,
  node: Node,
  offset: number,
  edge: "start" | "end",
): number | undefined {
  const frame = document.defaultView?.frameElement;
  if (!frame || node.nodeType !== Node.TEXT_NODE) return offset;
  const text = (node as Text).data;
  const origin = frame.getBoundingClientRect();
  const area = host.getBoundingClientRect();
  const probe = document.createRange();
  // Whether the character at an index is rendered, and if so, within the reading area.
  const place = (index: number, length: number) => {
    probe.setStart(node, index);
    probe.setEnd(node, index + length);
    const box = probe.getClientRects?.()[0];
    if (!box?.width && !box?.height) return "hidden";
    return withinArea(origin, area, box) ? "inside" : "outside";
  };
  let outside = false;
  if (edge === "start") {
    for (let index = offset; index < text.length;) {
      const length = (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
      const found = place(index, length);
      if (found === "inside") return outside ? index : offset;
      if (found === "outside") outside = true;
      index += length;
    }
    if (outside) return undefined;
  } else {
    for (let index = offset; index > 0;) {
      const length = index > 1 && (text.codePointAt(index - 2) ?? 0) > 0xffff ? 2 : 1;
      index -= length;
      const found = place(index, length);
      if (found === "inside") return outside ? index + length : offset;
      if (found === "outside") outside = true;
    }
  }
  return offset;
}

/**
 * Units and raw text of a parsed section before an authored anchor. A section start
 * or an absent anchor is the section's start.
 */
function anchorPosition(document: Document, fragment: string): AnchorPosition {
  let id = fragment;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    // Keep a malformed escape as authored.
  }
  const anchor = fragment ? document.getElementById(id) : null;
  if (!anchor || !document.body?.contains(anchor)) return { units: unitCounts(""), raw: 0 };
  const before = document.createRange();
  before.setStart(document.body, 0);
  before.setEnd(anchor, 0);
  return {
    units: unitCounts(readableText(document, { node: anchor, offset: 0 })),
    raw: before.toString().length,
    id,
  };
}

/** Whether the displayed page is the final page of the book's linear reading order. */
function atBookEnd(location: DisplayedBookLocation | undefined, lastSpineIndex: number): boolean {
  if (!location?.end) return false;
  const endPage = location.end.displayed?.page ?? 1;
  const total = location.end.displayed?.total ?? 1;
  return !!location.atEnd || ((location.end.index ?? 0) >= lastSpineIndex && endPage >= total);
}

function textNodes(document: Document): Text[] {
  const nodes: Text[] = [];
  if (!document.body) return nodes;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

/** The locator's text measure: characters of every text node in the section body. */
function textLength(document: Document): number {
  return textNodes(document).reduce((sum, node) => sum + node.data.length, 0);
}

/** Fraction of a section's text before a point: independent of layout, fonts, and window size. */
function textProgress(document: Document, node: Node, offset: number): number | null {
  const body = document.body;
  if (!body?.contains(node)) return null;
  const total = textLength(document);
  if (!total) return 0;
  const before = document.createRange();
  before.setStart(body, 0);
  before.setEnd(node, offset);
  return before.toString().length / total;
}

const TEXT_AFTER_IMAGE_AFFINITY = 0.0001;

/**
 * Text immediately after an image can have the same text count as the image. Keep a
 * small affinity within the fraction when the ordinary restore would choose that
 * image, without moving the reading point or changing image locators.
 */
function continuousTextProgress(document: Document, node: Node, offset: number): number | null {
  const progress = textProgress(document, node, offset);
  if (progress === null || node.nodeType !== Node.TEXT_NODE || offset !== 0) return progress;
  if (progress === 0) {
    const mediaBefore = Array.from(document.body.querySelectorAll("img, svg, image, video")).some(
      (media) => !!(node.compareDocumentPosition(media) & Node.DOCUMENT_POSITION_PRECEDING),
    );
    if (!mediaBefore) return progress;
  } else {
    const restored = pointAtProgress(document, progress);
    if (!restored || restored.startContainer === node) return progress;
    const candidate = restored.startContainer.childNodes[restored.startOffset];
    if (
      candidate?.nodeType !== Node.ELEMENT_NODE ||
      !MEDIA_ELEMENTS.has((candidate as Element).localName)
    )
      return progress;
  }
  const total = textLength(document);
  return total ? Math.min(1, progress + TEXT_AFTER_IMAGE_AFFINITY / total) : progress;
}

/**
 * The reading point at a section's text fraction: the character with that much text
 * before it. Where only collapsible whitespace or markup lies there, such as between
 * blocks, it is the next image or character, so an image found again from its fraction
 * is that image rather than the text after it. An image directly followed by text, as
 * in running text, has that text's fraction and yields to it.
 */
function pointAtProgress(document: Document, progress: number): Range | null {
  const nodes = textNodes(document);
  if (!document.body || !nodes.length) return null;
  const measured = progress * nodes.reduce((sum, node) => sum + node.data.length, 0);
  // A small fractional marker says the reading point is the text just after an
  // image at this count; an exact count still resolves to the image itself.
  const afterImage =
    measured - Math.floor(measured) > TEXT_AFTER_IMAGE_AFFINITY / 2 &&
    measured - Math.floor(measured) < TEXT_AFTER_IMAGE_AFFINITY * 1.5;
  let remaining = afterImage ? Math.floor(measured) : Math.round(measured);
  // The earliest place with that much text before it, which can be a node's end.
  let index = 0;
  while (
    index < nodes.length - 1 &&
    (remaining > nodes[index].data.length || (afterImage && remaining === nodes[index].data.length))
  )
    remaining -= nodes[index++].data.length;
  const node = nodes[index];
  const offset = Math.min(remaining, node.data.length);
  const next = offset === node.data.length ? nodes[index + 1] : undefined;
  const point =
    renderedPointFrom(document.body, node, offset) ??
    (next ? { node: next, offset: 0 } : { node, offset });
  const range = document.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  return range;
}

/** A character other than collapsible whitespace, which renders nothing between blocks. */
const RENDERED_CHARACTER = /[^ \t\n\r\f]/;

/** The first image or rendered character at or after a text point, in reading order. */
function renderedPointFrom(body: Node, text: Text, offset: number): TextPoint | undefined {
  const within = text.data.slice(offset).search(RENDERED_CHARACTER);
  if (within >= 0) return { node: text, offset: offset + within };
  for (let node = followingNode(body, text, false); node;) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const media = MEDIA_ELEMENTS.has((node as Element).localName);
      const after = node.nextSibling;
      const inText =
        after?.nodeType === Node.TEXT_NODE && (after as Text).data.search(RENDERED_CHARACTER) === 0;
      if (media && !inText) return pointBefore(node);
      node = followingNode(body, node, !media);
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const found = (node as Text).data.search(RENDERED_CHARACTER);
      if (found >= 0) return { node, offset: found };
    }
    node = followingNode(body, node, false);
  }
  return undefined;
}

/** A reflow anchor's point, while its section document is still displayed. */
function anchorPoint(contents: EpubPageContents, anchor: ReflowAnchor): Range | null {
  const point = anchor.point;
  if (!point || point.document !== contents.document) return null;
  if (!contents.document.body?.contains(point.node)) return null;
  const range = contents.document.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  return range;
}

interface NormalizedPresentation {
  fontPair?: ReaderFontPair;
  fontFamilyGroup1?: ReaderSerifFont;
  fontFamilyGroup2?: ReaderSansFont;
  /** Undefined keeps the book's own, as in fixed-layout pages. */
  fontSize?: number;
  lineHeight?: number;
  fontWeight?: number;
  paragraphIndent?: number;
  paragraphMargin?: number;
  /** Chosen spacing in CSS pixels; never 0, which keeps the book's own. */
  letterSpacing?: number;
  wordSpacing?: number;
  sideMargin?: number;
  maxWidth?: number;
  pageLayout?: ReaderPageLayout;
  maxHeight?: number;
  writingMode?: ReaderWritingMode;
  textOrientation?: ReaderTextOrientation;
  textJustification: boolean;
  prettyTextWrap: boolean;
  hideFurigana: boolean;
  furiganaStyle: ReaderFuriganaStyle;
  blurImage: boolean;
  blurMode: ReaderBlurMode;
  textColor?: string;
  selectionColor?: string;
  highlightColor?: string;
  viewMode: ReaderViewMode;
  vnParagraphs: number;
  vnTextSpeed: number;
  /** Whether images alone on their lines are centered, as in every reflowable book. */
  centerImages: boolean;
  /** A mode for each section's root only, keeping the modes the book sets inside it. */
  rootWritingMode?: ReaderWritingMode;
}

/** A chosen value, normalized, or undefined to keep the book's own. */
function chosen<Value>(value: unknown, normalize: (value: unknown) => Value): Value | undefined {
  return value === undefined || value === null ? undefined : normalize(value);
}

/**
 * The Reader always passes every choice. An absent one keeps the book's own, or
 * EPUB.js's automatic layout, as the contract allows.
 */
function normalizePresentation(presentation?: ReaderPresentation): NormalizedPresentation {
  return {
    fontPair:
      presentation?.fontPair &&
      isReaderFontChoice(presentation.fontPair.asian) &&
      isReaderFontChoice(presentation.fontPair.western)
        ? {
            ...presentation.fontPair,
            downloaded: presentation.fontPair.downloaded
              .filter((id) => googleFontFiles.some((f) => f.id === id))
              .sort(),
            uploaded: presentation.fontPair.uploaded?.filter(validUploadedFont),
            weights:
              presentation.fontPair.weights &&
              isFaceWeight(presentation.fontPair.weights.western) &&
              isFaceWeight(presentation.fontPair.weights.asian)
                ? presentation.fontPair.weights
                : undefined,
            systemFaces: presentation.fontPair.systemFaces?.filter(
              (f) =>
                validFontFamily(f.family) &&
                validFontFamily(f.name) &&
                isFaceWeight(f.weight) &&
                ["normal", "italic"].includes(f.style),
            ),
          }
        : undefined,
    fontFamilyGroup1: isReaderSerifFont(presentation?.fontFamilyGroup1)
      ? presentation.fontFamilyGroup1
      : undefined,
    fontFamilyGroup2: isReaderSansFont(presentation?.fontFamilyGroup2)
      ? presentation.fontFamilyGroup2
      : undefined,
    fontSize: normalizeFontSize(presentation?.fontSize),
    lineHeight: chosen(presentation?.lineHeight, normalizeLineHeight),
    fontWeight:
      presentation?.fontPair &&
      isFaceWeight(presentation.fontPair.weights?.western) &&
      isFaceWeight(presentation.fontPair.weights?.asian)
        ? fontPairBaseWeight(presentation.fontPair)
        : chosen(presentation?.fontWeight, normalizeFontWeight),
    paragraphIndent: chosen(presentation?.paragraphIndent, normalizeParagraphIndent),
    paragraphMargin: chosen(presentation?.paragraphMargin, normalizeParagraphMargin),
    letterSpacing: chosen(presentation?.letterSpacing, normalizeLetterSpacing) || undefined,
    wordSpacing: chosen(presentation?.wordSpacing, normalizeWordSpacing) || undefined,
    sideMargin: chosen(presentation?.sideMargin, normalizeSideMargin),
    maxWidth: chosen(presentation?.maxWidth, normalizeMaxWidth),
    pageLayout: chosen(presentation?.pageLayout, normalizePageLayout),
    maxHeight: chosen(presentation?.maxHeight, normalizeMaxHeight),
    writingMode: chosen(presentation?.writingMode, normalizeWritingMode),
    textOrientation: chosen(presentation?.textOrientation, normalizeTextOrientation),
    textJustification: presentation?.textJustification === true,
    prettyTextWrap: presentation?.prettyTextWrap === true,
    hideFurigana: presentation?.hideFurigana === true,
    furiganaStyle: isFuriganaStyle(presentation?.furiganaStyle)
      ? presentation.furiganaStyle
      : "hide",
    blurImage: presentation?.blurImage === true,
    blurMode: isBlurMode(presentation?.blurMode) ? presentation.blurMode : "all",
    textColor: chosenColor(presentation?.textColor),
    selectionColor: chosenColor(presentation?.selectionColor),
    highlightColor: chosenColor(presentation?.highlightColor),
    viewMode: normalizeViewMode(presentation?.viewMode),
    vnParagraphs: normalizeVnParagraphs(presentation?.vnParagraphs),
    vnTextSpeed: normalizeVnTextSpeed(presentation?.vnTextSpeed),
    centerImages: true,
  };
}

/** A chosen `#rrggbb` color in lowercase, or undefined to keep the book's own. */
function chosenColor(value: unknown): string | undefined {
  return isThemeColor(value) ? value.toLowerCase() : undefined;
}

/**
 * Whether two presentations lay a book out alike, differing at most in blurred images
 * and colors.
 */
function sameLayout(a: NormalizedPresentation, b: NormalizedPresentation): boolean {
  return (
    sameFontPair(a.fontPair, b.fontPair) &&
    a.fontFamilyGroup1 === b.fontFamilyGroup1 &&
    a.fontFamilyGroup2 === b.fontFamilyGroup2 &&
    a.fontSize === b.fontSize &&
    a.lineHeight === b.lineHeight &&
    a.fontWeight === b.fontWeight &&
    a.paragraphIndent === b.paragraphIndent &&
    a.paragraphMargin === b.paragraphMargin &&
    a.letterSpacing === b.letterSpacing &&
    a.wordSpacing === b.wordSpacing &&
    a.sideMargin === b.sideMargin &&
    a.maxWidth === b.maxWidth &&
    a.pageLayout === b.pageLayout &&
    a.maxHeight === b.maxHeight &&
    a.writingMode === b.writingMode &&
    a.textOrientation === b.textOrientation &&
    a.textJustification === b.textJustification &&
    a.prettyTextWrap === b.prettyTextWrap &&
    (a.hideFurigana && a.furiganaStyle === "hide") ===
      (b.hideFurigana && b.furiganaStyle === "hide") &&
    a.viewMode === b.viewMode &&
    (a.viewMode !== "vn" || a.vnParagraphs === b.vnParagraphs)
  );
}

/** Whether two presentations that lay a book out alike also style it alike. */
function sameStyle(a: NormalizedPresentation, b: NormalizedPresentation): boolean {
  return (
    a.hideFurigana === b.hideFurigana &&
    a.furiganaStyle === b.furiganaStyle &&
    a.vnTextSpeed === b.vnTextSpeed &&
    a.blurImage === b.blurImage &&
    a.blurMode === b.blurMode &&
    a.textColor === b.textColor &&
    a.selectionColor === b.selectionColor &&
    a.highlightColor === b.highlightColor
  );
}

const LINE_HEIGHT_ATTRIBUTE = "data-komori-line-height";
/** Records on a section's root the presentation it was last styled with. */
const PRESENTATION_ATTRIBUTE = "data-komori-presentation";

/** One presentation's identity, the same for equal presentations. */
function presentationKey(presentation: NormalizedPresentation): string {
  // A replacer key array also filters nested objects, losing the font pair's fields.
  return JSON.stringify(
    Object.fromEntries(Object.entries(presentation).sort(([a], [b]) => a.localeCompare(b))),
  );
}

const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const FONT_FAMILY_STYLE = "data-komori-font-family";
const OWN_FONT_FAMILY = "data-komori-own-font-family";

/** Replace families only; relative sizes, emphasis and ruby text remain the book's. */
function applyFontFamilies(
  document: Document,
  group1?: ReaderSerifFont,
  group2?: ReaderSansFont,
  pair?: ReaderFontPair,
): void {
  const existing = document.querySelector(`style[${FONT_FAMILY_STYLE}]`);
  const chosen = !!pair || group1 !== undefined || group2 !== undefined;
  const stack = pair ? fontPairStack(pair) : readerFontStack(group1, group2);
  const elements = [
    document.documentElement,
    ...document.querySelectorAll<HTMLElement>("body, body *"),
  ];
  for (const element of elements) {
    if (!element.style) continue;
    const own = element.getAttribute(OWN_FONT_FAMILY);
    if (!chosen) {
      if (own === null) continue;
      try {
        const [value, priority] = JSON.parse(own) as [string, string];
        element.style.removeProperty("font-family");
        if (value) element.style.setProperty("font-family", value, priority);
      } catch {
        /* Ignore a malformed presentation marker. */
      }
      element.removeAttribute(OWN_FONT_FAMILY);
    } else if (own !== null || element.style.getPropertyValue("font-family")) {
      if (own === null)
        element.setAttribute(
          OWN_FONT_FAMILY,
          JSON.stringify([
            element.style.getPropertyValue("font-family"),
            element.style.getPropertyPriority("font-family"),
          ]),
        );
      // Inline important font shorthands otherwise outrank the owned stylesheet.
      element.style.setProperty("font-family", stack, "important");
    }
  }
  if (!chosen) {
    existing?.remove();
    return;
  }
  const style = existing ?? document.createElementNS(XHTML_NAMESPACE, "style");
  if (!existing) {
    style.setAttribute(FONT_FAMILY_STYLE, "");
    // The first important layer outranks even publisher layers and ID selectors.
    (document.head ?? document.documentElement).prepend(style);
  }
  style.textContent =
    (pair ? fontPairFaces(pair) : group2 === "inter" ? readerInterFace : "") +
    `@layer komori-fonts { :root, :root body, :root body * { font-family: ${stack} !important; } }`;
}

/** Wait for the included font before measuring a reflow; unavailable local faces fall through. */
async function waitForReaderFonts(
  document: Document,
  presentation: NormalizedPresentation,
): Promise<void> {
  if (!document.fonts || (!presentation.fontPair && presentation.fontFamilyGroup2 !== "inter"))
    return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      document.fonts
        .load(
          `${presentation.fontWeight ?? 400} ${presentation.fontSize ?? readerFontSize.default}px ${presentation.fontPair ? fontPairStack(presentation.fontPair) : '"Komori Reader Inter"'}`,
          "Reader日本語漢字한글中文",
        )
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 1500);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

// Every element inherits the root's line height, so a multiple follows each element's
// own font size. Ruby annotations keep their own spacing above or beside the text.
const LINE_HEIGHT_RULE =
  `:root[${LINE_HEIGHT_ATTRIBUTE}] body, ` +
  `:root[${LINE_HEIGHT_ATTRIBUTE}] body *:not(rt):not(rp) { line-height: inherit !important; }`;

/** Marks the style element holding the chosen side margin. */
const SIDE_MARGIN_STYLE = "data-komori-side-margin";

/**
 * Style a section: its base font size in pixels on its root element, its line height
 * when one is chosen, and its side margin. The book's relative sizes (em, rem, %)
 * follow the font size; sizes the book gives in absolute units do not. A chosen line
 * height replaces the book's own for all its text, and none restores the book's.
 */
function applyPresentation(document: Document, presentation: NormalizedPresentation): void {
  const root = document.documentElement;
  if (!root?.style) return;
  root.setAttribute(PRESENTATION_ATTRIBUTE, presentationKey(presentation));
  applyFontFamilies(
    document,
    presentation.fontFamilyGroup1,
    presentation.fontFamilyGroup2,
    presentation.fontPair,
  );
  applySideMargin(document, presentation.sideMargin);
  applyWritingMode(
    document,
    presentation.writingMode ?? presentation.rootWritingMode,
    presentation.writingMode === undefined,
  );
  root.toggleAttribute(
    VERTICAL_ROOT,
    root.style.getPropertyValue("writing-mode").startsWith("vertical"),
  );
  applyTextOrientation(document, presentation.textOrientation);
  applyHangingIndentLayout(document, presentation.writingMode);
  applyParagraphMargin(document, presentation.paragraphMargin);
  applyTextSpacing(document, presentation.letterSpacing, presentation.wordSpacing);
  applyColors(
    document,
    presentation.textColor,
    presentation.selectionColor,
    presentation.highlightColor,
  );
  applyImageCentering(document, presentation.centerImages);
  applyParagraphLayout(document, presentation.textJustification, presentation.prettyTextWrap);
  if (presentation.fontSize !== undefined)
    root.style.setProperty("font-size", `${presentation.fontSize}px`);
  // The marker keeps the root line height the book set itself, to restore it.
  const own = root.getAttribute(LINE_HEIGHT_ATTRIBUTE);
  if (presentation.lineHeight === undefined) {
    if (own === null) return;
    root.style.removeProperty("line-height");
    if (own) root.style.setProperty("line-height", own);
    root.removeAttribute(LINE_HEIGHT_ATTRIBUTE);
    return;
  }
  if (own === null) root.setAttribute(LINE_HEIGHT_ATTRIBUTE, root.style.lineHeight);
  root.style.setProperty("line-height", String(presentation.lineHeight), "important");
  if (!document.querySelector(`style[${LINE_HEIGHT_ATTRIBUTE}]`)) {
    const style = document.createElementNS(XHTML_NAMESPACE, "style");
    style.setAttribute(LINE_HEIGHT_ATTRIBUTE, "");
    style.textContent = LINE_HEIGHT_RULE;
    (document.head ?? root).append(style);
  }
}

/** Marks a section root set in vertical text, chosen or declared. */
const VERTICAL_ROOT = "data-komori-vertical";
/** Marks the style element holding a chosen writing mode. */
const WRITING_MODE_STYLE = "data-komori-writing-mode";
/** Keeps the root writing mode set inline before a chosen one replaced it. */
const OWN_WRITING_MODE = "data-komori-own-writing-mode";

/**
 * A chosen writing mode on the root, which EPUB.js reads for the section's axis, and on
 * every element of the body, replacing the modes the book sets in its CSS or declares.
 * A mode for the root only leaves the elements inside it to the book. None restores the
 * root's own inline mode and removes the rule.
 */
function applyWritingMode(
  document: Document,
  mode: ReaderWritingMode | undefined,
  rootOnly = false,
): void {
  const root = document.documentElement;
  const existing = document.querySelector(`style[${WRITING_MODE_STYLE}]`);
  const own = root.getAttribute(OWN_WRITING_MODE);
  if (mode === undefined) {
    existing?.remove();
    if (own === null) return;
    root.style.removeProperty("writing-mode");
    if (own) root.style.setProperty("writing-mode", own);
    root.removeAttribute(OWN_WRITING_MODE);
    return;
  }
  const value = mode === "vertical" ? "vertical-rl" : "horizontal-tb";
  if (own === null)
    root.setAttribute(OWN_WRITING_MODE, root.style.getPropertyValue("writing-mode"));
  root.style.setProperty("writing-mode", value, "important");
  if (rootOnly) {
    existing?.remove();
    return;
  }
  const style = existing ?? document.createElementNS(XHTML_NAMESPACE, "style");
  if (!existing) {
    style.setAttribute(WRITING_MODE_STYLE, "");
    (document.head ?? root).append(style);
  }
  // A layer's important rules outrank the book's own, however specific: a book that forces
  // its body vertical, as `html.vrtl body { writing-mode: vertical-rl !important }` does,
  // would otherwise lay its text out across a horizontal root's single page.
  style.textContent =
    "@layer komori-writing-mode { :root body, :root body * { writing-mode: inherit !important; -webkit-writing-mode: inherit !important; }" +
    // A document set right to left would run its vertical lines and pages upwards, where
    // EPUB.js cannot page them. Its text reads from the top; its own runs keep their direction.
    (mode === "vertical" ? " :root, :root body { direction: ltr !important; }" : "") +
    " }";
}

/**
 * Whether a horizontal section's columns run right to left. EPUB.js lays them out on the
 * section's body, in the body's direction, and scrolls them in its root, which takes the
 * body's direction: a book that sets `dir="rtl"` on its body alone would otherwise run
 * every page after its first out of the root's reach.
 */
function followBodyDirection(document: Document): boolean {
  const root = document.documentElement;
  const body = document.body ?? root;
  const view = document.defaultView;
  if (!root || !view) return false;
  const style = view.getComputedStyle(body);
  if (style.writingMode?.startsWith("vertical")) return false;
  if (body !== root && view.getComputedStyle(root).direction !== style.direction)
    root.style.setProperty("direction", style.direction, "important");
  return style.direction === "rtl";
}

/** Marks a view a paginated turn keeps in sight until the next section's view shows. */
const HELD_VIEW = "data-komori-held-view";

/**
 * Keep a view where it was on screen, at `box`, out of its container's flow and clipped to
 * the reading area, while the container scrolls and lays out the next section's view.
 */
function holdInPlace(element: HTMLElement, container: HTMLElement, box: DOMRect): boolean {
  const area = container.getBoundingClientRect();
  if (
    box.right <= area.left ||
    box.left >= area.right ||
    box.bottom <= area.top ||
    box.top >= area.bottom
  )
    return false;
  const { style } = element;
  style.position = "fixed";
  style.margin = "0";
  style.left = `${box.left}px`;
  style.top = `${box.top}px`;
  // An ancestor that contains fixed elements, such as a transformed one, offsets it.
  const placed = element.getBoundingClientRect();
  style.left = `${2 * box.left - placed.left}px`;
  style.top = `${2 * box.top - placed.top}px`;
  style.clipPath =
    `inset(${Math.max(0, area.top - box.top)}px ${Math.max(0, box.right - area.right)}px ` +
    `${Math.max(0, box.bottom - area.bottom)}px ${Math.max(0, area.left - box.left)}px)`;
  style.pointerEvents = "none";
  element.setAttribute(HELD_VIEW, "");
  return true;
}

/** What EPUB.js measures a paginated location from: the reading area and each view in it. */
function locationLayout(manager: EpubManager): unknown[] {
  const { container, layout, settings } = manager;
  const values: unknown[] = [
    container?.scrollLeft,
    container?.scrollTop,
    container?.clientWidth,
    container?.clientHeight,
    layout.height,
    layout.delta,
    settings?.axis,
    settings?.direction,
  ];
  for (const view of manager.views?.all() ?? []) {
    const { element } = view;
    values.push(
      view,
      view.contents?.document,
      view.displayed,
      element.offsetLeft,
      element.offsetTop,
      element.offsetWidth,
      element.offsetHeight,
    );
  }
  return values;
}

function sameValues(first: unknown[], second: unknown[]): boolean {
  return first.length === second.length && first.every((value, at) => value === second[at]);
}

/** Marks the style element holding a chosen text orientation. */
const TEXT_ORIENTATION_STYLE = "data-komori-text-orientation";

/**
 * A chosen text orientation on the root and every element of the body, replacing the
 * orientations the book sets in its CSS. It only affects vertical text, so a horizontal
 * section is laid out as before. None removes the rule, restoring the book's own.
 */
function applyTextOrientation(
  document: Document,
  orientation: ReaderTextOrientation | undefined,
): void {
  const existing = document.querySelector(`style[${TEXT_ORIENTATION_STYLE}]`);
  if (orientation === undefined) {
    existing?.remove();
    return;
  }
  const style = existing ?? document.createElementNS(XHTML_NAMESPACE, "style");
  if (!existing) {
    style.setAttribute(TEXT_ORIENTATION_STYLE, "");
    (document.head ?? document.documentElement).append(style);
  }
  style.textContent =
    `:root, :root body, :root body * { text-orientation: ${orientation} !important; ` +
    `-webkit-text-orientation: ${orientation} !important; }`;
}

/** Marks the style element holding a chosen paragraph margin. */
const PARAGRAPH_MARGIN_STYLE = "data-komori-paragraph-margin";

/**
 * A chosen margin before and after every paragraph, along each paragraph's own block
 * direction: above and below in horizontal text, right and left in vertical text.
 * Headings and other blocks keep the book's spacing. None removes the rule, restoring
 * the book's own.
 */
function applyParagraphMargin(document: Document, margin: number | undefined): void {
  const existing = document.querySelector(`style[${PARAGRAPH_MARGIN_STYLE}]`);
  if (margin === undefined) {
    existing?.remove();
    return;
  }
  const style = existing ?? document.createElementNS(XHTML_NAMESPACE, "style");
  if (!existing) {
    style.setAttribute(PARAGRAPH_MARGIN_STYLE, "");
    (document.head ?? document.documentElement).append(style);
  }
  style.textContent =
    `:root body p { margin-block-start: ${margin}px !important; ` +
    `margin-block-end: ${margin}px !important; }`;
}

/** Marks the style element holding the chosen letter and word spacing. */
const TEXT_SPACING_STYLE = "data-komori-text-spacing";

/**
 * Chosen letter and word spacing for all the section's text, replacing the book's own in
 * either writing mode; ruby annotations keep normal spacing beside their base. Combined
 * upright text (tate-chu-yoko) ignores spacing, as CSS requires. An important rule in the
 * first layer outranks the book's own important rules. None removes the rule.
 */
function applyTextSpacing(
  document: Document,
  letter: number | undefined,
  word: number | undefined,
): void {
  const existing = document.querySelector(`style[${TEXT_SPACING_STYLE}]`);
  if (letter === undefined && word === undefined) {
    existing?.remove();
    return;
  }
  const style = existing ?? document.createElementNS(XHTML_NAMESPACE, "style");
  if (!existing) {
    style.setAttribute(TEXT_SPACING_STYLE, "");
    (document.head ?? document.documentElement).prepend(style);
  }
  const declarations = [
    letter !== undefined && `letter-spacing: ${letter}px !important;`,
    word !== undefined && `word-spacing: ${word}px !important;`,
  ]
    .filter(Boolean)
    .join(" ");
  style.textContent =
    `@layer komori-text-spacing { :root body, :root body *:not(rt):not(rp) { ${declarations} } ` +
    `:root body rt, :root body rp { letter-spacing: normal !important; word-spacing: normal !important; } }`;
}

/** Marks the style element holding the chosen colors. */
const COLORS_STYLE = "data-komori-colors";
/** The hue links are tinted toward, so they stay distinguishable from the text. */
const LINK_HUE = "#3d7be0";

/**
 * The chosen text color on the root and every element, links tinted toward a blue, and
 * the independently chosen selection (also a pointer lookup's match) and saved-passage colors. The book's own backgrounds
 * give way to the Reader's page, so its text keeps its contrast; images keep theirs. Important declarations in a layer
 * outrank the book's important ones whatever their specificity. Colors change no layout.
 */
function colorRules(
  text: string | undefined,
  selection: string | undefined,
  highlight: string | undefined,
): string {
  const rules: string[] = [];
  if (text !== undefined) {
    rules.push(
      ":root, :root body { background-color: transparent !important; }",
      ":root body *:not(img):not(svg):not(video) { background-color: transparent !important; }",
      `:root, :root body, :root body * { color: ${text} !important; }`,
      `:root body a[href], :root body a[href] * ` +
        `{ color: color-mix(in srgb, ${text} 60%, ${LINK_HUE}) !important; }`,
    );
  }
  // The selection paints as line marks, like saved passages; the browser's own stays clear.
  // A pointer lookup's match paints as selected text does.
  if (selection !== undefined)
    rules.push(
      ":root ::selection { background-color: transparent !important; }",
      `:root [${SELECTION_MARKS}] span { background-color: ${selection} !important; }`,
      `:root [${LOOKUP_MARKS}] span { background-color: ${selection} !important; }`,
      `:root [${SEARCH_MARKS}] span { background-color: ${selection} !important; }`,
    );
  if (highlight !== undefined)
    rules.push(
      // No child combinator: EPUB.js serializes the section as XHTML before showing it,
      // which would turn ">" into a literal "&gt;" that matches nothing.
      `:root [${NOTE_MARKS}] span { background-color: ${highlight} !important; }`,
    );
  return rules.length ? `@layer komori-colors {\n${rules.join("\n")}\n}` : "";
}

/** Chosen colors on a section; none removes the style element. */
function applyColors(
  document: Document,
  text: string | undefined,
  selection: string | undefined,
  highlight: string | undefined,
): void {
  const existing = document.querySelector(`style[${COLORS_STYLE}]`);
  const rules = colorRules(text, selection, highlight);
  if (!rules) {
    existing?.remove();
    return;
  }
  if (existing?.textContent === rules) return;
  const style = existing ?? document.createElementNS(XHTML_NAMESPACE, "style");
  style.setAttribute(COLORS_STYLE, "");
  style.textContent = rules;
  if (!existing) (document.head ?? document.documentElement).append(style);
}

/** Marks the style element centering images. */
const CENTER_IMAGES_STYLE = "data-komori-center-images";
/** Marks the viewport-sized image limit used only by reflowable continuous views. */
const CONTINUOUS_IMAGE_STYLE = "data-komori-continuous-images";
/** Marks the outermost block of an image-only chapter heading. */
const IMAGE_HEADING = "data-komori-image-heading";
/** Marks a block whose lines hold images and no text. */
const IMAGE_BLOCK = "data-komori-image-block";
/** Marks an image between blocks, on a line of its own. */
const LONE_IMAGE = "data-komori-lone-image";
const BLOCK_ELEMENTS =
  "address, article, aside, blockquote, body, center, dd, div, dl, dt, figcaption, " +
  "figure, footer, header, li, main, nav, p, pre, section, td, th";
/** Elements after or before which an image starts a line of its own. */
const LINE_BREAKING_ELEMENTS = `${BLOCK_ELEMENTS}, h1, h2, h3, h4, h5, h6, hr, ol, table, ul`;

/** Marks the style showing VN's pointer: a click in the book reveals or reads on. */
const VN_CURSOR_STYLE = "data-komori-vn-cursor";

function applyVnCursor(document: Document, shown: boolean): void {
  const style = document.querySelector(`style[${VN_CURSOR_STYLE}]`);
  if (!shown) {
    style?.remove();
    return;
  }
  if (style) return;
  const created = document.createElementNS(XHTML_NAMESPACE, "style");
  created.setAttribute(VN_CURSOR_STYLE, "");
  created.textContent = ":root, :root body, :root body * { cursor: pointer !important; }";
  (document.head ?? document.documentElement).append(created);
}

/**
 * An element's left and right padding together, in pixels. Its resolved value lays out the
 * section, and in a continuous book every view before it, even when it is fixed; its
 * computed value, read through the typed object model, needs no layout, so the resolved
 * value is read only when that one is relative.
 */
function sidePadding(element: HTMLElement): number {
  const typed = element.computedStyleMap?.();
  const sides = ["padding-left", "padding-right"].map((property) => {
    const value = typed?.get(property) as Partial<CSSUnitValue> | undefined;
    return value?.unit === "px" && typeof value.value === "number" ? value.value : undefined;
  });
  if (sides[0] !== undefined && sides[1] !== undefined) return sides[0] + sides[1];
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return (parseFloat(style?.paddingLeft ?? "") || 0) + (parseFloat(style?.paddingRight ?? "") || 0);
}

/**
 * Keep intrinsic image proportions while limiting their box to the scrollable area, inside
 * the body's side padding, which holds horizontal text's margin.
 */
function applyContinuousImageSizing(
  document: Document,
  width: number | undefined,
  height: number | undefined,
): void {
  let style = document.querySelector(`style[${CONTINUOUS_IMAGE_STYLE}]`);
  if (!width || !height) {
    style?.remove();
    return;
  }
  const inner = Math.max(1, width - (document.body ? sidePadding(document.body) : 0));
  const rule =
    `:root body img, :root body svg { max-width: ${inner}px !important; ` +
    `max-height: ${height}px !important; object-fit: contain !important; }`;
  if (style?.textContent === rule) return;
  if (!style) {
    style = document.createElementNS(XHTML_NAMESPACE, "style");
    style.setAttribute(CONTINUOUS_IMAGE_STYLE, "");
    (document.head ?? document.documentElement).append(style);
  }
  style.textContent = rule;
}

/**
 * Centers every image alone on its line along the inline axis, horizontally in
 * horizontal text and vertically in vertical text. A block holding images and no text
 * centers its lines, without indentation, and the images' auto inline margins center
 * those the book displays as blocks; an image between blocks takes auto inline margins.
 * Images in running text stay inline, and images in headings are left to the book. The
 * book's own sizing is kept. Sections are marked from their markup, before layout, and
 * only a section with such images takes the rule.
 */
function applyImageCentering(document: Document, center: boolean): void {
  const body = document.body;
  if (!center || !body || document.querySelector(`style[${CENTER_IMAGES_STYLE}]`)) return;
  for (const image of Array.from(body.querySelectorAll("img, svg"))) {
    if (
      image.parentElement?.closest("svg") ||
      isTextImage(image) ||
      image.closest("h1, h2, h3, h4, h5, h6")
    )
      continue;
    const block = image.closest(BLOCK_ELEMENTS);
    if (!block) continue;
    if (!block.textContent?.trim()) block.setAttribute(IMAGE_BLOCK, "");
    else if (image.parentElement === block && betweenBlocks(image))
      image.setAttribute(LONE_IMAGE, "");
  }
  if (!document.querySelector(`[${IMAGE_BLOCK}], [${LONE_IMAGE}]`)) return;
  const style = document.createElementNS(XHTML_NAMESPACE, "style");
  style.setAttribute(CENTER_IMAGES_STYLE, "");
  style.textContent =
    `:root body [${IMAGE_BLOCK}] { text-align: center !important; text-indent: 0 !important; } ` +
    `:root body [${IMAGE_BLOCK}] img, :root body [${IMAGE_BLOCK}] svg, ` +
    `:root body [${LONE_IMAGE}] { margin-inline: auto !important; }`;
  (document.head ?? document.documentElement).append(style);
}

/** Marks a chapter heading or section break, and each block around it holding nothing else. */
const HEADING = "data-komori-heading";
/** Marks the style element centering chapter headings. */
const CENTER_HEADINGS_STYLE = "data-komori-center-headings";
/** Marks a heading image whose drawn content is moved to the center of its box. */
const INK_CENTERED = "data-komori-ink-centered";
/** Marks a text heading whose ideographic spaces at either end would push it off center. */
const HEADING_LEAD = "data-komori-heading-lead";
const HEADING_ELEMENTS = "h1, h2, h3, h4, h5, h6";
const HEADING_BLOCKS = `${BLOCK_ELEMENTS}, ${HEADING_ELEMENTS}`;
/** More characters than a chapter title holds, so a targeted passage of text is not centered. */
const HEADING_LENGTH_LIMIT = 100;
// Two ID-like selectors outrank the book's own rules, including the indentation Komori
// repeats from them, whatever their order.
const OUTRANK = ":not(#komori-heading):not(#komori-heading)";
/** What may decorate a section number: －３－, 《２》, #1. */
const NUMBER_DECORATION = "[-－―—‐─~〜～#＃§・.．*＊()（）[\\]［］〈〉《》【】〔〕]{0,2}";
/**
 * A section number, as Japanese books number the parts of a chapter: 7, ７, 001, 三, Ⅱ, IV, 第2節,
 * decorated or not.
 */
const SECTION_NUMBER = new RegExp(
  `^${NUMBER_DECORATION}第?(?:[0-9０-９]{1,3}|[〇一二三四五六七八九十百]{1,4}|[Ⅰ-Ⅻ]|[IVX]{1,5})` +
    `[節話]?${NUMBER_DECORATION}$`,
  "u",
);
/** A scene break drawn in symbols: ◇, ＊＊＊, ◆◇◆, †. */
const SECTION_ORNAMENT = /^[◆◇◈＊*☆★●○◎■□▲△▼▽♦♢※†‡✿❀✽✻❖⁂]{1,9}$/u;
/** Where a number or symbol in a cell or list item is data, not a section break. */
const TABULAR = "table, ul, ol, dl";

/**
 * Centers each chapter heading of a section along the inline axis: the block a contents
 * entry's anchor begins, or, for an entry opening the section, its first h1-h6 when no text
 * comes before it, or its first text when that reads as the entry's label. Each section break
 * standing alone between a chapter's parts, a number or a row of symbols, is centered the same
 * way. The heading and the blocks around it holding nothing else center their lines and lose
 * their inline indentation, margins, and padding, and its images take auto inline margins.
 * Sizes and block spacing stay the book's. A block too long for a title is left alone. Returns
 * the headings' images.
 */
function applyHeadingCentering(
  document: Document,
  anchors: ReadonlyMap<string, readonly string[]> | undefined,
): Element[] {
  const body = document.body;
  if (!body) return [];
  if (!document.querySelector(`style[${CENTER_HEADINGS_STYLE}]`)) {
    for (const [fragment, labels] of anchors ?? []) {
      const heading = headingAt(document, body, fragment, labels);
      if (heading) markHeading(heading, body);
    }
    for (const marker of sectionBreaks(body)) markHeading(marker, body);
    if (!document.querySelector(`[${HEADING}]`)) return [];
    const style = document.createElementNS(XHTML_NAMESPACE, "style");
    style.setAttribute(CENTER_HEADINGS_STYLE, "");
    style.textContent =
      `:root body [${HEADING}]${OUTRANK} { text-align: center !important; ` +
      "text-align-last: auto !important; text-indent: 0 !important; " +
      "margin-inline: auto !important; padding-inline: 0 !important; } " +
      `:root body [${HEADING}][${HEADING_LEAD}]${OUTRANK} ` +
      "{ text-indent: var(--komori-heading-lead) !important; } " +
      `:root body [${HEADING}] img${OUTRANK}, :root body [${HEADING}] svg${OUTRANK} ` +
      "{ margin-inline: auto !important; } " +
      ":root body [data-komori-text-heading] { zoom: 1.1; } " +
      INK_SHIFT_RULE;
    (document.head ?? document.documentElement).append(style);
  }
  return Array.from(document.querySelectorAll(`[${HEADING}] img`));
}

/** Marks a heading and each block around it that holds nothing else. */
function markHeading(heading: Element, body: HTMLElement): void {
  heading.setAttribute(HEADING, "");
  // Only the text title scales, once; authored child hierarchy remains relative.
  if (heading.textContent?.trim()) {
    heading.setAttribute("data-komori-text-heading", "");
    centerSpacedLine(heading);
  }
  let outermost = heading;
  for (
    let wrapper = heading.parentElement;
    wrapper && wrapper !== body && wrapper.matches(BLOCK_ELEMENTS) && holdsOnly(wrapper, heading);
    wrapper = wrapper.parentElement
  ) {
    wrapper.setAttribute(HEADING, "");
    outermost = wrapper;
  }
  if (!heading.textContent?.trim() && heading.querySelector("img"))
    outermost.setAttribute(IMAGE_HEADING, "");
}

/**
 * Japanese books often place a heading with ideographic spaces (U+3000) before it, such as five
 * before `７`, which do not collapse and would push a centered line off center. A first-line
 * indentation of the spaces after it less those before it centers the rest; spaces after a line
 * break are left.
 */
function centerSpacedLine(heading: Element): void {
  // A book's element belongs to its own frame, so it is not this window's HTMLElement.
  const style = (heading as HTMLElement).style as CSSStyleDeclaration | undefined;
  if (!style || heading.querySelector(HEADING_BLOCKS)) return;
  const text = readingFreeText(heading).replace(/^[^\S\u3000]+|[^\S\u3000]+$/g, "");
  const count = (spaces: string | undefined) => (spaces ?? "").replace(/[^\u3000]/g, "").length;
  const before = count(text.match(/^\s+/)?.[0]);
  const after = heading.querySelector("br") ? 0 : count(text.match(/\s+$/)?.[0]);
  if (before === after || before + after === text.length) return;
  heading.setAttribute(HEADING_LEAD, "");
  style.setProperty("--komori-heading-lead", `${after - before}em`);
}

/** An element's text without ruby readings. */
function readingFreeText(element: Element): string {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (!node.parentElement?.closest("rt, rp")) text += (node as Text).data;
  return text;
}

/** Text compared as a contents label: full-width forms unified, readings and spaces gone. */
const plainLabel = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");

/** Whether a block's text reads as one of an entry's labels, or as part of one. */
function namesEntry(element: Element, labels: readonly string[]): boolean {
  const text = plainLabel(readingFreeText(element));
  return (
    !!text &&
    labels.some((label) => {
      const name = plainLabel(label);
      return !!name && (name.includes(text) || text.includes(name));
    })
  );
}

/**
 * The chapter heading a contents anchor begins, or, for an entry opening the section, the
 * section's first heading, or its first text block when that reads as the entry's label.
 */
function headingAt(
  document: Document,
  body: HTMLElement,
  fragment: string,
  labels: readonly string[],
): Element | null {
  let heading: Element | null;
  let target: Element | null = null;
  if (fragment) {
    let id = fragment;
    try {
      id = decodeURIComponent(fragment);
    } catch {
      // Keep a malformed escape as authored.
    }
    target = document.getElementById(id);
    if (!target || !body.contains(target)) return null;
  }
  // An anchor on the body opens the section as an entry without one does.
  const opening = !target || target === body;
  if (opening) {
    const first = Array.from(body.querySelectorAll(HEADING_ELEMENTS)).find(hasContent);
    heading = target = first && !textBefore(body, first) ? first : firstTextBlock(body, labels);
  } else {
    target = target as Element;
    heading = target.matches(HEADING_BLOCKS) ? target : null;
    // An empty anchor just before a heading, as converters leave, marks that heading: any
    // element, or an empty block (`<h4 id="toc"></h4><p>Prologue</p>`) when the heading
    // reads as the entry's label.
    if (!hasContent(target)) {
      const next = nextContent(target);
      if (next?.matches(HEADING_BLOCKS) && (!heading || namesEntry(next, labels)))
        heading = target = next;
    }
    heading ??= target.parentElement?.closest(HEADING_BLOCKS) ?? null;
  }
  if (!heading || !target || heading === body || !body.contains(heading)) return null;
  if (!hasContent(heading)) return null;
  // No text comes before the anchor in its heading, or before a section's first heading.
  if (textBefore(opening ? body : heading, target)) return null;
  return (heading.textContent ?? "").replace(/\s+/g, "").length <= HEADING_LENGTH_LIMIT
    ? heading
    : null;
}

/** Whether text comes before an element within another holding it. */
function textBefore(scope: Element, target: Element): boolean {
  if (scope === target) return false;
  const before = target.ownerDocument.createRange();
  before.setStart(scope, 0);
  before.setEndBefore(target);
  return !!before.toString().trim();
}

/** The block of a section's first text, when that text reads as one of the entry's labels. */
function firstTextBlock(body: HTMLElement, labels: readonly string[]): Element | null {
  if (!labels.length) return null;
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node as Text).data.trim()) continue;
    const block = node.parentElement?.closest(HEADING_BLOCKS);
    return block && block !== body && namesEntry(block, labels) ? block : null;
  }
  return null;
}

/**
 * The section breaks of a section: a block holding only a row of symbols, or only a number
 * that begins a part of the chapter (an h1-h6, or a block with nothing but blank lines or a
 * heading before it), outside tables and lists and not already a heading.
 */
function sectionBreaks(body: HTMLElement): Element[] {
  return Array.from(body.querySelectorAll(HEADING_BLOCKS)).filter((block) => {
    if (
      (block.textContent?.length ?? 0) > 64 ||
      block.closest(`[${HEADING}], ${TABULAR}`) ||
      block.querySelector(`${HEADING_BLOCKS}, img, svg, a[href], [${HEADING}]`)
    )
      return false;
    const text = readingFreeText(block).replace(/\s+/g, "");
    if (!text) return false;
    if (SECTION_ORNAMENT.test(text)) return true;
    if (!SECTION_NUMBER.test(text)) return false;
    if (block.matches(HEADING_ELEMENTS)) return true;
    let holder = block;
    while (
      holder.parentElement &&
      holder.parentElement !== body &&
      holder.parentElement.matches(BLOCK_ELEMENTS) &&
      holdsOnly(holder.parentElement, block)
    )
      holder = holder.parentElement;
    return blankBefore(holder);
  });
}

/** Whether nothing but blank blocks or a heading comes just before an element in its parent. */
function blankBefore(element: Element): boolean {
  for (let node = element.previousSibling; node; node = node.previousSibling) {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node as Text).data.trim()) return false;
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const sibling = node as Element;
    if (hasContent(sibling)) return sibling.hasAttribute(HEADING);
    return true;
  }
  return true;
}

/** Whether an element holds text or an image. */
function hasContent(element: Element): boolean {
  return !!element.textContent?.trim() || !!element.querySelector("img, svg");
}

/** The element after another, skipping whitespace and empty elements, unless text comes first. */
function nextContent(element: Element): Element | null {
  for (let node = element.nextSibling; node; node = node.nextSibling) {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node as Text).data.trim()) return null;
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    if (hasContent(node as Element) || (node as Element).matches("img, svg"))
      return node as Element;
  }
  return null;
}

/** Whether a block holds a heading and nothing else of its own. */
function holdsOnly(block: Element, heading: Element): boolean {
  return (
    block.textContent?.trim() === heading.textContent?.trim() &&
    block.querySelectorAll("img, svg").length === heading.querySelectorAll("img, svg").length
  );
}

const INK_X = "--komori-ink-x";
const INK_Y = "--komori-ink-y";
/**
 * Moves a heading image's drawn content along the inline axis, horizontally in
 * horizontal text and vertically in vertical text, without changing its layout: a
 * translation by the content's share of the box, with the blank part moved past the
 * box's edge clipped away.
 */
const INK_SHIFT_RULE =
  `:root body [${HEADING}] img[${INK_CENTERED}]${OUTRANK} { ` +
  `transform: translateX(var(${INK_X})) !important; clip-path: inset(0 ` +
  `max(0%, var(${INK_X})) 0 max(0%, calc(-1 * var(${INK_X})))) !important; } ` +
  `:root[${VERTICAL_ROOT}] body [${HEADING}] img[${INK_CENTERED}]${OUTRANK} { ` +
  `transform: translateY(var(${INK_Y})) !important; clip-path: inset(` +
  `max(0%, calc(-1 * var(${INK_Y}))) 0 max(0%, var(${INK_Y})) 0) !important; }`;

/** Keeps a heading image's measured content shift on the image, for either writing mode. */
function applyInkShift(image: Element, shift: InkShift): void {
  const style = (image as HTMLElement).style;
  if (!style || image.hasAttribute(INK_CENTERED)) return;
  const percent = (share: number) => `${Number((share * 100).toFixed(3))}%`;
  style.setProperty(INK_X, percent(shift.x));
  style.setProperty(INK_Y, percent(shift.y));
  image.setAttribute(INK_CENTERED, "");
}

/** Whether nothing but whitespace or line breaks lies between an element and the blocks around it. */
function betweenBlocks(element: Element): boolean {
  const alone = (step: (node: Node) => Node | null): boolean => {
    for (let node = step(element); node; node = step(node)) {
      if (node.nodeType === Node.COMMENT_NODE) continue;
      if (node.nodeType === Node.TEXT_NODE) {
        if ((node as Text).data.trim()) return false;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if ((node as Element).localName === "br") continue;
      return (node as Element).matches(LINE_BREAKING_ELEMENTS);
    }
    return true;
  };
  return alone((node) => node.previousSibling) && alone((node) => node.nextSibling);
}

/**
 * A chosen side margin on the body's left and right. EPUB.js pads a vertical page's
 * sides with a fixed 20px; this replaces it, up to a quarter of the page's width, the
 * iframe being as wide as the page. A horizontal page keeps EPUB.js's padding, set
 * inline as important from the column gap, which already holds the chosen margin.
 * None removes it.
 */
function applySideMargin(document: Document, margin: number | undefined): void {
  const existing = document.querySelector(`style[${SIDE_MARGIN_STYLE}]`);
  if (margin === undefined) {
    existing?.remove();
    return;
  }
  const style = existing ?? document.createElementNS(XHTML_NAMESPACE, "style");
  if (!existing) {
    style.setAttribute(SIDE_MARGIN_STYLE, "");
    (document.head ?? document.documentElement).append(style);
  }
  const value = `min(${margin}px, 25vw)`;
  style.textContent = `body { padding-left: ${value} !important; padding-right: ${value} !important; }`;
}

/** The book's own declarations that a chosen presentation adjusts. */
const STYLE_PROPERTIES = ["font-weight", "text-indent"] as const;

/** One font-weight or text-indent declaration of the book's CSS. */
interface StyleRule {
  property: (typeof STYLE_PROPERTIES)[number];
  selector: string;
  value: string;
  important: boolean;
  /** The enclosing conditional rules' preludes, outermost first, such as `@media screen`. */
  conditions: string[];
}

/** Marks the style element holding the chosen font weight's rules. */
const FONT_WEIGHT_STYLE = "data-komori-font-weight";
/** Keeps an element's own inline font weight while a chosen weight replaces it. */
const OWN_FONT_WEIGHT = "data-komori-own-font-weight";

/** A stylesheet link's archive path, resolved against its section's archive path. */
function archivePath(href: string, sectionUrl: string): string | undefined {
  try {
    const base = new URL(sectionUrl, "https://komori-book.invalid/");
    const resolved = new URL(href, base);
    return resolved.origin === base.origin ? resolved.pathname : undefined;
  } catch {
    return undefined;
  }
}

/** A stylesheet's imports, resolved to archive paths, and its own rules, in order. */
interface Stylesheet {
  imports: { path: string; media: string }[];
  rules: StyleRule[];
}

/** The imports and own rules of CSS text whose relative imports resolve against a base. */
function ownStylesheet(text: string, baseUrl: string | undefined): Stylesheet {
  const imports = cssImports(text).flatMap(({ href, media }) => {
    const path = baseUrl ? archivePath(href, baseUrl) : undefined;
    return path ? [{ path, media }] : [];
  });
  return { imports, rules: parseStyleRules(text) };
}

/** The stylesheets CSS text imports, in order, with any media they are limited to. */
function cssImports(text: string): { href: string; media: string }[] {
  const imports: { href: string; media: string }[] = [];
  const pattern = /@import\s+(?:url\(\s*(['"]?)([^'")]*)\1\s*\)|(['"])([^'"]*)\3)\s*([^;]*);/gi;
  for (const match of text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(pattern)) {
    const href = (match[2] ?? match[4] ?? "").trim();
    if (href) imports.push({ href, media: match[5].trim() });
  }
  return imports;
}

/** The font-weight and text-indent declarations of a stylesheet's own rules, in order. */
function parseStyleRules(text: string): StyleRule[] {
  // A constructed stylesheet parses the book's CSS without applying it or loading imports.
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(text);
  } catch {
    return [];
  }
  const rules: StyleRule[] = [];
  const visit = (list: CSSRuleList | undefined, conditions: string[]) => {
    for (const rule of Array.from(list ?? [])) {
      if ("selectorText" in rule && "style" in rule) {
        const declarations = (rule as CSSStyleRule).style;
        for (const property of STYLE_PROPERTIES) {
          const value = declarations.getPropertyValue(property);
          if (!value) continue;
          rules.push({
            property,
            selector: (rule as CSSStyleRule).selectorText,
            value,
            important: declarations.getPropertyPriority(property) === "important",
            conditions,
          });
        }
      } else if ("cssRules" in rule) {
        // Conditional group rules, such as @media and @supports, keep their condition.
        const prelude = rule.cssText.slice(0, rule.cssText.indexOf("{")).trim();
        if (prelude.startsWith("@media") || prelude.startsWith("@supports")) {
          visit((rule as CSSGroupingRule).cssRules, [...conditions, prelude]);
        }
      }
    }
  };
  visit(sheet.cssRules, []);
  return rules;
}

/**
 * A book weight moved by the chosen weight's distance from normal (400), or undefined
 * for relative weights such as `bolder`, which already follow the text around them.
 */
function shiftedWeight(value: string, shift: number): number | undefined {
  const weight = value.trim().toLowerCase();
  const numeric =
    weight === "normal"
      ? 400
      : weight === "bold"
        ? 700
        : /^\d+(\.\d+)?$/.test(weight)
          ? Number(weight)
          : Number.NaN;
  if (!Number.isFinite(numeric)) return undefined;
  return Math.min(1000, Math.max(1, Math.round(numeric + shift)));
}

/** A book rule again with another value, inside the same conditional rules. */
function repeatedRule(rule: StyleRule, value: string): string {
  const priority = rule.important ? " !important" : "";
  let text = `${rule.selector} { ${rule.property}: ${value}${priority}; }`;
  for (const condition of [...rule.conditions].reverse()) text = `${condition} { ${text} }`;
  return text;
}

/** The chosen weight's rules: each of the book's own weight rules again, shifted. */
function fontWeightStyle(rules: readonly StyleRule[], weight: number): string {
  const shift = weight - readerFontWeight.normal;
  // Normal text, and the headings and table headers browsers make bold themselves.
  const css = [
    `html { font-weight: ${weight}; }`,
    `h1, h2, h3, h4, h5, h6, th { font-weight: ${shiftedWeight("bold", shift)}; }`,
  ];
  // The same selectors later in the cascade replace each book rule with its shifted
  // weight, keeping the book's own specificity and order between them.
  for (const rule of rules) {
    if (rule.property !== "font-weight") continue;
    const shifted = shiftedWeight(rule.value, shift);
    if (shifted !== undefined) css.push(repeatedRule(rule, String(shifted)));
  }
  return css.join("\n");
}

/**
 * Set a section's font weight: the chosen weight for its normal text, with every weight
 * the book sets shifted by as much, so its bold text stays bolder. No chosen weight
 * restores the book's own. Before its rules are collected, only normal text and the
 * elements browsers make bold are shifted.
 */
function applyFontWeight(
  document: Document,
  rules: readonly StyleRule[] | undefined,
  weight: number | undefined,
): void {
  const root = document.documentElement;
  if (!root) return;
  let style = document.querySelector(`style[${FONT_WEIGHT_STYLE}]`);
  if (weight === undefined) style?.remove();
  else {
    if (!style) {
      style = document.createElementNS(XHTML_NAMESPACE, "style");
      style.setAttribute(FONT_WEIGHT_STYLE, "");
      (document.head ?? root).append(style);
    }
    style.textContent = fontWeightStyle(rules ?? [], weight);
  }
  // Inline weights outrank every stylesheet, so they are shifted in place.
  const shift = weight === undefined ? 0 : weight - readerFontWeight.normal;
  for (const element of Array.from(
    document.querySelectorAll(`[style*="font"], [${OWN_FONT_WEIGHT}]`),
  )) {
    const inline = (element as HTMLElement).style;
    if (!inline) continue;
    let own = element.getAttribute(OWN_FONT_WEIGHT);
    if (own === null) {
      own = inline.getPropertyValue("font-weight");
      if (!own || weight === undefined) continue;
      element.setAttribute(OWN_FONT_WEIGHT, own);
    }
    const priority = inline.getPropertyPriority("font-weight");
    const shifted = weight === undefined ? undefined : shiftedWeight(own, shift);
    inline.setProperty("font-weight", shifted === undefined ? own : String(shifted), priority);
    if (weight === undefined) element.removeAttribute(OWN_FONT_WEIGHT);
  }
}

/** Set a section's font weight and paragraph indentation from the book's own rules. */
function applyBookStyles(
  document: Document,
  rules: readonly StyleRule[] | undefined,
  presentation: NormalizedPresentation,
): void {
  applyFontWeight(document, rules, presentation.fontWeight);
  applyParagraphIndent(document, rules, presentation.paragraphIndent);
  if (presentation.fontPair?.weights) {
    const weights = new Set([
      1,
      100,
      200,
      300,
      400,
      500,
      600,
      700,
      800,
      900,
      1000,
      presentation.fontWeight!,
    ]);
    for (const rule of rules ?? []) {
      if (rule.property === "font-weight") {
        const weight = shiftedWeight(rule.value, presentation.fontWeight! - 400);
        if (weight !== undefined) weights.add(weight);
      }
    }
    // Computed weights include inherited/relative emphasis and inline shorthands.
    const view = document.defaultView;
    for (const element of document.querySelectorAll<HTMLElement>("html, body, body *")) {
      const inline = Number(element.style?.fontWeight);
      if (inline >= 1 && inline <= 1000) weights.add(inline);
      const computed = Number(view?.getComputedStyle(element).fontWeight);
      if (computed >= 1 && computed <= 1000) weights.add(computed);
    }
    const style = document.querySelector(`style[${FONT_FAMILY_STYLE}]`);
    if (style)
      style.textContent =
        fontPairFaces(presentation.fontPair, [...weights]) +
        `@layer komori-fonts { :root, :root body, :root body * { font-family: ${fontPairStack(presentation.fontPair)} !important; } }`;
  }
}

/** Marks the style element holding the chosen paragraph indentation's rules. */
const PARAGRAPH_INDENT_STYLE = "data-komori-paragraph-indent";
/** Marks a paragraph indented by a leading ideographic space, as Japanese books do. */
const SPACE_INDENTED = "data-komori-space-indent";
/** Keeps an element's own inline indentation while a chosen one replaces it. */
const OWN_TEXT_INDENT = "data-komori-own-text-indent";
const IDEOGRAPHIC_SPACE = "　";

/** Whether a CSS length starts its line further in: a positive number with any unit. */
function positiveIndent(value: string): boolean {
  const match = /^\+?(\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:[a-z]+|%)?$/i.exec(value.trim());
  return !!match && Number.parseFloat(match[1]) > 0;
}

/** Whether a CSS length hangs its first line out, as lists and notes do. */
function hangingIndent(value: string): boolean {
  return /^-(\d|\.\d)/.test(value.trim());
}

/**
 * The chosen indentation's rules: each of the book's own text-indent rules again, with
 * every positive indentation replaced by the chosen one, keeping the book's specificity
 * and order between them. A leading ideographic space counts towards the indentation.
 */
function paragraphIndentStyle(rules: readonly StyleRule[], indent: number): string {
  const css = rules
    .filter((rule) => rule.property === "text-indent")
    .map((rule) => repeatedRule(rule, positiveIndent(rule.value) ? `${indent}em` : rule.value));
  css.push(`p[${SPACE_INDENTED}] { text-indent: ${indent - 1}em !important; }`);
  return css.join("\n");
}

/** Whether a paragraph's readable text begins with an ideographic space. */
function startsWithIdeographicSpace(paragraph: Element): boolean {
  const walker = paragraph.ownerDocument.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest("rt, rp")) continue;
    const text = (node as Text).data.replace(/^[\t\n\f\r ]+/, "");
    if (text) return text.startsWith(IDEOGRAPHIC_SPACE);
  }
  return false;
}

/** Whether an element or one it inherits from matches a selector of the book's. */
function withinSelector(element: Element, selector: string): boolean {
  try {
    return !!element.closest(selector);
  } catch {
    // Selectors with pseudo-elements, such as ::first-line, match no element.
    return false;
  }
}

/**
 * Set a section's paragraph indentation: the chosen indentation, in em of each
 * paragraph's font size, replaces every positive indentation the book sets. A paragraph
 * that begins with an ideographic space is indented by that space plus its text-indent,
 * so together they make the chosen indentation, unless the book hangs it. Paragraphs the
 * book does not indent, and hanging indentation, are kept. No chosen indentation
 * restores the book's own.
 */
function applyParagraphIndent(
  document: Document,
  rules: readonly StyleRule[] | undefined,
  indent: number | undefined,
): void {
  const root = document.documentElement;
  if (!root) return;
  let style = document.querySelector(`style[${PARAGRAPH_INDENT_STYLE}]`);
  if (indent === undefined) {
    style?.remove();
    for (const paragraph of Array.from(document.querySelectorAll(`[${SPACE_INDENTED}]`)))
      paragraph.removeAttribute(SPACE_INDENTED);
  } else {
    if (!style) {
      style = document.createElementNS(XHTML_NAMESPACE, "style");
      style.setAttribute(PARAGRAPH_INDENT_STYLE, "");
      (document.head ?? root).append(style);
    }
    style.textContent = paragraphIndentStyle(rules ?? [], indent);
    const hanging = (rules ?? [])
      .filter((rule) => rule.property === "text-indent" && hangingIndent(rule.value))
      .map((rule) => rule.selector);
    for (const paragraph of Array.from(document.body?.querySelectorAll("p") ?? [])) {
      if (
        !paragraph.hasAttribute(SPACE_INDENTED) &&
        startsWithIdeographicSpace(paragraph) &&
        !hanging.some((selector) => withinSelector(paragraph, selector))
      )
        paragraph.setAttribute(SPACE_INDENTED, "");
    }
  }
  // Inline indentation outranks every stylesheet, so it is replaced in place.
  for (const element of Array.from(
    document.querySelectorAll(`[style*="text-indent"], [${OWN_TEXT_INDENT}]`),
  )) {
    const inline = (element as HTMLElement).style;
    if (!inline) continue;
    let own = element.getAttribute(OWN_TEXT_INDENT);
    if (own === null) {
      own = inline.getPropertyValue("text-indent");
      if (indent === undefined || !positiveIndent(own)) continue;
      element.setAttribute(OWN_TEXT_INDENT, own);
    }
    const priority = inline.getPropertyPriority("text-indent");
    inline.setProperty("text-indent", indent === undefined ? own : `${indent}em`, priority);
    if (indent === undefined) element.removeAttribute(OWN_TEXT_INDENT);
  }
}

/**
 * A target EPUB.js pages a horizontal section to: the character at a text point, or the
 * element at an element point. EPUB.js cannot resolve its own CFI for the start of an
 * element without text, such as a heading holding only an image, and would show the
 * section's first page; it locates an element by its ID instead, here a temporary one
 * when the element has none, released once the target is displayed.
 */
function horizontalTarget(
  contents: EpubPageContents,
  point: Range,
  sectionHref: string,
): { target: string; release?: () => void } {
  const node = point.startContainer;
  const child = node.nodeType === Node.TEXT_NODE ? null : node.childNodes[point.startOffset];
  if (!child || child.nodeType !== Node.ELEMENT_NODE) {
    return { target: contents.cfiFromRange(characterRange(point)) };
  }
  const element = child as Element;
  // At an element's start, such as a contents anchor's, that element is at the point too.
  const container = point.startOffset === 0 ? (node as Element) : undefined;
  const known = element.id || container?.id;
  if (known) return { target: `${sectionHref}#${known}` };
  const id = `komori-point-${++temporaryIds}`;
  element.id = id;
  return { target: `${sectionHref}#${id}`, release: () => element.removeAttribute("id") };
}

let temporaryIds = 0;

/**
 * The character at a collapsed text point. EPUB.js extends a collapsed target to the
 * next space or its text node's end and pages to that range's leftmost box, which in
 * text without spaces can lie on a later page.
 */
function characterRange(point: Range): Range {
  const node = point.startContainer;
  if (!point.collapsed || node.nodeType !== Node.TEXT_NODE) return point;
  const text = (node as Text).data;
  if (point.startOffset >= text.length) return point;
  const range = point.cloneRange();
  const length = (text.codePointAt(point.startOffset) ?? 0) > 0xffff ? 2 : 1;
  range.setEnd(node, point.startOffset + length);
  return range;
}

/** The rendered top of the character or element at a point, in section-document coordinates. */
function pointTop(point: Range): number | null {
  return pointRect(point)?.top ?? null;
}

/**
 * Whether an element of a displayed section document is rendered within the reading
 * area, measured from its first character or, without text, from its element box.
 */
function anchorDisplayed(host: HTMLElement, document: Document, id: string): boolean {
  const anchor = document.getElementById(id);
  const frame = document.defaultView?.frameElement;
  if (!anchor || !frame) return false;
  const point = document.createRange();
  point.selectNodeContents(anchor);
  point.collapse(true);
  const box = pointRect(point);
  if (!box?.width && !box?.height) return false;
  const origin = frame.getBoundingClientRect();
  const area = host.getBoundingClientRect();
  const top = origin.top + box.top;
  const left = origin.left + box.left;
  return (
    top < area.bottom &&
    top + box.height > area.top &&
    left < area.right &&
    left + box.width > area.left
  );
}

/** The rendered box of the character or element at a point, in section-document coordinates. */
function pointRect(point: Range): Pick<DOMRect, "top" | "left" | "width" | "height"> | null {
  const node = point.startContainer;
  const probe = point.cloneRange();
  let target = node;
  // Section documents live in the renderer iframe, so use nodeType, not instanceof.
  if (node.nodeType === Node.TEXT_NODE) {
    const length = (node as Text).data.length;
    if (point.startOffset < length) probe.setEnd(node, point.startOffset + 1);
    else if (point.startOffset > 0) probe.setStart(node, point.startOffset - 1);
  } else {
    target = node.childNodes[point.startOffset] ?? node;
    // A drawing is measured by its own box, as an image is, not by its first shape,
    // which can lie anywhere inside it, such as an SVG page's first line of drawn text.
    if (target.nodeType === Node.ELEMENT_NODE && (target as Element).localName === "svg")
      return (target as Element).getBoundingClientRect();
    probe.selectNodeContents(target);
  }
  const rect = probe.getClientRects?.()[0] ?? probe.getBoundingClientRect?.();
  if (rect?.width || rect?.height) return rect;
  // Collapsed whitespace between elements renders nothing. A point there, such as one
  // found again from its text fraction before a heading holding only an image, lies
  // at the next element.
  if (target.nodeType === Node.TEXT_NODE && !(target as Text).data.trim()) {
    for (let next = target.nextSibling; next; next = next.nextSibling) {
      if (next.nodeType === Node.ELEMENT_NODE) {
        const box = (next as Element).getBoundingClientRect();
        if (box.width || box.height) return box;
      } else if (next.textContent?.trim()) break;
    }
  }
  // A range without text, such as a heading holding only an image, has no rects, and its
  // empty bounding rect reads top 0. Measure the rendered element's box instead.
  const element =
    target.nodeType === Node.ELEMENT_NODE ? (target as Element) : target.parentElement;
  return element?.getBoundingClientRect() ?? rect ?? null;
}

/** A short FNV-1a fingerprint that detects a different section without storing its path. */
function sectionKey(href: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(href)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The point of a section's last content: its last character, or a rendered image after
 * it, such as an illustration closing a chapter on a page of its own.
 */
function lastContentPoint(contents: EpubPageContents): Range | null {
  const body = contents.document?.body;
  if (!body) return null;
  let last: Node | null = null;
  for (let node = followingNode(body, body, true); node;) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      const media = MEDIA_ELEMENTS.has(element.localName);
      const box = media ? element.getBoundingClientRect() : undefined;
      if (box && (box.width || box.height)) last = element;
      node = followingNode(body, node, !media);
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) last = node;
    node = followingNode(body, node, false);
  }
  const range = contents.document.createRange();
  const image = last?.nodeType === Node.ELEMENT_NODE ? pointBefore(last) : undefined;
  if (image) {
    range.setStart(image.node, image.offset);
    range.collapse(true);
  } else if (last) {
    const end = last.textContent?.length ?? 0;
    range.setStart(last, Math.max(0, end - 1));
    range.setEnd(last, end);
  } else {
    range.selectNodeContents(body);
    range.collapse(false);
  }
  return range;
}

/** A contents href as a path relative to the package, or null for external links. */
function resolveNavHref(href: string, base: string): string | null {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return null;
  try {
    const resolved = new URL(href, `https://komori.invalid/${base.replace(/^\/+/, "")}`);
    return `${resolved.pathname.slice(1)}${resolved.hash}`;
  } catch {
    return null;
  }
}

async function packageDocument(book: Book): Promise<Document | null> {
  const packagePath = (book.container as { packagePath?: string } | undefined)?.packagePath;
  if (!packagePath) return null;
  try {
    const document = await book.archive.request(`/${packagePath.replace(/^\/+/, "")}`, "xml");
    return document instanceof Document ? document : null;
  } catch {
    // Optional package hints must not prevent an otherwise valid book.
    return null;
  }
}

async function declaredWritingMode(book: Book): Promise<"vertical-rl" | "vertical-lr" | null> {
  const mode = (await packageDocument(book))
    ?.querySelector('meta[name="primary-writing-mode"]')
    ?.getAttribute("content");
  return mode === "vertical-rl" || mode === "vertical-lr" ? mode : null;
}

/** Only authored ToC declarations identify the page; labels and filenames are not guesses. */
async function spineTocBoundary(
  book: Book,
  navigation: { landmark?(type: string): unknown } | undefined,
): Promise<ImageBlurBoundary | undefined> {
  const navPath = (book as unknown as { package?: { navPath?: string } }).package?.navPath ?? "";
  const landmark = navigation?.landmark?.("toc") as { href?: unknown } | undefined;
  const guide = (await packageDocument(book))
    ?.querySelector('guide > reference[type="toc"]')
    ?.getAttribute("href");
  for (const href of [
    typeof landmark?.href === "string" ? resolveNavHref(landmark.href, navPath) : null,
    guide ? resolveNavHref(guide, "") : null,
    navPath || null,
  ]) {
    if (!href) continue;
    const section = book.spine.get(href.split("#")[0]);
    if (!section) continue;
    let ordinal = -1;
    let index: number | undefined;
    book.spine.each((candidate: { linear?: boolean }) => {
      ordinal++;
      if (candidate === section && candidate.linear) index = ordinal;
    });
    if (index === undefined) continue;
    let fragment = href.split("#")[1];
    try {
      if (fragment) fragment = decodeURIComponent(fragment);
    } catch {
      // A malformed fragment falls back to the contents section's end.
      fragment = "";
    }
    return { spineIndex: index, ...(fragment && { fragment }) };
  }
  return undefined;
}

/** The spine href of the declared cover page: the EPUB 3 cover landmark or EPUB 2 guide cover. */
/** The navigation document's path, which its links are relative to. */
function navigationBase(book: Book): string {
  const navPath = (book as unknown as { package?: { navPath?: string; ncxPath?: string } }).package;
  return navPath?.navPath || navPath?.ncxPath || "";
}

async function spineCoverPage(
  book: Book,
  navigation: { landmark?(type: string): unknown } | undefined,
  navBase: string,
): Promise<string | null> {
  const landmark = navigation?.landmark?.("cover") as { href?: unknown } | undefined;
  const guide = (await packageDocument(book))
    ?.querySelector('guide > reference[type="cover"]')
    ?.getAttribute("href");
  for (const href of [
    typeof landmark?.href === "string" ? resolveNavHref(landmark.href, navBase) : null,
    guide ? resolveNavHref(guide, "") : null,
  ]) {
    const path = href?.split("#")[0];
    if (path && book.spine.get(path)) return path;
  }
  return null;
}

/** Whether a package document shows one image and no readable text, like a cover page. */
async function imageOnlyPage(book: Book, path: string): Promise<boolean> {
  try {
    const document = (await book.load(path)) as Document | undefined;
    return !!document && showsOneImage(document);
  } catch {
    return false;
  }
}

/**
 * A section document with one image and no readable text, such as a cover or an insert, or
 * an SVG page, whose drawing is its page whatever text it draws.
 */
function showsOneImage(document: Document): boolean {
  if (!document.body) return false;
  if (isSvgPage(document)) return true;
  if (shownText(document.body).trim()) return false;
  return document.body.querySelectorAll("img, image").length === 1;
}

function releaseBook(book: Book): void {
  // EPUB.js revokes archive URLs, but its generated CSS blob URLs are separate.
  const cssUrls =
    (book.resources as { replacementUrls?: string[] } | undefined)?.replacementUrls?.filter((url) =>
      url?.startsWith("blob:"),
    ) ?? [];
  try {
    book.destroy(); // Also destroys the rendition, archive and iframe listeners.
  } finally {
    for (const url of cssUrls) URL.revokeObjectURL(url);
  }
}

async function firstDisplayableSection(book: Book, signal: AbortSignal): Promise<string | null> {
  const sections: Array<ReturnType<Book["spine"]["get"]>> = [];
  book.spine.each((section: NonNullable<(typeof sections)[number]>) => {
    if (section.linear) sections.push(section);
  });
  const candidates = sections.filter(
    (section): section is NonNullable<typeof section> => !!section,
  );
  for (const section of candidates) {
    if (signal.aborted) return null;
    try {
      await section.load(book.load.bind(book));
      if (signal.aborted) return null;
      if (section.document?.documentElement) return section.href;
    } catch {
      // A broken early spine item need not hide later readable content.
    } finally {
      section.unload();
    }
  }
  return null;
}

import { sameFontPair, type ReaderFontPair } from "./fontChoices";
import type { ReaderSerifFont, ReaderSansFont } from "./fontFamilies";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  readerFontSize,
  type ReaderBlurMode,
  type ReaderFuriganaStyle,
  type ReaderTextOrientation,
  type ReaderPageLayout,
  type ReaderViewMode,
  type ReaderWritingMode,
} from "./presentation";
import { ReaderPositionSaver } from "./readingPosition";
import { registerWindowFlush } from "../../app/windowLifecycle";
import type { LookupTriggerPreferences } from "./lookupTriggers";
import type {
  ReaderBookProgress,
  ReaderBookmarkLocator,
  ReaderBookmarkPlace,
  ReaderContentsEntry,
  ReaderLocator,
  ReaderPageTurnAvailability,
  ReaderPositionBinding,
  ReaderPositionStore,
  ReaderPresentation,
  ReaderRenderer,
  ReaderRendererFactory,
  ReaderSelection,
  ReaderStatus,
  ReaderSearchScope,
  ReaderSearchResults,
  ReaderImages,
  ReaderImageBlurBoundary,
  ReaderImageResource,
} from "./renderer";

const unavailable: ReaderPageTurnAvailability = { canAdvance: false, canRetreat: false };
/** How long a book waits for its fonts before it opens without them. */
const FONTS_WAIT_LIMIT_MS = 1000;

interface RendererState {
  factory?: ReaderRendererFactory;
  status: ReaderStatus;
  availability: ReaderPageTurnAvailability;
  turning: boolean;
  /** Whether a presentation change is laying the book out again. */
  reflowing: boolean;
  contents: ReaderContentsEntry[];
  currentEntryId: string | null;
  navigationError: boolean;
  progress: ReaderBookProgress | null;
  /** Whether the progress follows a jump (contents, bookmark, search, image, or reflow). */
  progressJumped: boolean;
  imageBlurBoundary: ReaderImageBlurBoundary;
}

const emptyBook = {
  reflowing: false,
  contents: [],
  currentEntryId: null,
  navigationError: false,
  progress: null,
  progressJumped: true,
  imageBlurBoundary: "unavailable" as ReaderImageBlurBoundary,
};

export function useReaderRenderer(
  factory?: ReaderRendererFactory,
  onContentDocument?: (document: Document) => void,
  positionStore?: ReaderPositionStore,
  fontSize: number = readerFontSize.default,
  lineHeight?: number,
  fontWeight?: number,
  paragraphIndent?: number,
  sideMargin?: number,
  writingMode?: ReaderWritingMode,
  viewMode?: ReaderViewMode,
  maxHeight?: number,
  textOrientation?: ReaderTextOrientation,
  paragraphMargin?: number,
  hideFurigana?: boolean,
  blurImage?: boolean,
  textColor?: string,
  selectionColor?: string,
  highlightColor?: string,
  onSelectionChanged?: (selection: ReaderSelection | null) => void,
  lookupTriggers?: LookupTriggerPreferences,
  fontFamilyGroup1?: ReaderSerifFont,
  fontFamilyGroup2?: ReaderSansFont,
  blurMode?: ReaderBlurMode,
  textJustification?: boolean,
  prettyTextWrap?: boolean,
  letterSpacing?: number,
  wordSpacing?: number,
  maxWidth?: number,
  pageLayout?: ReaderPageLayout,
  fontPair?: ReaderFontPair,
  vnParagraphs?: number,
  vnTextSpeed?: number,
  furiganaStyle?: ReaderFuriganaStyle,
  /** Whether the fonts are known: a book waits for them, so its first layout is its last. */
  fontsKnown = true,
) {
  // A book waits for its fonts once, as it opens, and not for long; a font chosen while
  // reading lays the open book out again.
  const [awaitingFonts, setAwaitingFonts] = useState(!fontsKnown);
  if (awaitingFonts && fontsKnown) setAwaitingFonts(false);
  useEffect(() => {
    if (!awaitingFonts) return;
    const timer = setTimeout(() => setAwaitingFonts(false), FONTS_WAIT_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [awaitingFonts]);
  const triggersRef = useRef(lookupTriggers);
  triggersRef.current = lookupTriggers;
  const hostRef = useRef<HTMLDivElement>(null);
  const presentationRef = useRef<ReaderPresentation>({
    fontSize,
    lineHeight,
    fontPair,
    fontFamilyGroup1,
    fontFamilyGroup2,
    fontWeight,
    paragraphIndent,
    paragraphMargin,
    sideMargin,
    maxWidth,
    pageLayout,
    maxHeight,
    writingMode,
    textOrientation,
    textJustification,
    prettyTextWrap,
    letterSpacing,
    wordSpacing,
    hideFurigana,
    furiganaStyle,
    blurImage,
    blurMode,
    textColor,
    selectionColor,
    highlightColor,
    viewMode,
    vnParagraphs,
    vnTextSpeed,
  });
  presentationRef.current = {
    fontSize,
    lineHeight,
    fontPair,
    fontFamilyGroup1,
    fontFamilyGroup2,
    fontWeight,
    paragraphIndent,
    paragraphMargin,
    sideMargin,
    maxWidth,
    pageLayout,
    maxHeight,
    writingMode,
    textOrientation,
    textJustification,
    prettyTextWrap,
    letterSpacing,
    wordSpacing,
    hideFurigana,
    furiganaStyle,
    blurImage,
    blurMode,
    textColor,
    selectionColor,
    highlightColor,
    viewMode,
    vnParagraphs,
    vnTextSpeed,
  };
  const [state, setState] = useState<RendererState>({
    factory,
    status: factory ? "loading" : "empty",
    availability: unavailable,
    turning: false,
    ...emptyBook,
  });
  const activeRef = useRef<{
    factory: ReaderRendererFactory;
    renderer: ReaderRenderer;
    navigationPending: boolean;
    ready: boolean;
    /** Whether the latest move was a jump rather than a turn or a scroll. */
    jumped: boolean;
    /** The presentation the renderer displays or is applying. */
    presentation: ReaderPresentation;
  } | null>(null);

  /** Where the last search jump's match shows, while it is still marked. */
  const searchMatchRect = useCallback(() => {
    const active = activeRef.current;
    return active?.ready ? (active.renderer.searchMatchRect?.() ?? null) : null;
  }, []);
  /** A saved place's book offset, once the book is counted. */
  const locatorOffset = useCallback((locator: ReaderLocator) => {
    const active = activeRef.current;
    return active?.ready ? active.renderer.locatorOffset?.(locator) : undefined;
  }, []);
  const highlightPointerMatch = useCallback((scanId: number | null, length?: number) => {
    const active = activeRef.current;
    if (active?.ready) active.renderer.highlightPointerMatch?.(scanId, length);
  }, []);
  const setNoteHighlights = useCallback((notes: readonly import("./notes").ReaderNote[]) => {
    const active = activeRef.current;
    if (active?.ready) active.renderer.setNoteHighlights?.(notes);
  }, []);
  const listImages = useCallback(async (signal: AbortSignal): Promise<ReaderImages> => {
    const active = activeRef.current;
    if (!active?.ready || !active.renderer.listImages || signal.aborted)
      throw Error("Images unavailable");
    const result = await active.renderer.listImages(signal);
    if (signal.aborted || activeRef.current !== active) throw Error("Images cancelled");
    return result;
  }, []);
  const imageOwners = useRef(new Map<string, ReaderRenderer>());
  const imageAt = useCallback(async (element: Element, signal: AbortSignal) => {
    const active = activeRef.current;
    if (!active?.ready || !active.renderer.imageAt || signal.aborted) return null;
    const result = await active.renderer.imageAt(element, signal);
    return signal.aborted || activeRef.current !== active ? null : result;
  }, []);
  const loadImage = useCallback(
    async (
      id: string,
      size: "thumbnail" | "viewer",
      signal: AbortSignal,
    ): Promise<ReaderImageResource> => {
      const active = activeRef.current;
      if (!active?.ready || !active.renderer.loadImage || signal.aborted)
        throw Error("Image unavailable");
      const resource = await active.renderer.loadImage(id, size, signal);
      if (signal.aborted || activeRef.current !== active) {
        active.renderer.releaseImage?.(resource.url);
        throw Error("Image cancelled");
      }
      imageOwners.current.set(resource.url, active.renderer);
      return resource;
    },
    [],
  );
  const releaseImage = useCallback((url: string) => {
    imageOwners.current.get(url)?.releaseImage?.(url);
    imageOwners.current.delete(url);
  }, []);
  const searchBook = useCallback(
    async (
      query: string,
      scope: ReaderSearchScope,
      signal: AbortSignal,
    ): Promise<ReaderSearchResults> => {
      const active = activeRef.current;
      if (!active?.ready || !active.renderer.searchBook || signal.aborted)
        throw Error("Search unavailable");
      const result = await active.renderer.searchBook(query, scope, signal);
      if (signal.aborted || activeRef.current !== active) throw Error("Search cancelled");
      return result;
    },
    [],
  );
  function jumpToResult(
    kind: "goToSearchResult" | "goToImage",
    id: string,
    signal: AbortSignal,
    onSettled: (success: boolean) => void,
  ): boolean {
    const active = activeRef.current;
    if (!active?.ready || active.navigationPending || !active.renderer[kind] || signal.aborted)
      return false;
    active.navigationPending = true;
    active.jumped = true;
    const { factory } = active;
    setState((current) => (current.factory === factory ? { ...current, turning: true } : current));
    void (async () => {
      let success = false;
      try {
        success = await active.renderer[kind]!(id, signal);
      } catch {
        /* Only safe UI feedback reaches the panel. */
      } finally {
        active.navigationPending = false;
        if (activeRef.current === active) {
          setState((current) =>
            current.factory === factory ? { ...current, turning: false } : current,
          );
          if (!signal.aborted) onSettled(success);
          applyPresentation();
        }
      }
    })();
    return true;
  }
  useEffect(() => {
    if (lookupTriggers) activeRef.current?.renderer.setLookupTriggers?.(lookupTriggers);
  }, [lookupTriggers]);

  // A presentation change reflows the book, so it joins the one navigation queue: it
  // waits for a pending turn or jump, and turns wait for it. The latest choice wins.
  const applyPresentation = useCallback(() => {
    const active = activeRef.current;
    const presentation = presentationRef.current;
    if (!active?.ready || active.navigationPending) return;
    if (samePresentation(active.presentation, presentation)) return;
    if (!active.renderer.setPresentation) return;
    const { factory } = active;
    active.navigationPending = true;
    active.jumped = true;
    active.presentation = presentation;
    setState((current) =>
      current.factory === factory ? { ...current, turning: true, reflowing: true } : current,
    );
    void (async () => {
      try {
        await active.renderer.setPresentation!(presentation);
      } catch {
        // The book stays readable at its previous layout.
      } finally {
        active.navigationPending = false;
        if (activeRef.current === active) {
          setState((current) =>
            current.factory === factory
              ? { ...current, turning: false, reflowing: false }
              : current,
          );
          applyPresentation();
        }
      }
    })();
  }, []);

  useEffect(applyPresentation, [
    fontSize,
    lineHeight,
    fontPair,
    fontFamilyGroup1,
    fontFamilyGroup2,
    fontWeight,
    paragraphIndent,
    paragraphMargin,
    sideMargin,
    maxWidth,
    pageLayout,
    maxHeight,
    writingMode,
    textOrientation,
    textJustification,
    prettyTextWrap,
    letterSpacing,
    wordSpacing,
    hideFurigana,
    blurImage,
    furiganaStyle,
    blurMode,
    textColor,
    selectionColor,
    highlightColor,
    viewMode,
    vnParagraphs,
    vnTextSpeed,
    applyPresentation,
  ]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!factory) {
      activeRef.current = null;
      setState({
        factory,
        status: "empty",
        availability: unavailable,
        turning: false,
        ...emptyBook,
      });
      return;
    }
    if (awaitingFonts) {
      activeRef.current = null;
      setState({
        factory,
        status: "loading",
        availability: unavailable,
        turning: false,
        ...emptyBook,
      });
      return;
    }

    const controller = new AbortController();
    let active = true;
    let renderer: ReaderRenderer | undefined;
    let disposed = false;
    // One saver per mounted book: a late location from this book can never be
    // written under another catalog ID, and a pending position is flushed on close.
    const saver = positionStore && new ReaderPositionSaver(positionStore);
    const progressStore = positionStore?.saveProgress && {
      save: positionStore.saveProgress.bind(positionStore),
    };
    const progressSaver = progressStore && new ReaderPositionSaver(progressStore, 2000);
    const stopFlushing = registerWindowFlush(() => {
      settlePosition();
      return Promise.all([saver?.flush(), progressSaver?.flush()]).then(
        (saved) => !saved.includes(false),
      );
    });
    const position: ReaderPositionBinding | undefined = saver && {
      initial: positionStore.load().catch(() => null),
      onLocationChanged: (locator) => {
        if (active) saver.update(locator);
      },
    };

    /** A scroll the book closes in is saved where it stopped, before it settles. */
    function settlePosition() {
      try {
        if (active) renderer?.settlePosition?.();
      } catch {
        // The last settled position is saved instead.
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      void Promise.all([saver?.dispose(), progressSaver?.dispose()]).finally(stopFlushing);
      if (activeRef.current?.renderer === renderer) activeRef.current = null;
      try {
        renderer?.dispose();
      } catch {
        // Adapter teardown must not prevent the host from being cleared.
      } finally {
        host?.replaceChildren();
      }
    }

    setState({
      factory,
      status: "loading",
      availability: unavailable,
      turning: false,
      ...emptyBook,
    });
    const presentation = presentationRef.current;
    try {
      renderer = factory();
      if (triggersRef.current) renderer.setLookupTriggers?.(triggersRef.current);
      const mounted = {
        factory,
        renderer,
        navigationPending: false,
        ready: false,
        jumped: true,
        presentation,
      };
      activeRef.current = mounted;
      Promise.resolve(
        renderer.mount(
          host,
          controller.signal,
          (availability) => {
            if (!active) return;
            setState((current) =>
              current.factory === factory ? { ...current, availability } : current,
            );
          },
          onContentDocument,
          (contents) => {
            if (!active) return;
            setState((current) =>
              current.factory === factory ? { ...current, contents } : current,
            );
          },
          position,
          (progress) => {
            if (!active) return;
            if (progress.total > 0) {
              const { unit, current, total } = progress;
              progressSaver?.update({ unit, current, total });
            }
            setState((current) =>
              current.factory === factory
                ? {
                    ...current,
                    progress,
                    progressJumped: mounted.jumped,
                    currentEntryId: progress.chapter.entryId ?? null,
                  }
                : current,
            );
          },
          presentation,
          (selection) => {
            if (active) onSelectionChanged?.(selection);
          },
        ),
      ).then(
        (result) => {
          if (!active) return;
          if (result !== "ready") {
            active = false;
            dispose();
          } else {
            mounted.ready = true;
            // A size, spacing, or weight chosen while the book was opening applies now.
            applyPresentation();
          }
          setState((current) =>
            current.factory === factory
              ? {
                  ...current,
                  status: result,
                  imageBlurBoundary: renderer?.getImageBlurBoundary?.() ?? "unavailable",
                  availability: result === "ready" ? current.availability : unavailable,
                }
              : current,
          );
        },
        () => {
          if (!active) return;
          active = false;
          dispose();
          setState({
            factory,
            status: "error",
            availability: unavailable,
            turning: false,
            ...emptyBook,
          });
        },
      );
    } catch {
      active = false;
      dispose();
      setState({
        factory,
        status: "error",
        availability: unavailable,
        turning: false,
        ...emptyBook,
      });
    }

    return () => {
      settlePosition();
      active = false;
      dispose();
    };
  }, [
    factory,
    awaitingFonts,
    onContentDocument,
    positionStore,
    applyPresentation,
    onSelectionChanged,
  ]);

  const visible: RendererState =
    state.factory === factory
      ? state
      : {
          factory,
          status: factory ? "loading" : "empty",
          availability: unavailable,
          turning: false,
          ...emptyBook,
        };

  function turnPage(direction: "advance" | "retreat", onDone?: () => void): boolean {
    const active = activeRef.current;
    if (!active || active.factory !== factory || active.navigationPending) return false;
    if (
      visible.status !== "ready" ||
      !visible.availability[direction === "advance" ? "canAdvance" : "canRetreat"]
    )
      return false;
    active.navigationPending = true;
    active.jumped = false;
    setState((current) => (current.factory === factory ? { ...current, turning: true } : current));
    void (async () => {
      try {
        if (direction === "advance") await active.renderer.advancePage();
        else await active.renderer.retreatPage();
      } catch {
        if (activeRef.current === active) {
          activeRef.current = null;
          try {
            active.renderer.dispose();
          } catch {
            /* Keep the Reader recoverable. */
          }
          hostRef.current?.replaceChildren();
          setState({
            factory,
            status: "error",
            availability: unavailable,
            turning: false,
            ...emptyBook,
          });
        }
      } finally {
        active.navigationPending = false;
        onDone?.();
        if (activeRef.current === active) {
          setState((current) =>
            current.factory === factory ? { ...current, turning: false } : current,
          );
          applyPresentation();
        }
      }
    })();
    return true;
  }

  function goToContentsEntry(entryId: string, onSettled?: (succeeded: boolean) => void): boolean {
    const active = activeRef.current;
    if (
      !active ||
      active.factory !== factory ||
      active.navigationPending ||
      visible.status !== "ready" ||
      !active.renderer.goToContentsEntry ||
      !visible.contents.some(function contains(entry): boolean {
        return (entry.id === entryId && entry.navigable) || entry.children.some(contains);
      })
    )
      return false;
    active.navigationPending = true;
    active.jumped = true;
    setState((current) =>
      current.factory === factory ? { ...current, turning: true, navigationError: false } : current,
    );
    void (async () => {
      let succeeded = false;
      try {
        succeeded = await active.renderer.goToContentsEntry!(entryId);
      } catch {
        // The UI reports a path-safe failure without adapter details.
      } finally {
        active.navigationPending = false;
        if (activeRef.current === active) {
          setState((current) =>
            current.factory === factory
              ? {
                  ...current,
                  turning: false,
                  navigationError: !succeeded,
                  // Before the book is counted, a jump still marks its entry.
                  currentEntryId: succeeded ? entryId : current.currentEntryId,
                }
              : current,
          );
          onSettled?.(succeeded);
          applyPresentation();
        }
      }
    })();
    return true;
  }

  async function captureNote(): Promise<import("./notes").NotePassage | null> {
    const active = activeRef.current;
    if (
      !active?.ready ||
      active.factory !== factory ||
      active.navigationPending ||
      !active.renderer.captureNote
    )
      return null;
    active.navigationPending = true;
    try {
      const passage = await active.renderer.captureNote();
      return activeRef.current === active ? passage : null;
    } catch {
      return null;
    } finally {
      active.navigationPending = false;
      if (activeRef.current === active) applyPresentation();
    }
  }

  async function captureBookmark(): Promise<ReaderBookmarkPlace | null> {
    const active = activeRef.current;
    if (
      !active?.ready ||
      active.factory !== factory ||
      active.navigationPending ||
      !active.renderer.captureBookmark
    )
      return null;
    active.navigationPending = true;
    try {
      const place = await active.renderer.captureBookmark();
      return activeRef.current === active ? place : null;
    } catch {
      return null;
    } finally {
      active.navigationPending = false;
      if (activeRef.current === active) applyPresentation();
    }
  }

  function goToBookmark(
    locator: ReaderBookmarkLocator,
    onSettled: (succeeded: boolean) => void,
  ): boolean {
    const active = activeRef.current;
    if (
      !active?.ready ||
      active.factory !== factory ||
      active.navigationPending ||
      !active.renderer.goToBookmark
    )
      return false;
    active.navigationPending = true;
    active.jumped = true;
    setState((current) => (current.factory === factory ? { ...current, turning: true } : current));
    void (async () => {
      let succeeded = false;
      try {
        succeeded = await active.renderer.goToBookmark!(locator);
      } catch {
        /* The bookmark remains manageable after a failed resolution. */
      } finally {
        active.navigationPending = false;
        if (activeRef.current === active) {
          setState((current) =>
            current.factory === factory ? { ...current, turning: false } : current,
          );
          onSettled(succeeded);
          applyPresentation();
        }
      }
    })();
    return true;
  }

  /**
   * Scroll a continuously displayed book; outside the navigation queue, like the scrollbar.
   * At the end or start of a chapter shown alone, reading on turns to the neighbouring
   * chapter in the queue instead.
   */
  function scrollBy(distance: number): boolean {
    const scrolled = scrollWithin(distance);
    if (scrolled !== "edge") return scrolled === "scrolled";
    return turnPage(distance > 0 ? "advance" : "retreat");
  }

  /**
   * Scroll a continuously displayed book without leaving the chapter shown alone: "edge"
   * when reading on would turn to the neighbouring chapter instead.
   */
  function scrollWithin(distance: number): "scrolled" | "edge" | "unavailable" {
    const active = activeRef.current;
    if (!active?.ready || active.factory !== factory || active.navigationPending)
      return "unavailable";
    if (visible.status !== "ready" || !visible.availability.scrollAxis) return "unavailable";
    if (!active.renderer.scrollBy) return "unavailable";
    active.jumped = false;
    return active.renderer.scrollBy(distance) !== false ? "scrolled" : "edge";
  }

  /**
   * The browser scrolls a continuously displayed book itself, as a sideways or Shift wheel
   * does across a vertical book's lines: that is reading on, like `scrollWithin`.
   */
  function scrolledNatively(): void {
    const active = activeRef.current;
    if (!active?.ready || active.factory !== factory || active.navigationPending) return;
    if (visible.status !== "ready" || !visible.availability.scrollAxis) return;
    active.jumped = false;
  }

  /** The Reader's own scrollbar follows and moves the ready, continuously displayed book. */
  const scrollTrack = {
    metrics: () => {
      const active = activeRef.current;
      if (!active?.ready || active.factory !== factory) return null;
      return active.renderer.scrollMetrics?.() ?? null;
    },
    scrollTo: (position: number) => {
      const active = activeRef.current;
      if (!active?.ready || active.factory !== factory || active.navigationPending) return;
      active.jumped = false;
      active.renderer.scrollToPosition?.(position);
    },
    watch: (listener: () => void) => activeRef.current?.renderer.watchScroll?.(listener) ?? noop,
  };

  /** The book's reading area's height in pixels, or null without a ready book. */
  async function measureReadingHeight(): Promise<number | null> {
    const active = activeRef.current;
    const height = hostRef.current?.clientHeight;
    if (!active?.ready || active.factory !== factory || !height) return null;
    return height;
  }

  return {
    hostRef,
    revealVnText: () => activeRef.current?.renderer.revealVnText?.(),
    highlightPointerMatch,
    searchMatchRect,
    locatorOffset,
    setNoteHighlights,
    status: visible.status,
    pageTurns: visible.availability,
    turning: visible.turning,
    reflowing: visible.reflowing,
    turnPage,
    scrollBy,
    scrollWithin,
    scrolledNatively,
    scrollTrack,
    contents: visible.contents,
    currentEntryId: visible.currentEntryId,
    navigationError: visible.navigationError,
    goToContentsEntry,
    captureBookmark,
    captureNote,
    goToBookmark,
    searchBook,
    goToSearchResult: (id: string, signal: AbortSignal, settled: (success: boolean) => void) =>
      jumpToResult("goToSearchResult", id, signal, settled),
    listImages,
    imageAt,
    loadImage,
    releaseImage,
    goToImage: (id: string, signal: AbortSignal, settled: (success: boolean) => void) =>
      jumpToResult("goToImage", id, signal, settled),
    progress: visible.progress,
    progressJumped: visible.progressJumped,
    imageBlurBoundary: visible.imageBlurBoundary,
    measureReadingHeight,
  };
}

const noop = () => {};

function samePresentation(a: ReaderPresentation, b: ReaderPresentation): boolean {
  return (
    a.fontSize === b.fontSize &&
    a.lineHeight === b.lineHeight &&
    sameFontPair(a.fontPair, b.fontPair) &&
    a.fontFamilyGroup1 === b.fontFamilyGroup1 &&
    a.fontFamilyGroup2 === b.fontFamilyGroup2 &&
    a.fontWeight === b.fontWeight &&
    a.paragraphIndent === b.paragraphIndent &&
    a.paragraphMargin === b.paragraphMargin &&
    a.sideMargin === b.sideMargin &&
    a.maxWidth === b.maxWidth &&
    a.pageLayout === b.pageLayout &&
    a.maxHeight === b.maxHeight &&
    a.writingMode === b.writingMode &&
    a.textOrientation === b.textOrientation &&
    (a.textJustification ?? false) === (b.textJustification ?? false) &&
    (a.prettyTextWrap ?? false) === (b.prettyTextWrap ?? false) &&
    (a.letterSpacing ?? 0) === (b.letterSpacing ?? 0) &&
    (a.wordSpacing ?? 0) === (b.wordSpacing ?? 0) &&
    (a.hideFurigana ?? false) === (b.hideFurigana ?? false) &&
    (a.furiganaStyle ?? "hide") === (b.furiganaStyle ?? "hide") &&
    (a.blurImage ?? false) === (b.blurImage ?? false) &&
    (a.blurMode ?? "all") === (b.blurMode ?? "all") &&
    a.textColor === b.textColor &&
    a.selectionColor === b.selectionColor &&
    a.highlightColor === b.highlightColor &&
    (a.viewMode ?? "paginated") === (b.viewMode ?? "paginated") &&
    (a.vnParagraphs ?? 1) === (b.vnParagraphs ?? 1) &&
    (a.vnTextSpeed ?? 40) === (b.vnTextSpeed ?? 40)
  );
}

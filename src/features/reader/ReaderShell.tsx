import { i18n, useI18n, type MessageKey } from "../../i18n/i18n";
import { useAsianFontFallback, useReaderFonts, useSystemFontFaces } from "./readerFonts";
import { availableFontWeights, resolveFontWeight } from "./fontWeights";
import {
  type CSSProperties,
  type FocusEvent,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";

import { copyText, guardDocument } from "../../app/nativeSurfaces";
import { AutoscrollController } from "../../app/autoscroll";
import { WindowControls } from "../../components/layout/WindowControls";
import type { StepperSource } from "../../components/ui/Stepper";
import { useAppearance } from "../appearance/AppearanceProvider";
import {
  acceptsReaderInput,
  arrowScrollDistance,
  arrowTurn,
  revealsVnText,
  scrollArrow,
  WheelNavigationQueue,
  wheelSteps,
  wholeWheelSteps,
} from "./navigationInput";
import { lookupQuery, placeLookupPopup } from "./lookupPopup";
import {
  normalizeLookupTriggers,
  triggerEnabled,
  lookupTextAllowed,
  type LookupTrigger,
  type LookupTriggerPreferences,
} from "./lookupTriggers";
import { useReaderMonitor } from "./useReaderMonitor";
import { readerMaxHeight as maxHeightRange } from "./presentation";
import { resolveReaderTheme } from "./readerThemes";
import type { ReaderIdentity } from "./readerIdentity";
import type {
  ReaderBookProgress,
  ReaderPositionStore,
  ReaderProgressUnit,
  ReaderRendererFactory,
  ReaderSelection,
  ReaderStatus,
} from "./renderer";
import { ReaderLookupPopup, type ChildLookupRequest } from "./ReaderLookupPopup";
import { useDefinitionSources } from "../dictionary/definitionSources";
import { ReaderReadingStatus, ReadingSpeedValue, useReadingSpeed } from "./ReaderReadingStatus";
import type { ReadingSpeed } from "../statistics/readingSession";
import type { ReaderFooterPreferences } from "./footerPreferences";
import { ReaderScrollbar } from "./ReaderScrollbar";
import { ReaderSidebar, type ReaderSidebarView } from "./ReaderSidebar";
import { ReaderViewport } from "./ReaderViewport";
import { ReaderBackgroundSurface } from "./ReaderBackground";
import { ReaderImageViewer, type ImageViewerSession } from "./ReaderImageViewer";
import { useReaderRenderer } from "./useReaderRenderer";
import { isFarJump, ReaderReturnPoint, type ReturnPoint } from "./returnPoint";
import { rememberLastBook } from "../startup/startupApi";
import { useReadingSession } from "./useReadingSession";
import type { ReadingSession } from "../statistics/readingSession";
import { useBookmarks } from "./useBookmarks";
import type { BookmarkStore } from "./bookmarks";
import { useNotes } from "./useNotes";
import { NoteEditor } from "./ReaderNotesPanel";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/ContextMenu";
import { copyBookImage, imageBlob, saveBookImage } from "./bookImageActions";
import {
  CopyIcon,
  DownloadSimpleIcon,
  HighlighterIcon,
  NotePencilIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { noteAtPoint, noteHoverCursor } from "./noteHighlights";
import type { NotePassage, NoteStore } from "./notes";
import { commandTarget, escapeReturnWindow, matchesModifiers, shortcutCommand } from "./shortcuts";
import { popupShortcut } from "./popupShortcuts";
import { libraryCache, libraryReturn } from "../library/libraryCache";

interface Lookup {
  id: number;
  query: string;
  sentence?: string;
  trigger: LookupTrigger;
  /** The root lookup's highlight of its match in the book. */
  onMatch?: (length: number) => void;
  placement: { left: number; top: number; width: number; height: number };
}

interface ReaderShellProps {
  identity?: ReaderIdentity;
  rendererFactory?: ReaderRendererFactory;
  positionStore?: ReaderPositionStore;
  bookmarkStore?: BookmarkStore;
  noteStore?: NoteStore;
}

export function ReaderShell({
  identity = { status: "empty" },
  rendererFactory,
  positionStore,
  bookmarkStore,
  noteStore,
}: ReaderShellProps) {
  const { t } = useI18n();
  // A floating sidebar starts hidden, so a book opens immersed; the left edge brings it back.
  const [sidebarShown, setSidebarShown] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [sidebarView, setSidebarView] = useState<ReaderSidebarView>("main");
  const [roomBesideBook, setRoomBesideBook] = useState(() => !narrowLayout());
  const appearanceRef = useRef<HTMLButtonElement>(null);
  const bookmarksRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLButtonElement>(null);
  const imagesRef = useRef<HTMLButtonElement>(null);
  const notesRef = useRef<HTMLButtonElement>(null);
  const [noteDraft, setNoteDraft] = useState<{ store?: NoteStore; place: NotePassage } | null>(
    null,
  );
  const capturingNote = useRef(false);
  const notes = useNotes(noteStore);
  const noteContext = useMemo(
    () => ({ store: noteStore, factory: rendererFactory, active: true }),
    [noteStore, rendererFactory],
  );
  const noteContextRef = useRef(noteContext);
  noteContextRef.current = noteContext;
  useEffect(() => {
    noteContext.active = true;
    return () => {
      noteContext.active = false;
    };
  }, [noteContext]);
  const [feedback, setFeedback] = useState("");
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [escapeWarning, setEscapeWarning] = useState(false);
  const escapeDeadline = useRef(0);
  const escapeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearEscape = useCallback(() => {
    escapeDeadline.current = 0;
    clearTimeout(escapeTimer.current);
    setEscapeWarning(false);
  }, []);
  const showFeedback = useCallback((message: string) => {
    clearTimeout(feedbackTimer.current);
    setFeedback(message);
    feedbackTimer.current = setTimeout(() => setFeedback(""), 2600);
  }, []);
  const [imageViewer, setImageViewer] = useState<{
    factory?: ReaderRendererFactory;
    session: ImageViewerSession;
  } | null>(null);
  const imageOpen = useRef(false);
  const bookImageRequest = useRef<AbortController | null>(null);
  const bookImageClick = useRef<(element: Element) => void>(() => {});
  // The book's own right-click menu: selected text or an image.
  const [bookMenu, setBookMenu] = useState<
    | { x: number; y: number; kind: "text"; text: string }
    | { x: number; y: number; kind: "image"; element: Element }
    | { x: number; y: number; kind: "note"; id: string }
    | null
  >(null);
  const [focusNote, setFocusNote] = useState<{ id: string } | undefined>();
  const bookContextMenu = useRef<(event: MouseEvent, document: Document) => void>(() => {});
  const bookNoteMenu = useRef<(event: MouseEvent, document: Document, id: string) => void>(
    () => {},
  );
  imageOpen.current =
    imageViewer !== null &&
    imageViewer.factory === rendererFactory &&
    !imageViewer.session.signal.aborted;
  const bookmarks = useBookmarks(bookmarkStore);
  const viewportRef = useRef<HTMLElement>(null);
  const pointerOverSidebar = useRef(false);
  const readingAreaRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const appearance = useAppearance();
  const managedFonts = useReaderFonts().fonts;
  // The default Yu Mincho, or the Noto Serif JP that stands in for it on a computer without it.
  const asianFont = useAsianFontFallback(appearance.readerAsianFont);
  const systemFaces = useSystemFontFaces([appearance.readerWesternFont, asianFont]);
  const westernWeight = resolveFontWeight(
    appearance.readerWesternFontWeight,
    availableFontWeights(appearance.readerWesternFont, managedFonts),
  );
  const asianWeight = resolveFontWeight(
    appearance.readerAsianFontWeight,
    availableFontWeights(asianFont, managedFonts),
  );
  const downloadedFonts = managedFonts
    .filter(
      (f) =>
        f.available &&
        [asianFont, appearance.readerWesternFont].some(
          (choice) => choice.source === "google" && choice.id === (f.familyId ?? f.id),
        ),
    )
    .map((f) => f.id);
  const selectedUploadedFamilies = managedFonts
    .filter(
      (f) =>
        f.source === "uploaded" &&
        [asianFont, appearance.readerWesternFont].some(
          (c) => c.source === "uploaded" && c.id === f.id,
        ),
    )
    .map((f) => f.family);
  const uploadedFonts = managedFonts
    .filter(
      (f) => f.source === "uploaded" && f.available && selectedUploadedFamilies.includes(f.family),
    )
    .map((f) => ({ id: f.id, family: f.family, weight: f.weight!, style: f.style! }));
  const { readerPopupWidth, readerPopupHeight, readerPopupChildLevels } = appearance;
  const triggerKey = JSON.stringify(normalizeLookupTriggers(appearance));
  const triggers = useMemo(() => JSON.parse(triggerKey) as LookupTriggerPreferences, [triggerKey]);
  const triggersRef = useRef(triggers);
  triggersRef.current = triggers;
  // Keep the renderer's selection callback stable when lookup is switched off or on.
  // Selected text or a Shift scan, anchored beside it; each report starts a new lookup.
  // Child popups (lookups from inside a popup) follow the root lookup, deepest last.
  const [lookups, setLookups] = useState<Lookup[]>([]);
  // Read once for the book's popups rather than once per lookup.
  const definitionSources = useDefinitionSources();
  const lookup = lookups[0] ?? null;
  const lookupOpen = useRef(false);
  lookupOpen.current = lookup !== null;
  const lookupIds = useRef(0);
  const popupRef = useRef<HTMLElement>(null);
  const insidePopup = (target: EventTarget | null) =>
    !!(target as Element | null)?.closest?.(".reader-lookup");
  // In VN, finishes the text reveal in progress, or reads on once all text shows (true
  // when it did either); undefined outside VN.
  const vnStep = useRef<((advance: boolean) => boolean) | undefined>(undefined);
  const highlightPointerMatchRef = useRef<(scanId: number | null, length?: number) => void>(
    () => {},
  );
  const closeLookup = useCallback(() => {
    // Keys go back to the book when a popup held focus.
    if ((document.activeElement as Element | null)?.closest?.(".reader-lookup"))
      viewportRef.current?.focus({ preventScroll: true });
    lookupIds.current++;
    highlightPointerMatchRef.current(null);
    setLookups([]);
  }, []);
  // Escape closes the deepest popup first.
  const closeDeepestLookup = useCallback(() => {
    setLookups((current) => {
      if (current.length <= 1) return current;
      return current.slice(0, -1);
    });
  }, []);
  const openChildLookup = useCallback(
    (depth: number, request: ChildLookupRequest) => {
      const area = viewportRef.current?.getBoundingClientRect();
      const origin = readingAreaRef.current?.getBoundingClientRect();
      if (!area || !origin || depth >= readerPopupChildLevels) return;
      const shown = placeLookupPopup(request.rect, area, "horizontal", {
        width: readerPopupWidth,
        height: readerPopupHeight,
      });
      const id = ++lookupIds.current;
      setLookups((current) => {
        if (!current[depth]) return current;
        return [
          ...current.slice(0, depth + 1),
          {
            id,
            query: request.query,
            sentence: current[0].sentence,
            trigger: current[0].trigger,
            placement: {
              left: shown.left - origin.left,
              top: shown.top - origin.top,
              width: shown.right - shown.left,
              height: shown.bottom - shown.top,
            },
          },
        ];
      });
    },
    [readerPopupWidth, readerPopupHeight, readerPopupChildLevels],
  );
  const onSelectionChanged = useCallback(
    (selection: ReaderSelection | null) => {
      if (imageOpen.current || document.querySelector("dialog[open]")) return;
      const query = selection ? lookupQuery(selection.text) : "";
      const area = viewportRef.current?.getBoundingClientRect();
      const origin = readingAreaRef.current?.getBoundingClientRect();
      if (!triggersRef.current.readerPopupEnabled || !selection || !query || !area || !origin) {
        closeLookup();
        return;
      }
      // Shift scans and keyboard selections retain their own triggers.
      const trigger = selection.origin ?? (selection.scanId === undefined ? "keyboard" : "shift");
      if (
        !triggerEnabled(triggersRef.current, trigger) ||
        !lookupTextAllowed(triggersRef.current, query)
      )
        return;
      const shown = placeLookupPopup(selection.rect, area, selection.writingMode, {
        width: readerPopupWidth,
        height: readerPopupHeight,
      });
      // Browser selections keep their own highlighting. A new pointer scan has already
      // cleared the old paint inside the adapter while retaining its new detached ranges.
      if (selection.scanId === undefined) highlightPointerMatchRef.current(null);
      const id = ++lookupIds.current;
      setLookups([
        {
          id,
          query,
          sentence: selection.sentence,
          trigger,
          onMatch: (length) => {
            if (
              triggerEnabled(triggersRef.current, trigger) &&
              lookupIds.current === id &&
              selection.scanId !== undefined
            )
              highlightPointerMatchRef.current(selection.scanId, length);
          },
          placement: {
            left: shown.left - origin.left,
            top: shown.top - origin.top,
            width: shown.right - shown.left,
            height: shown.bottom - shown.top,
          },
        },
      ]);
    },
    [closeLookup, readerPopupWidth, readerPopupHeight],
  );
  const {
    readerWheelStep,
    setReaderWheelStep,
    readerFontSize,
    setReaderFontSize,
    readerLineHeight,
    setReaderLineHeight,
    readerLetterSpacing,
    setReaderLetterSpacing,
    readerWordSpacing,
    setReaderWordSpacing,
    readerWesternFont,
    readerFontFamilyGroup1,
    readerFontFamilyGroup2,
    readerParagraphIndent,
    setReaderParagraphIndent,
    readerParagraphMargin,
    setReaderParagraphMargin,
    readerMaxWidth,
    setReaderMaxWidth,
    readerMaxHeight,
    setReaderMaxHeight,
    readerWritingMode,
    setReaderWritingMode,
    readerTextOrientation,
    setReaderTextOrientation,
    readerTextJustification,
    setReaderTextJustification,
    readerPrettyTextWrap,
    setReaderPrettyTextWrap,
    readerHideFurigana,
    setReaderHideFurigana,
    readerFuriganaStyle,
    setReaderFuriganaStyle,
    readerBlurImage,
    readerBlurMode,
    setReaderBlurMode,
    setReaderBlurImage,
    readerPageLayout,
    setReaderPageLayout,
    readerViewMode,
    setReaderViewMode,
    readerVnParagraphs,
    readerVnTextSpeed,
    readerSidebarPinned: savedSidebarPinned,
    setReaderSidebarPinned,
    readerTheme,
    setReaderTheme,
    readerCustomThemes,
    createReaderCustomTheme,
    updateReaderCustomTheme,
    deleteReaderCustomTheme,
  } = useAppearance();
  // Too narrow to read beside it, a saved pinned sidebar floats and hides like an unpinned one.
  const sidebarPinned = savedSidebarPinned && roomBesideBook;
  const colors = resolveReaderTheme(readerTheme, readerCustomThemes);
  const inputRef = useRef<{
    key: (event: KeyboardEvent, content: boolean) => void;
    wheel: (event: WheelEvent, content: boolean) => void;
    turnQueued: () => boolean;
  }>({ key: () => {}, wheel: () => {}, turnQueued: () => false });
  const contentCleanups = useRef(new Map<Document, () => void>());
  // `P` starts, pauses and resumes the reading session.
  const sessionToggle = useRef(() => {});
  // Paginated wheel steps turn one page each, queued behind the turn in progress.
  const wheelQueue = useRef(new WheelNavigationQueue(appearance.readerChapterWheelThreshold));
  const wheelTurning = useRef(false);
  const crossingChapter = useRef(false);
  const wheelEpoch = useRef(0);
  const autoscroll = useRef<AutoscrollController | null>(null);
  const stopWheelTurns = () => {
    wheelQueue.current.reset();
    autoscroll.current?.stop();
  };
  const onContentDocument = useCallback(
    (document: Document) => {
      if (contentCleanups.current.has(document)) return;
      // Every displayed section brings a new iframe document. Drop the ones EPUB.js has
      // already discarded so a long reading session does not keep old sections alive.
      for (const [previous, cleanup] of contentCleanups.current) {
        if (previous.defaultView) continue;
        cleanup();
        contentCleanups.current.delete(previous);
      }
      const key = (event: KeyboardEvent) => inputRef.current.key(event, true);
      const wheel = (event: WheelEvent) => inputRef.current.wheel(event, true);
      // A click in the book is a click outside the lookup popup.
      let closingLookup = false;
      const pointer = () => {
        clearEscape();
        closingLookup = lookupOpen.current;
        if (lookupOpen.current && triggersRef.current.readerPopupCloseBehavior !== "persistent")
          closeLookup();
      };
      // A plain click on a saved passage offers to open it in Notes or delete it.
      const noteClick = (event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          document.getSelection()?.isCollapsed === false ||
          (event.target as Element | null)?.closest?.("a[href]")
        )
          return;
        const id = noteAtPoint(document, event.clientX, event.clientY);
        if (!id) return;
        event.preventDefault();
        event.stopPropagation();
        bookNoteMenu.current(event, document, id);
      };
      const imageClick = (event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        const target = event.target as Element | null;
        let image = target?.closest?.("svg") ?? target?.closest?.("img");
        while (image?.parentElement?.closest("svg")) image = image.parentElement.closest("svg");
        if (!image || image.hasAttribute("data-komori-image-action")) return;
        event.preventDefault();
        event.stopPropagation();
        bookImageClick.current(image);
      };
      // A plain click in a VN book shows all of the group's text, or reads on once all of
      // it shows, as Space does. A click that closes a lookup, looks a word up (Mouse click
      // with a left or double click) or follows a link only finishes the reveal.
      const vnClick = (event: MouseEvent) => {
        const step = vnStep.current;
        if (!step || event.defaultPrevented || event.button !== 0) return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (document.getSelection()?.isCollapsed === false) return;
        const link = !!(event.target as Element | null)?.closest?.("a[href]");
        step(
          !closingLookup &&
            !lookupOpen.current &&
            !link &&
            !(
              triggersRef.current.readerPopupClickLookup &&
              ["left", "double"].includes(triggersRef.current.readerPopupMouseTrigger)
            ),
        );
      };
      document.addEventListener("keydown", key);
      document.addEventListener("wheel", wheel, { passive: false });
      document.addEventListener("pointerdown", pointer);
      const contextMenu = (event: MouseEvent) => bookContextMenu.current(event, document);
      document.addEventListener("click", noteClick);
      const unhover = noteHoverCursor(document);
      document.addEventListener("click", imageClick);
      document.addEventListener("click", vnClick);
      document.addEventListener("contextmenu", contextMenu);
      const blur = () => clearEscape();
      document.defaultView?.addEventListener("blur", blur);
      // The book's tooltips, menus and browser keys are Komori's too.
      const unguard = guardDocument(document);
      autoscroll.current?.addDocument(document);
      contentCleanups.current.set(document, () => {
        autoscroll.current?.removeDocument(document);
        document.defaultView?.removeEventListener("blur", blur);
        unguard();
        document.removeEventListener("keydown", key);
        document.removeEventListener("wheel", wheel);
        document.removeEventListener("pointerdown", pointer);
        document.removeEventListener("click", noteClick);
        unhover();
        document.removeEventListener("click", imageClick);
        document.removeEventListener("click", vnClick);
        document.removeEventListener("contextmenu", contextMenu);
      });
    },
    [closeLookup, clearEscape],
  );
  const {
    hostRef,
    status,
    pageTurns,
    turning,
    reflowing,
    turnPage,
    scrollBy,
    scrollWithin,
    scrolledNatively,
    scrollTrack,
    contents,
    currentEntryId,
    navigationError,
    goToContentsEntry,
    captureBookmark,
    captureNote,
    goToBookmark,
    searchBook,
    goToSearchResult,
    listImages,
    imageAt,
    imageBlurBoundary,
    loadImage,
    releaseImage,
    goToImage,
    progress,
    progressJumped,
    revealVnText,
    measureReadingHeight,
    highlightPointerMatch,
    setNoteHighlights,
  } = useReaderRenderer(
    rendererFactory,
    onContentDocument,
    positionStore,
    readerFontSize,
    readerLineHeight,
    westernWeight,
    readerParagraphIndent,
    undefined,
    readerWritingMode,
    readerViewMode === "paginated" ? undefined : readerViewMode,
    readerMaxHeight,
    readerTextOrientation,
    readerParagraphMargin,
    readerHideFurigana,
    readerBlurImage,
    colors.text,
    colors.selection,
    colors.highlight,
    onSelectionChanged,
    triggers,
    readerFontFamilyGroup1,
    readerFontFamilyGroup2,
    readerBlurMode,
    readerTextJustification,
    readerPrettyTextWrap,
    readerLetterSpacing,
    readerWordSpacing,
    readerMaxWidth,
    readerPageLayout,
    {
      asian: asianFont,
      western: readerWesternFont,
      weights: { western: westernWeight, asian: asianWeight },
      ...(systemFaces.length ? { systemFaces } : {}),
      downloaded: downloadedFonts,
      ...(uploadedFonts.length ? { uploaded: uploadedFonts } : {}),
    },
    readerVnParagraphs,
    readerVnTextSpeed,
    readerFuriganaStyle,
  );
  highlightPointerMatchRef.current = highlightPointerMatch;

  // Where reading was before a far jump from the contents, the images or the last bookmark,
  // offered back above the progress pill until dismissed.
  const [returnPoint, setReturnPoint] = useState<ReturnPoint | null>(null);
  const returnCandidate = useRef<(ReturnPoint & { settled: boolean }) | null>(null);
  const progressRef = useRef(progress);
  progressRef.current = progress;
  useEffect(() => {
    setReturnPoint(null);
    returnCandidate.current = null;
  }, [rendererFactory]);
  useEffect(() => {
    const candidate = returnCandidate.current;
    if (!candidate?.settled || turning) return;
    returnCandidate.current = null;
    if (progress && isFarJump(candidate.current, progress.current, progress.total))
      setReturnPoint({
        locator: candidate.locator,
        current: candidate.current,
        total: candidate.total,
      });
  }, [progress, turning]);
  /** Runs a jump, remembering the place it leaves; `jump` reports whether it started. */
  async function jumpRemembering(
    jump: (settled: (succeeded: boolean) => void) => boolean,
    settled: (succeeded: boolean) => void = () => {},
  ): Promise<boolean> {
    const from = progressRef.current;
    const place = from?.total ? await captureBookmark() : null;
    const candidate =
      place && from
        ? { locator: place.locator, current: from.current, total: from.total, settled: false }
        : null;
    returnCandidate.current = candidate;
    return jump((succeeded) => {
      if (candidate && returnCandidate.current === candidate) {
        if (succeeded) candidate.settled = true;
        else returnCandidate.current = null;
      }
      settled(succeeded);
    });
  }
  function goToLastBookmark() {
    if (status !== "ready" || turning || bookmarks.status !== "ready") return;
    const last = bookmarks.items.at(-1);
    if (!last) {
      showFeedback(i18n().t("reader.noBookmarkYet"));
      return;
    }
    stopWheelTurns();
    closeLookup();
    void jumpRemembering((settled) => goToBookmark(last.locator, settled));
  }

  vnStep.current =
    readerViewMode === "vn" && pageTurns.scrollAxis
      ? (advance) => {
          if (pageTurns.vnRevealing) {
            revealVnText();
            return true;
          }
          if (!advance || !turnPage("advance")) return false;
          retreatSidebar();
          return true;
        }
      : undefined;
  bookImageClick.current = (element) => {
    if (imageOpen.current || status !== "ready" || turning || reflowing) return;
    bookImageRequest.current?.abort();
    const controller = new AbortController();
    bookImageRequest.current = controller;
    stopWheelTurns();
    closeLookup();
    void imageAt(element, controller.signal).then(
      (selection) => {
        if (controller.signal.aborted) return;
        if (selection)
          setImageViewer({
            factory: rendererFactory,
            session: { ...selection, signal: controller.signal },
          });
        else showFeedback(i18n().t("reader.imageUnavailable"));
      },
      () => {
        if (!controller.signal.aborted) showFeedback(i18n().t("reader.imageFailed"));
      },
    );
  };
  bookContextMenu.current = (event, contentDocument) => {
    if (
      event.defaultPrevented ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      status !== "ready" ||
      imageOpen.current
    )
      return;
    const frame = contentDocument.defaultView?.frameElement?.getBoundingClientRect();
    const x = event.clientX + (frame?.left ?? 0);
    const y = event.clientY + (frame?.top ?? 0);
    const target = event.target as Element | null;
    let image = target?.closest?.("svg") ?? target?.closest?.("img");
    while (image?.parentElement?.closest("svg")) image = image.parentElement.closest("svg");
    const text = contentDocument.getSelection()?.toString() ?? "";
    const note = text.trim() ? null : noteAtPoint(contentDocument, event.clientX, event.clientY);
    if (text.trim()) {
      event.preventDefault();
      setBookMenu({ x, y, kind: "text", text });
    } else if (note) {
      event.preventDefault();
      setBookMenu({ x, y, kind: "note", id: note });
    } else if (image && !image.hasAttribute("data-komori-image-action")) {
      event.preventDefault();
      setBookMenu({ x, y, kind: "image", element: image });
    }
  };
  bookNoteMenu.current = (event, contentDocument, id) => {
    if (status !== "ready" || imageOpen.current) return;
    const frame = contentDocument.defaultView?.frameElement?.getBoundingClientRect();
    setBookMenu({
      x: event.clientX + (frame?.left ?? 0),
      y: event.clientY + (frame?.top ?? 0),
      kind: "note",
      id,
    });
  };
  useEffect(() => setBookMenu(null), [rendererFactory, status]);
  /** The image a book element shows, as the viewer would show it. */
  async function bookImage(element: Element) {
    const controller = new AbortController();
    const selection = await imageAt(element, controller.signal);
    const item = selection?.items[selection.index];
    if (!item) throw Error("Image unavailable");
    const resource = await loadImage(item.id, "viewer", controller.signal);
    try {
      return { blob: await imageBlob(resource), number: selection.index + 1 };
    } finally {
      releaseImage(resource.url);
    }
  }
  const bookTitle = identity.status === "book" ? (identity.book.title ?? "") : "";
  const bookMenuItems = (): ContextMenuItem[] => {
    if (!bookMenu) return [];
    if (bookMenu.kind === "text")
      return [
        {
          label: t("textMenu.copy"),
          icon: <CopyIcon aria-hidden="true" />,
          onSelect: () => copyText(bookMenu.text),
        },
        {
          label: t("textMenu.note"),
          icon: <NotePencilIcon aria-hidden="true" />,
          onSelect: () => void createSelectedNote(),
        },
        {
          label: t("textMenu.highlight"),
          icon: <HighlighterIcon aria-hidden="true" />,
          onSelect: () => void createSelectedNote("highlight"),
        },
      ];
    if (bookMenu.kind === "note") {
      const { id } = bookMenu;
      return [
        {
          label: t("noteMenu.open"),
          icon: <NotePencilIcon aria-hidden="true" />,
          onSelect: () => {
            setSidebarHidden(false);
            setSidebarView("notes");
            setSidebarShown(true);
            setFocusNote({ id });
          },
        },
        {
          label: t("noteMenu.delete"),
          icon: <TrashIcon aria-hidden="true" />,
          onSelect: () =>
            void notes.remove(id).then((removed) => {
              if (removed) showFeedback(i18n().t("notes.removed"));
            }),
        },
      ];
    }
    const { element } = bookMenu;
    return [
      {
        label: t("imageActions.copy"),
        icon: <CopyIcon aria-hidden="true" />,
        onSelect: () =>
          void bookImage(element)
            .then(({ blob }) => copyBookImage(blob))
            .then(
              () => showFeedback(i18n().t("imageActions.copied")),
              () => showFeedback(i18n().t("imageActions.copyFailed")),
            ),
      },
      {
        label: t("imageActions.save"),
        icon: <DownloadSimpleIcon aria-hidden="true" />,
        onSelect: () =>
          void bookImage(element)
            .then(({ blob, number }) => saveBookImage(blob, `${bookTitle} ${number}`.trim()))
            .then(
              (saved) => {
                if (saved === "saved") showFeedback(i18n().t("imageActions.saved"));
                else if (saved === "failed") showFeedback(i18n().t("imageActions.saveFailed"));
              },
              () => showFeedback(i18n().t("imageActions.saveFailed")),
            ),
      },
    ];
  };
  useEffect(() => () => bookImageRequest.current?.abort(), [rendererFactory]);
  useEffect(() => {
    if (status === "ready") setNoteHighlights(notes.items);
  }, [status, notes.items, setNoteHighlights]);
  // Reading keys pressed while focus stays on a control of a sidebar that hid as the
  // pointer left it read on in the book instead, as arrows and Space do there.
  useEffect(() => {
    const redirect = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.(".reader-sidebar--hidden")) return;
      if (event.key !== " " && !event.key.startsWith("Arrow")) return;
      const viewport = viewportRef.current;
      if (!viewport) return;
      event.preventDefault();
      event.stopPropagation();
      viewport.focus({ preventScroll: true });
      viewport.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: event.key,
          code: event.code,
          repeat: event.repeat,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    document.addEventListener("keydown", redirect, true);
    return () => document.removeEventListener("keydown", redirect, true);
  }, []);
  const saveSession = useMemo(
    () =>
      positionStore?.saveSession
        ? (session: ReadingSession) => positionStore.saveSession!(session)
        : undefined,
    [positionStore],
  );
  const recording = useMemo(
    () => ({
      enabled: appearance.statisticsEnabled,
      start: appearance.statisticsSessionStart,
      jumpLimit: appearance.statisticsJumpLimit,
      idleMinutes: appearance.statisticsIdleMinutes,
    }),
    [
      appearance.statisticsEnabled,
      appearance.statisticsSessionStart,
      appearance.statisticsJumpLimit,
      appearance.statisticsIdleMinutes,
    ],
  );
  const openedId = status === "ready" && identity.status === "book" ? identity.book.id : null;
  useEffect(() => {
    if (openedId) void rememberLastBook(openedId);
  }, [openedId]);

  const session = useReadingSession(
    rendererFactory,
    status === "ready",
    progress,
    progressJumped,
    saveSession,
    recording,
  );
  sessionToggle.current = session.toggle;
  const speed = useReadingSpeed(
    status === "ready" &&
      !reflowing &&
      appearance.readerShowReadingSpeed &&
      appearance.statisticsEnabled,
    session.readingSpeed,
  );
  useEffect(() => {
    if (
      !triggers.readerPopupEnabled ||
      (lookup &&
        (!triggerEnabled(triggers, lookup.trigger) || !lookupTextAllowed(triggers, lookup.query)))
    )
      closeLookup();
  }, [triggers, lookup, closeLookup]);
  const monitor = useReaderMonitor();
  const stepping = useRef(false);
  // The largest max height leaves the reading area at the window's height, so the first
  // step down from a height it cannot reach goes to just below the area's height. A typed
  // height applies as typed, and a later change replaces a step down still measuring.
  const maxHeightChanges = useRef(0);
  const changeMaxHeight = (next: number, source: StepperSource) => {
    const steppingDown = source === "button" && next < readerMaxHeight;
    if (steppingDown && stepping.current) return;
    const change = ++maxHeightChanges.current;
    if (!steppingDown) {
      setReaderMaxHeight(next);
      return;
    }
    stepping.current = true;
    void measureReadingHeight()
      .then((height) => {
        if (change !== maxHeightChanges.current) return;
        const below =
          height === null
            ? next
            : (Math.ceil(height / maxHeightRange.step) - 1) * maxHeightRange.step;
        setReaderMaxHeight(Math.min(next, below));
      })
      .finally(() => {
        stepping.current = false;
      });
  };
  // A floating sidebar gets out of the way once the reader is reading, unless the pointer
  // or keyboard focus is still in it.
  const retreatSidebar = () => {
    if (sidebarPinned || pointerOverSidebar.current) return;
    if (document.getElementById("reader-sidebar")?.contains(document.activeElement)) return;
    setSidebarShown(false);
  };
  const openSearch = () => {
    setSidebarView("search");
    setSidebarShown(true);
    requestAnimationFrame(() =>
      document.querySelector<HTMLInputElement>(".reader-search-box input")?.focus(),
    );
  };

  /** A note from the selected passage, or a highlight: the passage marked without a note. */
  async function createSelectedNote(kind: "note" | "highlight" = "note") {
    if (capturingNote.current || notes.busy || turning) {
      showFeedback(i18n().t("reader.waitAction"));
      return;
    }
    if (status !== "ready") {
      showFeedback(i18n().t("reader.noteNeedsBook"));
      return;
    }
    if (notes.status !== "ready") {
      setSidebarHidden(false);
      setSidebarShown(true);
      setSidebarView("notes");
      return;
    }
    capturingNote.current = true;
    const store = noteStore;
    const context = noteContext;
    try {
      const place = await captureNote();
      if (context !== noteContextRef.current || !context.active) return;
      if (!place) {
        showFeedback(i18n().t("reader.noteSelection"));
        return;
      }
      closeLookup();
      if (kind === "note") setNoteDraft({ store, place });
      else if (await notes.create(place, "")) showFeedback(i18n().t("notes.highlighted"));
    } finally {
      capturingNote.current = false;
    }
  }

  useEffect(() => {
    const clear = () => clearEscape();
    const otherKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !matchesModifiers(event, "none")) clearEscape();
    };
    window.addEventListener("blur", clear);
    document.addEventListener("pointerdown", clear, true);
    document.addEventListener("wheel", clear, { capture: true, passive: true });
    document.addEventListener("keydown", otherKey, true);
    document.addEventListener("focusin", clear);
    return () => {
      window.removeEventListener("blur", clear);
      document.removeEventListener("pointerdown", clear, true);
      document.removeEventListener("wheel", clear, true);
      document.removeEventListener("keydown", otherKey, true);
      document.removeEventListener("focusin", clear);
      clearTimeout(escapeTimer.current);
      clearTimeout(feedbackTimer.current);
    };
  }, [clearEscape]);
  useEffect(() => {
    clearEscape();
    setNoteDraft(null);
    setFeedback("");
  }, [rendererFactory, noteStore, clearEscape]);

  inputRef.current = {
    key: (event, content) => {
      if (event.key !== "Escape" || !matchesModifiers(event, "none")) clearEscape();
      if (
        imageOpen.current ||
        document.querySelector("dialog[open]") ||
        (event.target as Element | null)?.closest?.("dialog")
      ) {
        clearEscape();
        return;
      }
      if (popupShortcut(event)) return;
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape" && matchesModifiers(event, "none")) {
        if (event.repeat) return;
        if (lookupOpen.current) {
          clearEscape();
          if (triggersRef.current.readerPopupCloseBehavior !== "escape-outside") return;
          event.preventDefault();
          if (lookups.length > 1) closeDeepestLookup();
          else closeLookup();
          return;
        }
        if (!sidebarPinned && sidebarShown && !sidebarHidden) {
          event.preventDefault();
          clearEscape();
          setSidebarShown(false);
          viewportRef.current?.focus({ preventScroll: true });
          return;
        }
        if (!commandTarget(event.target, true)) return;
        event.preventDefault();
        if (Date.now() < escapeDeadline.current) {
          clearEscape();
          navigate(libraryCache.lastPage(), { state: libraryReturn });
        } else {
          escapeDeadline.current = Date.now() + escapeReturnWindow;
          setEscapeWarning(true);
          clearTimeout(escapeTimer.current);
          escapeTimer.current = setTimeout(clearEscape, escapeReturnWindow);
        }
        return;
      }
      const command = shortcutCommand(event, "Reader");
      if (command && commandTarget(event.target, true)) {
        switch (command) {
          case "session":
            sessionToggle.current();
            break;
          case "find":
            setSidebarHidden(false);
            openSearch();
            break;
          case "bookmarks":
            setSidebarHidden(false);
            setSidebarView("bookmarks");
            setSidebarShown(true);
            break;
          case "images":
            setSidebarHidden(false);
            setSidebarView("images");
            setSidebarShown(true);
            break;
          case "appearance":
            // A second press on a shown Appearance returns to the reader controls.
            if (sidebarView === "appearance" && !sidebarHidden && (sidebarPinned || sidebarShown)) {
              setSidebarView("main");
              break;
            }
            setSidebarHidden(false);
            setSidebarView("appearance");
            setSidebarShown(true);
            break;
          case "sidebar": {
            const hide = !sidebarHidden && (sidebarPinned || sidebarShown);
            // Hiding leaves Appearance, so the sidebar reopens on the reader controls.
            if (hide && sidebarView === "appearance") setSidebarView("main");
            setSidebarHidden(hide);
            setSidebarShown(true);
            break;
          }
          case "bookmark":
            if (status !== "ready" || turning || bookmarks.status !== "ready" || bookmarks.busy)
              return;
            void bookmarks.create(captureBookmark, "", showFeedback);
            break;
          case "note":
            void createSelectedNote();
            break;
          case "last-bookmark":
            goToLastBookmark();
            break;
        }
        event.preventDefault();
        return;
      }
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const target = event.target;
      const bodyFocus =
        !content && (target === document.body || target === document.documentElement);
      // Space shows all of a VN group's text at once, or reads on once all of it shows.
      if (event.key === " " && vnStep.current) {
        if (!revealsVnText(target)) return;
        event.preventDefault();
        vnStep.current(!event.repeat);
        return;
      }
      const forwardArrow = pageTurns.forwardArrow ?? "ArrowRight";
      const scrollAxis = pageTurns.scrollAxis;
      // A continuous book scrolls while an arrow is held; a page turns once per press.
      if (!scrollAxis && event.repeat) return;
      const direction = scrollAxis
        ? scrollArrow(event.key, forwardArrow)
        : arrowTurn(event.key, forwardArrow);
      if (!direction) return;
      if (!bodyFocus && !acceptsReaderInput(target, content)) return;
      if (scrollAxis) {
        const viewport = viewportRef.current;
        const extent =
          (scrollAxis === "horizontal" ? viewport?.clientWidth : viewport?.clientHeight) ?? 0;
        const distance = arrowScrollDistance(extent);
        if (!scrollBy(direction === "advance" ? distance : -distance)) return;
        closeLookup();
      } else {
        stopWheelTurns();
        if (!turnPage(direction)) return;
      }
      event.preventDefault();
      retreatSidebar();
    },
    wheel: (event, content) => {
      clearEscape();
      if (imageOpen.current || document.querySelector("dialog[open]")) return;
      if (popupShortcut(event)) return;
      if (event.defaultPrevented || event.ctrlKey) return;
      if (!acceptsReaderInput(event.target, content)) return;
      // The browser scrolls a sideways or Shift wheel itself, which reads on across the
      // lines of a vertical book.
      if (
        event.altKey ||
        event.metaKey ||
        event.shiftKey ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ) {
        if (pageTurns.scrollAxis) scrolledNatively();
        return;
      }
      const steps = wheelSteps(event.deltaY, event.deltaMode);
      // A continuous book scrolls the chosen distance for each wheel step, and finer
      // movement in proportion, down reading on in either axis.
      if (pageTurns.scrollAxis) {
        const distance = (wholeWheelSteps(steps) ?? steps) * readerWheelStep;
        // A chapter shown alone turns to its neighbour only after the saved number of wheel
        // steps at its edge, as paginated pages do.
        if (readerViewMode === "semi-continuous") {
          const scrolled = crossingChapter.current ? "edge" : scrollWithin(distance);
          if (scrolled === "unavailable") return;
          event.preventDefault();
          if (scrolled === "scrolled") {
            wheelQueue.current.reset();
            closeLookup();
            retreatSidebar();
            return;
          }
          if (crossingChapter.current) return;
          wheelQueue.current.add(steps, true, turning || wheelTurning.current);
          const direction = wheelQueue.current.take(true);
          if (!direction) return;
          crossingChapter.current = true;
          const epoch = wheelEpoch.current;
          const started = turnPage(direction > 0 ? "advance" : "retreat", () => {
            if (epoch === wheelEpoch.current) crossingChapter.current = false;
          });
          if (!started) {
            crossingChapter.current = false;
            wheelQueue.current.reset();
            return;
          }
          closeLookup();
          retreatSidebar();
          return;
        }
        if (!scrollBy(distance)) return;
        closeLookup();
        event.preventDefault();
        retreatSidebar();
        return;
      }
      if (status !== "ready" || reflowing) return;
      event.preventDefault();
      if (crossingChapter.current) return;
      wheelQueue.current.add(
        steps,
        steps > 0 ? !!pageTurns.advanceChapter : !!pageTurns.retreatChapter,
        turning || wheelTurning.current,
      );
      if (inputRef.current.turnQueued()) retreatSidebar();
    },
    /** Turn the next queued wheel page, unless a wheel turn is still in progress. */
    turnQueued: () => {
      if (imageOpen.current) return false;
      const queued = wheelQueue.current.pendingDirection;
      if (!queued) return false;
      if (wheelTurning.current) return true;
      const boundary = queued > 0 ? !!pageTurns.advanceChapter : !!pageTurns.retreatChapter;
      const direction = wheelQueue.current.take(boundary);
      if (!direction) return false;
      wheelTurning.current = true;
      crossingChapter.current = boundary;
      const epoch = wheelEpoch.current;
      const started = turnPage(direction > 0 ? "advance" : "retreat", () => {
        if (epoch !== wheelEpoch.current) return;
        wheelTurning.current = false;
        crossingChapter.current = false;
      });
      if (!started) {
        wheelTurning.current = false;
        crossingChapter.current = false;
        wheelQueue.current.reset();
        return false;
      }
      return true;
    },
  };

  useEffect(() => {
    const key = (event: KeyboardEvent) => inputRef.current.key(event, false);
    const wheel = (event: WheelEvent) => inputRef.current.wheel(event, false);
    document.addEventListener("keydown", key);
    document.addEventListener("wheel", wheel, { passive: false });
    const cleanups = contentCleanups.current;
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("wheel", wheel);
      for (const cleanup of cleanups.values()) cleanup();
      cleanups.clear();
      stopWheelTurns();
      wheelEpoch.current++;
      wheelTurning.current = false;
      crossingChapter.current = false;
    };
  }, [rendererFactory]);

  useEffect(() => {
    wheelQueue.current = new WheelNavigationQueue(appearance.readerChapterWheelThreshold);
    autoscroll.current?.stop();
  }, [
    appearance.readerChapterWheelThreshold,
    readerViewMode,
    readerWritingMode,
    readerPageLayout,
    reflowing,
  ]);

  // Current callbacks keep the controller independent of React renders and EPUB iframe lifetimes.
  const autoInput = useRef({ pageTurns, scrollBy, ready: false, move: (_distance: number) => {} });
  autoInput.current = {
    pageTurns,
    scrollBy,
    ready: status === "ready" && !reflowing && !imageOpen.current,
    move: (distance) => {
      if (pageTurns.scrollAxis) {
        if (turning) return;
        if (!scrollBy(distance)) autoscroll.current?.stop();
      } else if (!crossingChapter.current) {
        wheelQueue.current.add(
          distance / 100,
          distance > 0 ? !!pageTurns.advanceChapter : !!pageTurns.retreatChapter,
          turning || wheelTurning.current,
        );
        inputRef.current.turnQueued();
      }
    },
  };
  useEffect(() => {
    if (!appearance.middleClickAutoscroll || status !== "ready") return;
    const controller = new AutoscrollController(
      document,
      (event, doc) => {
        if (
          !autoInput.current.ready ||
          document.querySelector("dialog[open], .reader-lookup") ||
          !acceptsReaderInput(event.target, doc !== document)
        )
          return null;
        stopWheelTurns();
        const horizontal = autoInput.current.pageTurns.scrollAxis === "horizontal";
        return {
          axes: horizontal ? "horizontal" : "vertical",
          move: (x, y) => {
            if (!autoInput.current.ready) {
              controller.stop();
              return;
            }
            const direction = autoInput.current.pageTurns.forwardArrow === "ArrowLeft" ? -1 : 1;
            autoInput.current.move(horizontal ? x * direction : y);
          },
        };
      },
      () => wheelQueue.current.reset(),
    );
    autoscroll.current = controller;
    controller.addDocument(document);
    for (const doc of contentCleanups.current.keys()) controller.addDocument(doc);
    return () => {
      controller.dispose();
      autoscroll.current = null;
    };
  }, [
    appearance.middleClickAutoscroll,
    status,
    rendererFactory,
    readerViewMode,
    readerWritingMode,
  ]);

  // Once a turn finishes, the next wheel step waiting for it turns.
  useEffect(() => {
    if (!turning) inputRef.current.turnQueued();
  }, [turning]);

  // A page turn, contents jump, or reflow moves the text the lookup popup is beside, and
  // another book has none of it.
  useEffect(() => {
    if (turning) closeLookup();
  }, [turning, closeLookup]);
  useEffect(() => closeLookup, [rendererFactory, closeLookup]);
  useEffect(() => {
    setImageViewer(null);
  }, [rendererFactory]);
  useEffect(() => {
    if (!imageViewer) return;
    const close = () => setImageViewer(null);
    imageViewer.session.signal.addEventListener("abort", close, { once: true });
    return () => imageViewer.session.signal.removeEventListener("abort", close);
  }, [imageViewer]);

  // A click anywhere outside the lookup popup closes it.
  useEffect(() => {
    if (!lookup) return;
    const outside = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest?.("dialog")) return;
      if (
        triggersRef.current.readerPopupCloseBehavior !== "persistent" &&
        !insidePopup(event.target)
      )
        closeLookup();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [lookup, closeLookup]);

  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia(narrowQuery);
    const follow = () => setRoomBesideBook(!media.matches);
    follow();
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, []);

  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia("(max-width: 820px)");
    const closeOnCompact = (event: MediaQueryListEvent) => {
      if (event.matches) setSidebarShown(false);
    };
    media.addEventListener("change", closeOnCompact);
    return () => media.removeEventListener("change", closeOnCompact);
  }, []);

  return (
    <div
      className={`reader-shell reader-shell--${sidebarPinned && !sidebarHidden ? "pinned" : "floating"}`}
      style={{ "--reader-page": colors.background } as CSSProperties}
    >
      <ReaderBackgroundSurface />
      <a className="skip-link" href="#reader-main">
        {t("reader.skip")}
      </a>
      <h1 className="visually-hidden">{t("reader.title")}</h1>
      {/* The window has no system frame: the top edge drags it. */}
      <div aria-hidden="true" className="reader-drag-strip" data-tauri-drag-region />
      {(!sidebarPinned || sidebarHidden) && (
        // A hover strip along the window's left edge brings the sidebar back;
        // a tap does too. Keyboard focus reaches the sidebar itself.
        <div
          className="reader-sidebar-hotspot"
          aria-hidden="true"
          onPointerEnter={() => {
            setSidebarHidden(false);
            setSidebarShown(true);
          }}
          onClick={() => {
            setSidebarHidden(false);
            setSidebarShown(true);
          }}
        />
      )}
      {/* Before the book, so Shift+Tab from the book reaches the contents. */}
      <ReaderSidebar
        identity={identity}
        pinned={sidebarPinned}
        shown={!sidebarHidden && (sidebarPinned || sidebarShown)}
        status={status}
        progress={status === "ready" ? progress : null}
        contents={contents}
        currentEntryId={currentEntryId}
        navigationBusy={turning}
        navigationError={navigationError}
        onSelectEntry={(id) => {
          stopWheelTurns();
          const origin = document.activeElement;
          void jumpRemembering(
            (settled) => goToContentsEntry(id, settled),
            (succeeded) => {
              // Hand page-turn keys to the book after a jump, unless the reader has
              // already moved focus elsewhere. A failed jump leaves focus on the entry.
              const focused = document.activeElement;
              if (!succeeded || (focused !== origin && focused !== document.body)) return;
              if (compactLayout() && !sidebarPinned) setSidebarShown(false);
              viewportRef.current?.focus({ preventScroll: true });
            },
          );
        }}
        view={sidebarView}
        // A second press returns to the reader controls.
        onToggleAppearance={() =>
          setSidebarView((current) => (current === "appearance" ? "main" : "appearance"))
        }
        onCloseAppearance={() => {
          const previous = sidebarView;
          setSidebarView("main");
          if (previous === "bookmarks") requestAnimationFrame(() => bookmarksRef.current?.focus());
          else if (previous === "search") requestAnimationFrame(() => searchRef.current?.focus());
          else if (previous === "images") requestAnimationFrame(() => imagesRef.current?.focus());
          else if (previous === "notes") requestAnimationFrame(() => notesRef.current?.focus());
          else appearanceRef.current?.focus();
        }}
        appearanceRef={appearanceRef}
        searchRef={searchRef}
        onOpenSearch={openSearch}
        imagesRef={imagesRef}
        onOpenImages={() => setSidebarView("images")}
        images={{
          ready: status === "ready",
          session: rendererFactory,
          listImages,
          loadImage,
          releaseImage,
          onOpen: (items, index, signal) => {
            bookImageRequest.current?.abort();
            stopWheelTurns();
            closeLookup();
            setImageViewer({ factory: rendererFactory, session: { items, index, signal } });
          },
        }}
        search={{
          ready: status === "ready",
          navigationBusy: turning,
          session: rendererFactory,
          onSearch: searchBook,
          onExit: () => {
            clearEscape();
            viewportRef.current?.focus({ preventScroll: true });
          },
          onJump: (id, signal, settled) => {
            stopWheelTurns();
            closeLookup();
            const origin = document.activeElement;
            return goToSearchResult(id, signal, (success) => {
              settled(success);
              const focused = document.activeElement;
              if (!success || signal.aborted || (focused !== origin && focused !== document.body))
                return;
              if (compactLayout() && !sidebarPinned) setSidebarShown(false);
              viewportRef.current?.focus({ preventScroll: true });
            });
          },
        }}
        bookmarksRef={bookmarksRef}
        onOpenBookmarks={() => setSidebarView("bookmarks")}
        bookmarks={{
          bookmarks,
          canCreate: status === "ready",
          navigationBusy: turning,
          onCreate: (label) => bookmarks.create(captureBookmark, label),
          onJump: (bookmark, settled) => {
            stopWheelTurns();
            const origin = document.activeElement;
            return goToBookmark(bookmark.locator, (success) => {
              settled(success);
              const focused = document.activeElement;
              if (!success || (focused !== origin && focused !== document.body)) return;
              if (compactLayout() && !sidebarPinned) setSidebarShown(false);
              viewportRef.current?.focus({ preventScroll: true });
            });
          },
        }}
        notesRef={notesRef}
        onOpenNotes={() => setSidebarView("notes")}
        notes={{
          notes,
          ready: status === "ready",
          navigationBusy: turning,
          focus: focusNote,
          onJump: (note, settled) => {
            stopWheelTurns();
            closeLookup();
            const origin = document.activeElement;
            return goToBookmark(note.locator, (success) => {
              settled(success);
              const focused = document.activeElement;
              if (!success || (focused !== origin && focused !== document.body)) return;
              if (compactLayout() && !sidebarPinned) setSidebarShown(false);
              viewportRef.current?.focus({ preventScroll: true });
            });
          },
        }}
        onTogglePin={
          roomBesideBook
            ? () => {
                setReaderSidebarPinned(!sidebarPinned);
                setSidebarShown(true);
              }
            : undefined
        }
        onPointerEnter={() => {
          pointerOverSidebar.current = true;
          setSidebarShown(true);
        }}
        onPointerLeave={() => {
          pointerOverSidebar.current = false;
          if (!sidebarPinned) setSidebarShown(false);
        }}
        onFocus={() => {
          setSidebarHidden(false);
          setSidebarShown(true);
        }}
        onBlur={(event: FocusEvent<HTMLElement>) => {
          // Focus moving on to the book, such as after a contents jump, hides it.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          if (event.relatedTarget && !pointerOverSidebar.current && !sidebarPinned)
            setSidebarShown(false);
        }}
        appearance={{
          footer: appearance,
          onFooterChange: appearance.setReaderFooter,
          fontSize: readerFontSize,
          onFontSizeChange: setReaderFontSize,
          lineHeight: readerLineHeight,
          onLineHeightChange: setReaderLineHeight,
          letterSpacing: readerLetterSpacing,
          onLetterSpacingChange: setReaderLetterSpacing,
          wordSpacing: readerWordSpacing,
          onWordSpacingChange: setReaderWordSpacing,
          paragraphIndent: readerParagraphIndent,
          onParagraphIndentChange: setReaderParagraphIndent,
          paragraphMargin: readerParagraphMargin,
          onParagraphMarginChange: setReaderParagraphMargin,
          maxWidth: readerMaxWidth,
          onMaxWidthChange: setReaderMaxWidth,
          monitor,
          pageLayout: readerPageLayout,
          onPageLayoutChange: setReaderPageLayout,
          maxHeight: readerMaxHeight,
          onMaxHeightChange: changeMaxHeight,
          writingMode: readerWritingMode,
          onWritingModeChange: setReaderWritingMode,
          textOrientation: readerTextOrientation,
          onTextOrientationChange: setReaderTextOrientation,
          textJustification: readerTextJustification,
          onTextJustificationChange: setReaderTextJustification,
          prettyTextWrap: readerPrettyTextWrap,
          onPrettyTextWrapChange: setReaderPrettyTextWrap,
          hideFurigana: readerHideFurigana,
          onHideFuriganaChange: setReaderHideFurigana,
          furiganaStyle: readerFuriganaStyle,
          onFuriganaStyleChange: setReaderFuriganaStyle,
          blurImage: readerBlurImage,
          onBlurImageChange: setReaderBlurImage,
          blurMode: readerBlurMode,
          onBlurModeChange: setReaderBlurMode,
          imageBlurBoundary: status === "ready" ? imageBlurBoundary : undefined,
          vnNotice: pageTurns.vnNotice,
          viewMode: readerViewMode,
          onViewModeChange: setReaderViewMode,
          wheelStep: readerWheelStep,
          onWheelStepChange: setReaderWheelStep,
          theme: readerTheme,
          customThemes: readerCustomThemes,
          onThemeChange: setReaderTheme,
          onCreateCustomTheme: createReaderCustomTheme,
          onCustomThemeChange: updateReaderCustomTheme,
          onDeleteCustomTheme: deleteReaderCustomTheme,
        }}
      />
      <div
        className="reader-reading-area"
        ref={readingAreaRef}
        // The Reader theme colors the book surface; the sidebar keeps the app theme.
        style={
          {
            "--reader-page": colors.background,
            "--reader-ink": colors.text,
            "--reader-footer-text": colors.footerText,
          } as CSSProperties
        }
      >
        {/* In the space kept free above the book's pages, in the Reader theme's colors. */}
        <WindowControls className="reader-window-controls" />
        <ReaderViewport
          hostRef={hostRef}
          viewportRef={viewportRef}
          identity={identity}
          status={status}
          continuous={readerViewMode !== "paginated"}
        />
        {status === "ready" && pageTurns.scrollAxis && (
          <ReaderScrollbar track={scrollTrack} refresh={pageTurns} />
        )}
        {status === "ready" && pageTurns.vnRevealing && (
          <button type="button" className="reader-vn-reveal" onClick={revealVnText}>
            {t("reader.showAllText")}
          </button>
        )}
        {status === "ready" && reflowing && (
          <p className="reader-layout-status" role="status">
            {t("reader.layingOut")}
          </p>
        )}
        <span className="visually-hidden" role="status">
          {t(footerLabel(identity, status))}
        </span>
        {status === "ready" && !reflowing && (
          <ReaderReadingStatus
            clock={appearance.readerShowClock}
            readingTime={appearance.readerShowReadingTime}
            readingMs={session.readingMs}
            session={session.state}
          />
        )}
        {status === "ready" && returnPoint && (
          <ReaderReturnPoint
            point={returnPoint}
            busy={turning || reflowing}
            onReturn={() => {
              const point = returnPoint;
              stopWheelTurns();
              closeLookup();
              goToBookmark(point.locator, (succeeded) => {
                if (succeeded) setReturnPoint((current) => (current === point ? null : current));
                viewportRef.current?.focus({ preventScroll: true });
              });
            }}
            onDismiss={() => {
              setReturnPoint(null);
              viewportRef.current?.focus({ preventScroll: true });
            }}
          />
        )}
        <BookProgress
          progress={status === "ready" ? progress : null}
          visibility={appearance}
          speed={speed}
        />
        <p className="reader-floating-feedback" role="status" aria-live="polite">
          {escapeWarning ? t("reader.escapeAgain") : feedback}
        </p>
        {lookups.map((shown, depth) => (
          <ReaderLookupPopup
            key={shown.id}
            onMatch={shown.onMatch}
            onSearchTerm={(term) => navigate(`/dictionary?q=${encodeURIComponent(term)}`)}
            onChildLookup={
              depth < readerPopupChildLevels
                ? (request) => openChildLookup(depth, request)
                : undefined
            }
            // A press in a parent popup closes the child popups above it.
            onPointerDown={() =>
              setLookups((current) =>
                current.length > depth + 1 ? current.slice(0, depth + 1) : current,
              )
            }
            placement={shown.placement}
            definitionSources={definitionSources}
            query={shown.query}
            readerContext={{
              sentence: lookup?.sentence,
              bookTitle: identity.status === "book" ? (identity.book.title ?? "") : "",
              bookId: identity.status === "book" ? identity.book.id : undefined,
            }}
            ref={depth === 0 ? popupRef : undefined}
          />
        ))}
      </div>
      {noteDraft && noteDraft.store === noteStore && (
        <NoteEditor
          title={t("reader.newNote")}
          passage={noteDraft.place.passage}
          busy={notes.busy}
          error={notes.error}
          onCancel={() => setNoteDraft(null)}
          onSave={(body) => {
            void notes.create(noteDraft.place, body).then((saved) => {
              if (saved) {
                setNoteDraft(null);
                setSidebarHidden(false);
                setSidebarView("notes");
                setSidebarShown(true);
              }
            });
          }}
        />
      )}
      {bookMenu && (
        <ContextMenu
          items={bookMenuItems()}
          label={t(
            bookMenu.kind === "text"
              ? "textMenu.label"
              : bookMenu.kind === "note"
                ? "noteMenu.label"
                : "imageActions.label",
          )}
          onClose={() => setBookMenu(null)}
          position={{ x: bookMenu.x, y: bookMenu.y }}
        />
      )}
      {imageOpen.current && imageViewer && (
        <ReaderImageViewer
          fileName={bookTitle}
          session={imageViewer.session}
          loadImage={loadImage}
          releaseImage={releaseImage}
          navigationBusy={turning}
          onJump={(id, signal, settled) => {
            stopWheelTurns();
            closeLookup();
            void jumpRemembering((done) => goToImage(id, signal, done), settled).then((started) => {
              if (!started) settled(false);
            });
            return true;
          }}
          onClose={(jumped) => {
            setImageViewer(null);
            bookImageRequest.current?.abort();
            if (jumped)
              requestAnimationFrame(() => viewportRef.current?.focus({ preventScroll: true }));
          }}
        />
      )}
    </div>
  );
}

/**
 * Book and chapter positions and percentages, in that order. Empty
 * until the book is counted.
 */
function BookProgress({
  progress,
  visibility,
  speed,
}: {
  progress: ReaderBookProgress | null;
  visibility: ReaderFooterPreferences;
  /** The session's speed when shown and a minute was read. */
  speed: ReadingSpeed | null;
}) {
  if (!progress?.total) return null;
  const chapter = progress.chapter;
  const bookShown = visibility.readerShowReadingPosition || visibility.readerShowPercentage;
  const chapterShown =
    !!chapter?.total &&
    (visibility.readerShowChapterPosition || visibility.readerShowChapterPercentage);
  if (!bookShown && !chapterShown && !speed) return null;
  return (
    <footer className="reader-footer">
      {bookShown && (
        <ProgressValues
          kind="book"
          position={visibility.readerShowReadingPosition}
          percentage={visibility.readerShowPercentage}
          unit={progress.unit}
          current={progress.current}
          total={progress.total}
        />
      )}
      {chapterShown && chapter ? (
        <ProgressValues
          kind="chapter"
          position={visibility.readerShowChapterPosition}
          percentage={visibility.readerShowChapterPercentage}
          unit={progress.unit}
          current={chapter.current}
          total={chapter.total}
        />
      ) : null}
      {speed && <ReadingSpeedValue speed={speed} />}
    </footer>
  );
}

function ProgressValues({
  position,
  percentage,
  kind,
  unit,
  current,
  total,
}: {
  position: boolean;
  percentage: boolean;
  kind: "book" | "chapter";
  unit: ReaderProgressUnit;
  current: number;
  total: number;
}) {
  const { t, number } = useI18n();
  const shown = Math.min(current, total);
  const percent = Math.floor((shown / total) * 100);
  const book = kind === "book";
  return (
    <span
      className="reader-footer__values"
      role="group"
      aria-label={t(book ? "readerFooter.bookProgress" : "readerFooter.chapterProgress")}
    >
      {position && (
        <span
          aria-label={t(
            book
              ? unit === "words"
                ? "readerFooter.readingPositionWords"
                : "readerFooter.readingPositionCharacters"
              : unit === "words"
                ? "readerFooter.chapterPositionWords"
                : "readerFooter.chapterPositionCharacters",
            { current: shown, total },
          )}
        >
          {number(shown)} / {number(total)}{" "}
          {unit === "words" ? (
            <abbr title={t("readerFooter.words")}>{t("readerFooter.wo")}</abbr>
          ) : (
            <abbr title={t("readerFooter.characters")}>{t("readerFooter.ch")}</abbr>
          )}
        </span>
      )}
      {percentage && (
        <span
          aria-label={t(book ? "readerFooter.bookPercentage" : "readerFooter.chapterPercentage", {
            percent,
          })}
        >
          {book ? "" : `${t("readerFooter.chapterPrefix")} `}
          {percent}%
        </span>
      )}
    </span>
  );
}

const narrowQuery = "(max-width: 1080px)";

function narrowLayout(): boolean {
  return window.matchMedia ? window.matchMedia(narrowQuery).matches : false;
}

function compactLayout(): boolean {
  return window.matchMedia
    ? window.matchMedia("(max-width: 820px)").matches
    : window.innerWidth <= 820;
}

function footerLabel(identity: ReaderIdentity, status: ReaderStatus): MessageKey {
  if (identity.status === "book") {
    if (identity.book.availability !== "available") return "readerStatus.sourceUnavailable";
    if (status === "ready") return "readerStatus.ready";
    if (status === "loading") return "readerStatus.preparing";
    if (status === "empty") return "readerStatus.selected";
    return "readerStatus.unavailable";
  }
  if (identity.status === "unknown") return "readerStatus.notFound";
  if (identity.status === "error") return "library.unavailable";
  if (identity.status === "loading") return "readerStatus.finding";
  if (status === "loading") return "readerStatus.preparing";
  if (status === "error") return "readerStatus.unavailable";
  if (status === "ready") return "readerStatus.ready";
  return "readerStatus.noBook";
}

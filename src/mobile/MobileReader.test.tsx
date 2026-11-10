import type { SessionState } from "../features/reader/useReadingSession";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider, useAppearance } from "../features/appearance/AppearanceProvider";
import type { ReaderAppearancePanelProps } from "../features/reader/ReaderAppearancePanel";
import type { AppearancePreferences } from "../features/appearance/appearancePreferences";
import { NOTE_MARKS } from "../features/reader/noteHighlights";
import type {
  ReaderBookmarkPlace,
  ReaderBookProgress,
  ReaderPageTurnAvailability,
} from "../features/reader/renderer";
import type { useBookmarks } from "../features/reader/useBookmarks";
import type { useNotes } from "../features/reader/useNotes";
import type { ReadingSpeed } from "../features/statistics/readingSession";
import type { MobileReaderTools } from "./MobileReader";

const invoke = vi.hoisted(() =>
  vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => false }));

const { MobileReader } = await import("./MobileReader");

/** The Appearance panel's props from the saved preferences, as the Reader passes them. */
function usePanel(): ReaderAppearancePanelProps {
  const a = useAppearance();
  return {
    footer: a,
    onFooterChange: a.setReaderFooter,
    fontSize: a.readerFontSize,
    onFontSizeChange: a.setReaderFontSize,
    lineHeight: a.readerLineHeight,
    onLineHeightChange: a.setReaderLineHeight,
    letterSpacing: a.readerLetterSpacing,
    onLetterSpacingChange: a.setReaderLetterSpacing,
    wordSpacing: a.readerWordSpacing,
    onWordSpacingChange: a.setReaderWordSpacing,
    paragraphIndent: a.readerParagraphIndent,
    onParagraphIndentChange: a.setReaderParagraphIndent,
    paragraphMargin: a.readerParagraphMargin,
    onParagraphMarginChange: a.setReaderParagraphMargin,
    pageMargin: a.readerPageMargin,
    onPageMarginChange: a.setReaderPageMargin,
    maxWidth: a.readerMaxWidth,
    onMaxWidthChange: a.setReaderMaxWidth,
    monitor: null,
    pageLayout: a.readerPageLayout,
    onPageLayoutChange: a.setReaderPageLayout,
    maxHeight: a.readerMaxHeight,
    onMaxHeightChange: a.setReaderMaxHeight,
    writingMode: a.readerWritingMode,
    onWritingModeChange: a.setReaderWritingMode,
    textOrientation: a.readerTextOrientation,
    onTextOrientationChange: a.setReaderTextOrientation,
    textJustification: a.readerTextJustification,
    onTextJustificationChange: a.setReaderTextJustification,
    prettyTextWrap: a.readerPrettyTextWrap,
    onPrettyTextWrapChange: a.setReaderPrettyTextWrap,
    hideFurigana: a.readerHideFurigana,
    onHideFuriganaChange: a.setReaderHideFurigana,
    blurImage: a.readerBlurImage,
    onBlurImageChange: a.setReaderBlurImage,
    blurMode: a.readerBlurMode,
    onBlurModeChange: a.setReaderBlurMode,
    viewMode: a.readerViewMode,
    onViewModeChange: a.setReaderViewMode,
    wheelStep: a.readerWheelStep,
    onWheelStepChange: a.setReaderWheelStep,
    theme: a.readerTheme,
    customThemes: a.readerCustomThemes,
    onThemeChange: a.setReaderTheme,
    onCreateCustomTheme: a.createReaderCustomTheme,
    onCustomThemeChange: a.updateReaderCustomTheme,
    onDeleteCustomTheme: a.deleteReaderCustomTheme,
  };
}

function PhoneReader(props: Omit<Parameters<typeof MobileReader>[0], "appearance">) {
  return <MobileReader {...props} appearance={usePanel()} />;
}

const place: ReaderBookmarkPlace = {
  locator: { spineIndex: 2, sectionKey: "s", contentKey: "c", progress: 0.25 },
  excerpt: "",
};
const progress: ReaderBookProgress = {
  unit: "characters",
  current: 3_500,
  total: 10_000,
  chapter: { current: 500, total: 2_000, entryId: "two" },
};
const contents = [
  {
    id: "one",
    label: "First",
    navigable: true,
    children: [],
    location: { current: 0, total: 10_000, unit: "characters" as const },
  },
  {
    id: "two",
    label: "Second",
    navigable: true,
    children: [],
    location: { current: 3_000, total: 10_000, unit: "characters" as const },
  },
  {
    id: "three",
    label: "Third",
    navigable: true,
    children: [],
    location: { current: 5_000, total: 10_000, unit: "characters" as const },
  },
];

function reader({
  pageTurns = { canAdvance: true, canRetreat: true, forwardArrow: "ArrowRight" },
  bookmarked = false,
  preferences,
  lookupClosedAt = Number.NEGATIVE_INFINITY,
  speed = null,
  session = { readingMs: () => 0, state: "counting" as SessionState, toggle: vi.fn() },
}: {
  pageTurns?: ReaderPageTurnAvailability;
  bookmarked?: boolean;
  /** Saved preferences; the defaults without them. */
  preferences?: Partial<AppearancePreferences>;
  /** When a press last closed a lookup. */
  lookupClosedAt?: number;
  speed?: ReadingSpeed | null;
  session?: { readingMs: () => number; state: SessionState; toggle: () => void };
} = {}) {
  const viewport = document.createElement("div");
  document.body.append(viewport);
  const props = {
    onTurn: vi.fn(),
    onLookUp: vi.fn((_x: number, _y: number): boolean => false),
    onScroll: vi.fn(),
    onChapterEdge: vi.fn((_direction: "advance" | "retreat"): boolean => false),
    onReadOn: vi.fn((_advance: boolean): boolean => false),
    onVnGroupAt: vi.fn((_x: number, _y: number): boolean => false),
    onGoToEntry: vi.fn(),
    onGoToOffset: vi.fn((_offset: number, settled: (succeeded: boolean) => void) => settled(true)),
    onGoToPosition: vi.fn(),
    onBack: vi.fn(),
    onFeedback: vi.fn(),
    captureBookmark: vi.fn(async () => place),
    bookmarks: {
      status: "ready",
      items: bookmarked ? [{ ...place, id: "b1", label: "" }] : [],
      busy: false,
      error: "",
      notice: "",
      retry: () => {},
      create: vi.fn(async () => true),
      rename: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    } as unknown as ReturnType<typeof useBookmarks>,
    onSelectionAction: vi.fn(),
    image: { viewing: false, jumps: 0, close: vi.fn() },
  };
  const tools = {
    images: {
      ready: true,
      listImages: vi.fn(async () => ({ items: [], truncated: false, failedSections: 0 })),
      loadImage: vi.fn(),
      releaseImage: vi.fn(),
      onOpen: vi.fn(),
    },
    search: {
      ready: true,
      navigationBusy: false,
      onSearch: vi.fn(async () => ({
        matches: [{ id: "m1", label: "Second", before: "a ", match: "word", after: "" }],
        truncated: false,
      })),
      onJump: vi.fn((_id: string, _signal: AbortSignal, settled: (success: boolean) => void) => {
        settled(true);
        return true;
      }),
    },
    bookmarks: {
      bookmarks: props.bookmarks,
      canCreate: true,
      navigationBusy: false,
      onCreate: vi.fn(async () => true),
      onJump: vi.fn(() => true),
      place: () => "",
    },
    notes: {
      notes: {
        status: "ready",
        items: [],
        visibleItems: [],
        query: "",
        order: "creation",
        busy: false,
        error: "",
        notice: "",
        setQuery: () => {},
        setOrder: () => {},
        retry: () => {},
      } as unknown as ReturnType<typeof useNotes>,
      ready: true,
      navigationBusy: false,
      onJump: vi.fn(() => true),
      place: () => "",
    },
  } as unknown as MobileReaderTools;
  const touchRef = { current: (_event: TouchEvent) => {} };
  const selectionRef = { current: (_document: Document) => {} };
  const lookup = { open: false, closedAt: () => lookupClosedAt, back: vi.fn() };
  const store = preferences ? { load: async () => preferences, save: vi.fn(async () => {}) } : null;
  render(
    <AppearanceProvider store={store}>
      <PhoneReader
        {...props}
        contents={contents}
        lookup={lookup}
        currentEntryId="two"
        identity={{
          status: "book",
          book: {
            id: "1",
            title: "A Book",
            author: "Someone",
            availability: "available",
            hasCover: false,
            language: null,
            series: null,
            seriesIndex: null,
          },
          cover: null,
        }}
        pageTurns={pageTurns}
        progress={progress}
        ready
        selectionRef={selectionRef}
        session={session}
        speed={speed}
        tools={tools}
        touchRef={touchRef}
        turning={false}
        viewportRef={{ current: viewport }}
      />
    </AppearanceProvider>,
  );
  return { ...props, viewport, touchRef, selectionRef, tools, lookup };
}

/** Waits for saved preferences to apply and the Reader to show. */
async function shown() {
  await waitFor(() =>
    expect(document.querySelector("button.mobile-reader__footer")).not.toBeNull(),
  );
}

/** A book page whose selection is `text`, shown at the given place. */
function selectingPage(text: string, note?: string) {
  let selected = text;
  // A saved passage's mark under the selection, as the Reader paints it.
  const root = document.createElement("html");
  if (note) {
    const layer = document.createElement("div");
    layer.setAttribute(NOTE_MARKS, "");
    const mark = document.createElement("div");
    mark.setAttribute("data-note-id", note);
    mark.getBoundingClientRect = () => new DOMRect(90, 290, 60, 44);
    layer.append(mark);
    root.append(layer);
  }
  const page = {
    defaultView: null,
    documentElement: root,
    getSelection: () => ({
      isCollapsed: !selected,
      rangeCount: selected ? 1 : 0,
      toString: () => selected,
      getRangeAt: () => ({
        getBoundingClientRect: () => new DOMRect(100, 300, 40, 24),
        getClientRects: () => [new DOMRect(100, 300, 40, 24)],
      }),
      removeAllRanges: () => {
        selected = "";
      },
    }),
  } as unknown as Document;
  return { page, clear: () => (selected = "") };
}

/**
 * A touch from `from` lifted at `to`. Both events are made before either is sent, so their
 * time stamps are a moment apart however long the Reader takes with the first: a slow machine
 * never makes a tap a hold. False when the Reader cancels the touch's click.
 */
function touch(target: HTMLElement, from: { x: number; y: number }, to = from) {
  const start = createEvent.touchStart(target, {
    touches: [{ clientX: from.x, clientY: from.y }],
    changedTouches: [{ clientX: from.x, clientY: from.y }],
  });
  const end = createEvent.touchEnd(target, {
    touches: [],
    changedTouches: [{ clientX: to.x, clientY: to.y }],
  });
  fireEvent(target, start);
  return fireEvent(target, end);
}

function tap(target: HTMLElement, x: number, y = 400) {
  return touch(target, { x, y });
}

function drag(target: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  touch(target, from, to);
}

function swipe(target: HTMLElement, from: number, to: number) {
  touch(target, { x: from, y: 400 }, { x: to, y: 410 });
}

afterEach(() => {
  cleanup();
  invoke.mockClear();
  document.body.replaceChildren();
});

describe("the Reader by touch", () => {
  it("turns pages from the side parts of the page, following the page progression", () => {
    const ltr = reader();
    tap(ltr.viewport, 100);
    tap(ltr.viewport, 950);
    expect(ltr.onTurn.mock.calls).toEqual([["retreat"], ["advance"]]);
    cleanup();
    document.body.replaceChildren();

    const rtl = reader({
      pageTurns: { canAdvance: true, canRetreat: true, forwardArrow: "ArrowLeft" },
    });
    tap(rtl.viewport, 100);
    tap(rtl.viewport, 950);
    expect(rtl.onTurn.mock.calls).toEqual([["advance"], ["retreat"]]);
  });

  it("turns by a swipe in paginated view only, and leaves links and long presses to the book", () => {
    const paginated = reader();
    swipe(paginated.viewport, 700, 400);
    swipe(paginated.viewport, 400, 700);
    expect(paginated.onTurn.mock.calls).toEqual([["advance"], ["retreat"]]);
    expect(paginated.onScroll).not.toHaveBeenCalled();
    const link = document.createElement("a");
    link.href = "#note";
    paginated.viewport.append(link);
    tap(link, 950);
    expect(paginated.onTurn).toHaveBeenCalledTimes(2);
    cleanup();
    document.body.replaceChildren();

    const continuous = reader({
      pageTurns: {
        canAdvance: true,
        canRetreat: true,
        forwardArrow: "ArrowRight",
        scrollAxis: "vertical",
      },
    });
    swipe(continuous.viewport, 700, 400);
    expect(continuous.onTurn).not.toHaveBeenCalled();
    // The WebView scrolls it, and that is reading on.
    expect(continuous.onScroll).toHaveBeenCalled();
    tap(continuous.viewport, 950);
    expect(continuous.onTurn).toHaveBeenCalledWith("advance");
  });

  it("looks up a tapped word, and turns the page from blank space", () => {
    const { viewport, onTurn, onLookUp } = reader();
    onLookUp.mockReturnValueOnce(true);
    expect(tap(viewport, 950, 300)).toBe(false);
    expect(onLookUp).toHaveBeenCalledWith(950, 300);
    expect(onTurn).not.toHaveBeenCalled();
    expect(screen.queryByRole("banner")).toBeNull();
    tap(viewport, 950, 300);
    expect(onTurn).toHaveBeenCalledWith("advance");
  });

  it("leaves a tapped word alone with tap lookup off", async () => {
    const { viewport, onTurn, onLookUp } = reader({ preferences: { readerTapLookup: false } });
    await shown();
    onLookUp.mockReturnValue(true);
    tap(viewport, 950, 300);
    expect(onLookUp).not.toHaveBeenCalled();
    expect(onTurn).toHaveBeenCalledWith("advance");
  });

  it("shows the controls from the sides, and turns by no swipe, with page turns off", async () => {
    const { viewport, onTurn } = reader({ preferences: { readerTouchPageTurns: false } });
    await shown();
    swipe(viewport, 700, 400);
    tap(viewport, 950);
    expect(onTurn).not.toHaveBeenCalled();
    expect(await screen.findByRole("banner")).toBeInTheDocument();
  });

  it("does not turn the page on the tap that closed a lookup", () => {
    const { viewport, onTurn } = reader({ lookupClosedAt: Number.POSITIVE_INFINITY });
    tap(viewport, 950);
    expect(onTurn).not.toHaveBeenCalled();
  });

  it("turns the chapter after Chapter swipe threshold swipes in a row at its edge", async () => {
    const semi = reader({
      pageTurns: {
        canAdvance: true,
        canRetreat: true,
        forwardArrow: "ArrowRight",
        scrollAxis: "vertical",
      },
      preferences: { readerViewMode: "semi-continuous", readerChapterWheelThreshold: 2 },
    });
    await shown();
    semi.onChapterEdge.mockReturnValue(true);
    drag(semi.viewport, { x: 500, y: 600 }, { x: 505, y: 300 });
    expect(semi.onTurn).not.toHaveBeenCalled();
    // A swipe the other way starts the count again.
    drag(semi.viewport, { x: 500, y: 300 }, { x: 505, y: 600 });
    drag(semi.viewport, { x: 500, y: 600 }, { x: 505, y: 300 });
    expect(semi.onTurn).not.toHaveBeenCalled();
    drag(semi.viewport, { x: 500, y: 600 }, { x: 505, y: 300 });
    expect(semi.onTurn.mock.calls).toEqual([["advance"]]);
    cleanup();
    document.body.replaceChildren();

    // Pages turn at once; only the swipe from a chapter's last page waits for the count.
    const paged = reader({ preferences: { readerChapterWheelThreshold: 2 } });
    await shown();
    swipe(paged.viewport, 700, 400);
    expect(paged.onTurn).toHaveBeenCalledTimes(1);
    cleanup();
    document.body.replaceChildren();
    const lastPage = reader({
      pageTurns: {
        canAdvance: true,
        canRetreat: true,
        forwardArrow: "ArrowRight",
        advanceChapter: true,
      },
      preferences: { readerChapterWheelThreshold: 2 },
    });
    await shown();
    swipe(lastPage.viewport, 700, 400);
    expect(lastPage.onTurn).not.toHaveBeenCalled();
    swipe(lastPage.viewport, 700, 400);
    expect(lastPage.onTurn.mock.calls).toEqual([["advance"]]);
  });

  it("turns a chapter shown alone by a swipe that reads on from its edge", async () => {
    const vertical: ReaderPageTurnAvailability = {
      canAdvance: true,
      canRetreat: true,
      forwardArrow: "ArrowRight",
      scrollAxis: "vertical",
    };
    const semi = reader({
      pageTurns: vertical,
      // The phone's default: one swipe at the edge turns the chapter.
      preferences: { readerViewMode: "semi-continuous", readerChapterWheelThreshold: 1 },
    });
    await shown();
    semi.onChapterEdge.mockImplementation((direction) => direction === "advance");
    drag(semi.viewport, { x: 500, y: 600 }, { x: 505, y: 300 });
    expect(semi.onTurn.mock.calls).toEqual([["advance"]]);
    // Back from a chapter's start only when it is at its start.
    drag(semi.viewport, { x: 500, y: 300 }, { x: 505, y: 600 });
    expect(semi.onTurn).toHaveBeenCalledTimes(1);
    // Mid-chapter, the WebView scrolls it.
    semi.onChapterEdge.mockReturnValue(false);
    drag(semi.viewport, { x: 500, y: 600 }, { x: 505, y: 300 });
    expect(semi.onTurn).toHaveBeenCalledTimes(1);
    cleanup();
    document.body.replaceChildren();

    const continuous = reader({ pageTurns: vertical });
    continuous.onChapterEdge.mockReturnValue(true);
    drag(continuous.viewport, { x: 500, y: 600 }, { x: 505, y: 300 });
    expect(continuous.onTurn).not.toHaveBeenCalled();
  });

  it("reads a VN book on from its forward side, back from the other, and only shows the rest of its text while it appears", async () => {
    const { viewport, onTurn, onLookUp, onReadOn } = reader({
      pageTurns: {
        canAdvance: true,
        canRetreat: true,
        forwardArrow: "ArrowRight",
        scrollAxis: "vertical",
      },
      preferences: { readerViewMode: "vn" },
    });
    await shown();
    let revealing = false;
    onReadOn.mockImplementation((advance) => {
      if (!revealing) return advance;
      revealing = false;
      return true;
    });
    // The right fifth reads on.
    tap(viewport, 950);
    expect(onReadOn.mock.calls).toEqual([[false], [true]]);
    expect(onTurn).not.toHaveBeenCalled();
    expect(screen.queryByRole("banner")).toBeNull();
    // The left fifth turns back, even while the text still appears.
    revealing = true;
    onReadOn.mockClear();
    tap(viewport, 100);
    expect(onTurn).toHaveBeenCalledWith("retreat");
    expect(onReadOn).not.toHaveBeenCalled();
    // While the text appears, a tap on a word, shown or not yet, only shows the rest.
    onLookUp.mockClear().mockReturnValue(true);
    tap(viewport, 500);
    expect(onReadOn.mock.calls).toEqual([[false]]);
    expect(onLookUp).not.toHaveBeenCalled();
    // Once it all shows, the word is looked up, without reading on.
    tap(viewport, 500);
    expect(onLookUp).toHaveBeenCalledTimes(1);
    expect(onReadOn.mock.calls).toEqual([[false], [false]]);
    // Blank space in the middle shows the controls.
    onLookUp.mockReturnValue(false);
    tap(viewport, 500);
    expect(onReadOn.mock.calls).toEqual([[false], [false], [false]]);
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("banner")).toBeInTheDocument();
  });

  it("reads a VN book on from a tap on the group shown, with or without page turns by touch", async () => {
    for (const readerTouchPageTurns of [true, false]) {
      const { viewport, onTurn, onReadOn, onVnGroupAt } = reader({
        pageTurns: {
          canAdvance: true,
          canRetreat: true,
          forwardArrow: "ArrowRight",
          scrollAxis: "vertical",
        },
        preferences: { readerViewMode: "vn", readerTouchPageTurns },
      });
      await shown();
      onReadOn.mockImplementation((advance) => advance);
      // The group spans the middle of the page from 300 to 700 px.
      onVnGroupAt.mockImplementation((x) => x >= 300 && x <= 700);
      tap(viewport, 500);
      expect(onReadOn.mock.calls).toEqual([[false], [true]]);
      expect(screen.queryByRole("banner")).toBeNull();
      // Blank page beside it shows the controls.
      onReadOn.mockClear();
      tap(viewport, 250);
      expect(onReadOn.mock.calls).toEqual([[false]]);
      expect(onTurn).not.toHaveBeenCalled();
      expect(await screen.findByRole("banner")).toBeInTheDocument();
      cleanup();
    }
  });

  it("shows the controls from a tap anywhere on a continuous book, whole or a chapter alone", async () => {
    for (const readerViewMode of ["continuous", "semi-continuous"] as const) {
      const { viewport, onTurn } = reader({
        pageTurns: {
          canAdvance: true,
          canRetreat: true,
          forwardArrow: "ArrowRight",
          scrollAxis: "vertical",
        },
        preferences: { readerViewMode },
      });
      await shown();
      tap(viewport, 950);
      expect(onTurn).not.toHaveBeenCalled();
      expect(await screen.findByRole("banner")).toBeInTheDocument();
      cleanup();
      document.body.replaceChildren();
    }
  });

  it("turns the page by the volume keys only with their setting on and the book alone shown", async () => {
    const press = (key: string) =>
      (window as Window & { komoriVolumeKey?: (key: string) => boolean }).komoriVolumeKey?.(key);
    const off = reader();
    await shown();
    expect(press("down")).toBe(false);
    expect(off.onTurn).not.toHaveBeenCalled();
    cleanup();
    document.body.replaceChildren();

    const { viewport, onTurn, onReadOn, lookup } = reader({
      preferences: { readerVolumePageTurns: true },
    });
    await shown();
    expect(press("down")).toBe(true);
    expect(press("up")).toBe(true);
    expect(onTurn.mock.calls).toEqual([["advance"], ["retreat"]]);
    // Down reads on as VN view does, turning nothing more where it did.
    onReadOn.mockReturnValueOnce(true);
    press("down");
    expect(onReadOn).toHaveBeenLastCalledWith(true);
    expect(onTurn).toHaveBeenCalledTimes(2);
    // With the lookup open, a press closes it, as Back does.
    lookup.open = true;
    expect(press("up")).toBe(true);
    expect(lookup.back).toHaveBeenCalledTimes(1);
    expect(onTurn).toHaveBeenCalledTimes(2);
    lookup.open = false;
    // Over the controls the keys change the volume.
    tap(viewport, 500);
    await screen.findByRole("banner");
    expect(press("down")).toBe(false);
    expect(onTurn).toHaveBeenCalledTimes(2);
    cleanup();
    document.body.replaceChildren();
    expect(press("down")).toBeUndefined();
  });

  it("takes touches from the book's own pages through the Reader", () => {
    const { touchRef, onTurn } = reader();
    const page = document.createElement("p");
    document.body.append(page);
    const event = (type: string, x: number) =>
      Object.assign(new Event(type), {
        touches: type === "touchstart" ? [{ clientX: x, clientY: 10 }] : [],
        changedTouches: [{ clientX: x, clientY: 10 }],
      }) as unknown as TouchEvent;
    const start = event("touchstart", 950);
    Object.defineProperty(start, "target", { value: page });
    const end = event("touchend", 950);
    Object.defineProperty(end, "target", { value: page });
    act(() => {
      touchRef.current(start);
      touchRef.current(end);
    });
    expect(onTurn).toHaveBeenCalledWith("advance");
  });

  it("shows in its footer and status what the footer choices show", async () => {
    reader({
      preferences: {
        readerShowPercentage: false,
        readerShowChapterPosition: true,
        readerShowChapterPercentage: true,
        readerShowClock: false,
        readerShowReadingTime: false,
      },
      speed: { perHour: 12_000, unit: "characters" },
    });
    await shown();
    const [footer, ...others] = screen.getAllByRole("button", { name: "Show reader controls" });
    expect(others).toEqual([]);
    expect(footer!.textContent).toBe(
      "3,500 / 10,000 Ch. · 500 / 2,000 Ch. · Chapter 25% · 12,000 Ch./h",
    );
  });

  it("starts and pauses counting from the status pill, shown in Manual mode however bare", async () => {
    const toggle = vi.fn();
    const harness = reader({
      preferences: {
        readerShowClock: false,
        readerShowReadingTime: false,
        statisticsSessionStart: "manual",
      },
      session: { readingMs: () => 0, state: "paused", toggle },
    });
    await shown();
    const start = screen.getByRole("button", { name: "Start counting" });
    expect(start.getAttribute("aria-pressed")).toBe("false");
    // Over the page, its tap is its own click, not one showing the controls.
    const over = document.createElement("button");
    over.className = "mobile-reader__session";
    harness.viewport.append(over);
    expect(tap(over, 200, 60)).toBe(true);
    expect(document.querySelector(".mobile-reader-controls")).toBeNull();
    fireEvent.click(start);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Show reader controls" })).not.toBeNull();
  });

  it("shows Pause counting between the clock and the time read, and no button with statistics off", async () => {
    reader({
      preferences: { readerShowClock: true, readerShowReadingTime: true },
      session: { readingMs: () => 0, state: "counting", toggle: vi.fn() },
    });
    await shown();
    const pause = screen.getByRole("button", { name: "Pause counting" });
    expect(pause.getAttribute("aria-pressed")).toBe("true");
    const pill = [...pause.parentElement!.children];
    expect(pill.map((each) => each.getAttribute("aria-label"))).toEqual([
      "Show reader controls",
      "Pause counting",
      "Show reader controls",
    ]);
    expect(pill[2]!.textContent).toContain("0m 00s");
    cleanup();
    reader({
      preferences: { statisticsSessionStart: "manual" },
      session: { readingMs: () => 0, state: "off", toggle: vi.fn() },
    });
    await shown();
    expect(screen.queryByRole("button", { name: /counting$/ })).toBeNull();
  });

  it("puts the chapter and the speed on a second footer line when one line won't hold them", async () => {
    // The footer's widest text, measured on one line, is wider than the pill can be.
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(400);
    const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
    try {
      reader({
        preferences: {
          readerShowChapterPosition: true,
          readerShowChapterPercentage: true,
          readerShowClock: false,
          readerShowReadingTime: false,
        },
        speed: { perHour: 12_000, unit: "characters" },
      });
      await shown();
      const footer = screen.getByRole("button", { name: "Show reader controls" });
      expect(footer).toHaveClass("mobile-reader__footer--two-lines");
      expect([...footer.children].map((line) => line.textContent)).toEqual([
        "3,500 / 10,000 Ch. · 35%",
        "500 / 2,000 Ch. · Chapter 25% · 12,000 Ch./h",
      ]);
      // The book leaves room for the second line whether or not the footer shows.
      expect(document.querySelector(".mobile-reader__footer-measure")).toHaveAttribute(
        "data-lines",
        "2",
      );
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
  });

  it("shows the controls from the center, the clock or the footer, with the bars", async () => {
    const { viewport, onBack } = reader();
    expect(invoke).toHaveBeenCalledWith("show_system_bars", { shown: false });
    // The tap's click would land on the controls' backdrop and hide them again.
    expect(tap(viewport, 500)).toBe(false);
    // The title's pill between Back and Search, in place of the clock; the chapter's
    // between Appearance and Bookmark, in place of the footer.
    const header = await screen.findByRole("banner");
    expect(
      within(header)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Back to library", "Contents", "Search"]);
    expect(within(header).getByText("A Book")).toBeTruthy();
    const bottom = screen.getByRole("region", { name: "Reading position and tools" });
    expect(
      within(bottom)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Appearance", "Chapters", "Bookmark this page"]);
    expect(within(bottom).getByRole("button", { name: "Chapters" }).textContent).toBe(
      "Second· 35%",
    );
    expect(screen.queryByRole("button", { name: "Show reader controls" })).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("show_system_bars", { shown: true });
    await userEvent.click(within(header).getByRole("button", { name: "Back to library" }));
    expect(onBack).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Hide reader controls" }));
    expect(screen.queryByRole("banner")).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("show_system_bars", { shown: false });
    const [clock, footer] = screen.getAllByRole("button", { name: "Show reader controls" });
    expect(footer!.textContent).toBe("3,500 / 10,000 Ch. · 35%");
    await userEvent.click(clock!);
    expect(await screen.findByRole("banner")).toBeTruthy();
  });

  it("shows the chapter and position in Contents, and jumps where the slider is let go", async () => {
    const { viewport, onGoToOffset } = reader();
    tap(viewport, 500);
    await userEvent.click(await screen.findByRole("button", { name: "Contents" }));
    const sheet = screen.getByRole("dialog", { name: "Chapters" });
    const panel = sheet.querySelector<HTMLElement>(".mobile-chapters__now")!;
    expect(within(panel).getByText("Second")).toBeTruthy();
    expect(within(panel).getByText("25%")).toBeTruthy();
    const slider = within(panel).getByRole("slider", { name: "Position in the book" });
    fireEvent.change(slider, { target: { value: "6000" } });
    expect(within(panel).getByText("Third")).toBeTruthy();
    expect(within(panel).getByText("6,000 / 10,000 Ch.")).toBeTruthy();
    expect(onGoToOffset).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(onGoToOffset).toHaveBeenCalledWith(6_000, expect.any(Function));
    // The jump returns to the book.
    expect(screen.queryByRole("dialog", { name: "Chapters" })).toBeNull();
    expect(screen.queryByRole("banner")).toBeNull();
  });

  it("bookmarks the page, or removes its bookmark", async () => {
    const plain = reader();
    tap(plain.viewport, 500);
    const add = await screen.findByRole("button", { name: "Bookmark this page" });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(add);
    expect(plain.bookmarks.create).toHaveBeenCalledWith(expect.any(Function), "", plain.onFeedback);
    cleanup();
    document.body.replaceChildren();

    const marked = reader({ bookmarked: true });
    // The bookmarks store keeps the place's progress rounded.
    marked.captureBookmark.mockResolvedValue({
      ...place,
      locator: { ...place.locator, progress: 0.2500000000004 },
    });
    tap(marked.viewport, 500);
    const remove = await screen.findByRole("button", { name: "Remove this page's bookmark" });
    await userEvent.click(remove);
    expect(marked.bookmarks.remove).toHaveBeenCalledWith("b1");
    await waitFor(() => expect(marked.onFeedback).toHaveBeenCalledWith("Bookmark removed."));
  });

  it("lists the chapters along the line of reading and jumps to one", async () => {
    const { viewport, onGoToEntry } = reader();
    tap(viewport, 500);
    await userEvent.click(await screen.findByRole("button", { name: "Chapters" }));
    const sheet = screen.getByRole("dialog", { name: "Chapters" });
    const rows = within(sheet)
      .getAllByRole("button")
      .filter((row) => row.classList.contains("mobile-chapter"));
    expect(rows.map((row) => row.className.split("--")[1])).toEqual(["past", "current", "future"]);
    expect(rows[1]!.getAttribute("aria-current")).toBe("location");
    expect(rows[2]!.textContent).toContain("5,000 Ch.");
    await userEvent.click(rows[2]!);
    expect(onGoToEntry).toHaveBeenCalledWith("three");
    expect(screen.queryByRole("dialog", { name: "Chapters" })).toBeNull();
    expect(screen.queryByRole("banner")).toBeNull();
  });

  it("opens Search from the controls, and Images, Bookmarks and Notes from Contents", async () => {
    const { viewport, tools } = reader();
    tap(viewport, 500);
    const header = await screen.findByRole("banner");
    await userEvent.click(within(header).getByRole("button", { name: "Search" }));
    expect(screen.getByRole("dialog", { name: "Search" })).toBeTruthy();
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Search" })).getByRole("button", {
        name: "Close",
      }),
    );
    // The title and the chapter both open Contents.
    const bottom = screen.getByRole("region", { name: "Reading position and tools" });
    await userEvent.click(within(bottom).getByRole("button", { name: "Chapters" }));
    const contents = screen.getByRole("dialog", { name: "Chapters" });
    expect(
      within(contents)
        .getAllByRole("button")
        .filter((button) => button.classList.contains("mobile-reader-tool"))
        .map((button) => button.textContent),
    ).toEqual(["Images", "Bookmarks", "Notes"]);
    await userEvent.click(within(contents).getByRole("button", { name: "Notes" }));
    expect(screen.getByRole("dialog", { name: "Notes" }).textContent).toContain("No notes yet");
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Notes" })).getByRole("button", {
        name: "Close",
      }),
    );
    await userEvent.click(within(header).getByRole("button", { name: "Contents" }));
    const chapters = screen.getByRole("dialog", { name: "Chapters" });
    await userEvent.click(within(chapters).getByRole("button", { name: "Images" }));
    expect(screen.queryByRole("dialog", { name: "Chapters" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Images" })).toBeTruthy();
    expect(tools.images.listImages).toHaveBeenCalled();
  });

  it("returns to the book after a jump from a tool", async () => {
    const { viewport, tools } = reader();
    tap(viewport, 500);
    await userEvent.click(await screen.findByRole("button", { name: "Search" }));
    const sheet = screen.getByRole("dialog", { name: "Search" });
    await userEvent.type(within(sheet).getByRole("searchbox"), "word");
    await userEvent.click(within(sheet).getByRole("button", { name: "Find" }));
    await userEvent.click(await within(sheet).findByRole("button", { name: /^Jump to match 1/ }));
    expect(tools.search.onJump).toHaveBeenCalledWith(
      "m1",
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
    expect(screen.queryByRole("banner")).toBeNull();
  });

  it("shows Note, Highlight, Copy, Look up and Search beside the book's selection", async () => {
    const { selectionRef, onSelectionAction } = reader();
    const { page, clear } = selectingPage("羅生門");
    act(() => selectionRef.current(page));
    const toolbar = await screen.findByRole("toolbar", { name: "Text" });
    expect(
      within(toolbar)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Add note", "Highlight", "Copy", "Look up", "Search"]);
    await userEvent.click(within(toolbar).getByRole("button", { name: "Highlight" }));
    expect(onSelectionAction).toHaveBeenCalledWith("highlight", page, undefined);

    act(() => selectionRef.current(page));
    const again = await screen.findByRole("toolbar", { name: "Text" });
    await userEvent.click(within(again).getByRole("button", { name: "Copy" }));
    expect(onSelectionAction).toHaveBeenCalledWith("copy", page, undefined);
    expect(screen.queryByRole("toolbar")).toBeNull();

    act(() => selectionRef.current(page));
    await screen.findByRole("toolbar", { name: "Text" });
    // A tap elsewhere clears the selection, and the toolbar goes with it.
    clear();
    act(() => selectionRef.current(page));
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
  });

  it("offers Edit note and Delete on a saved passage a long press selects", async () => {
    const { selectionRef, onSelectionAction } = reader();
    const { page } = selectingPage("羅生門", "note-1");
    act(() => selectionRef.current(page));
    const toolbar = await screen.findByRole("toolbar", { name: "Text" });
    expect(
      within(toolbar)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Edit note", "Delete", "Copy", "Look up", "Search"]);
    await userEvent.click(within(toolbar).getByRole("button", { name: "Delete" }));
    expect(onSelectionAction).toHaveBeenCalledWith("delete", page, "note-1");

    act(() => selectionRef.current(page));
    const again = await screen.findByRole("toolbar", { name: "Text" });
    await userEvent.click(within(again).getByRole("button", { name: "Edit note" }));
    expect(onSelectionAction).toHaveBeenCalledWith("note", page, "note-1");
  });

  it("searches the book for the selected text", async () => {
    const { selectionRef, tools } = reader();
    const { page } = selectingPage("下人");
    act(() => selectionRef.current(page));
    const toolbar = await screen.findByRole("toolbar", { name: "Text" });
    await userEvent.click(within(toolbar).getByRole("button", { name: "Search" }));
    const sheet = screen.getByRole("dialog", { name: "Search" });
    expect((within(sheet).getByRole("searchbox") as HTMLInputElement).value).toBe("下人");
    expect(tools.search.onSearch).toHaveBeenCalledWith("下人", "book", expect.any(AbortSignal));
    expect(page.getSelection()?.isCollapsed).toBe(true);
  });

  it("keeps Android's toolbar away from the book's selections only", () => {
    const { touchRef } = reader();
    const book = document.implementation.createHTMLDocument("page").createElement("p");
    const start = Object.assign(new Event("touchstart"), {
      touches: [{ clientX: 10, clientY: 10 }],
      changedTouches: [{ clientX: 10, clientY: 10 }],
    }) as unknown as TouchEvent;
    Object.defineProperty(start, "target", { value: book });
    act(() => touchRef.current(start));
    expect(invoke).toHaveBeenLastCalledWith("book_selection", { own: true });
    fireEvent.touchStart(document.body, { touches: [{ clientX: 10, clientY: 10 }] });
    expect(invoke).toHaveBeenLastCalledWith("book_selection", { own: false });
  });

  it("asks where to continue a book read on the PC and here since they last synced", async () => {
    const today = new Date();
    today.setHours(8, 2, 0, 0);
    const conflict = {
      pc: {
        position: { spineIndex: 6, progress: 0.4 },
        progress: { unit: "characters", current: 5_200, total: 10_000 },
      },
      pcAt: new Date(+today + 60_000).toISOString(),
      phone: {
        position: { spineIndex: 2, progress: 0.25 },
        progress: { unit: "characters", current: 3_500, total: 10_000 },
      },
      phoneAt: today.toISOString(),
    };
    invoke.mockImplementation(async (command) =>
      command === "get_pc_conflict"
        ? conflict
        : command === "get_pc_link"
          ? { paired: true, syncOn: false, pcName: "KOMORI-PC" }
          : command === "resolve_pc_conflict"
            ? true
            : undefined,
    );
    const { onGoToPosition } = reader();
    const dialog = await screen.findByRole("dialog", { name: "Continue from" });
    expect(within(dialog).getByText("A Book")).toBeTruthy();
    const [pc, phone] = within(dialog).getAllByRole("button");
    await waitFor(() => expect(pc!.textContent).toContain("KOMORI-PC"));
    expect(pc!.textContent).toContain("Third · 52% · Today, ");
    expect(phone!.textContent).toContain("This phone");
    expect(phone!.textContent).toContain("Second · 35% · Today, ");
    // The later place is marked.
    expect(pc!.className).toContain("--later");
    expect(phone!.className).not.toContain("--later");

    await userEvent.click(pc!);
    expect(invoke).toHaveBeenCalledWith("resolve_pc_conflict", { id: "1", keep: "pc" });
    await waitFor(() =>
      expect(onGoToPosition).toHaveBeenCalledWith(conflict.pc.position, expect.any(Function)),
    );
    expect(screen.queryByRole("dialog", { name: "Continue from" })).toBeNull();
    invoke.mockImplementation(async () => undefined);
  });

  it("changes the Reader's appearance from its sheet", async () => {
    const { viewport } = reader();
    tap(viewport, 500);
    await userEvent.click(await screen.findByRole("button", { name: "Appearance" }));
    const sheet = screen.getByRole("dialog", { name: "Appearance" });
    expect(screen.queryByRole("banner")).toBeNull();
    const vertical = within(sheet).getByRole("button", { name: "Vertical" });
    await userEvent.click(vertical);
    expect(vertical.getAttribute("aria-pressed")).toBe("true");
    const continuous = within(sheet).getByRole("button", { name: "Continuous" });
    await userEvent.click(continuous);
    expect(continuous.getAttribute("aria-pressed")).toBe("true");
    expect(invoke).toHaveBeenCalledWith("system_bar_icons", { dark: true });
    await userEvent.click(
      within(within(sheet).getByRole("group", { name: "Theme" })).getByRole("button", {
        name: "Night",
      }),
    );
    // The bars show over the night page with light icons.
    expect(invoke).toHaveBeenLastCalledWith("system_bar_icons", { dark: false });
  });

  it("makes, edits and deletes a custom theme from its sheet", async () => {
    const { viewport } = reader();
    tap(viewport, 500);
    await userEvent.click(await screen.findByRole("button", { name: "Appearance" }));
    const sheet = screen.getByRole("dialog", { name: "Appearance" });
    expect(within(sheet).queryByRole("textbox", { name: "Theme name" })).toBeNull();
    await userEvent.click(
      within(sheet).getByRole("button", { name: "New custom theme from the current colors" }),
    );
    const name = within(sheet).getByRole("textbox", { name: "Theme name" });
    expect(name).toHaveValue("Custom 1");
    await userEvent.clear(name);
    await userEvent.type(name, "Evening");
    const themes = within(sheet).getByRole("group", { name: "Theme" });
    expect(within(themes).getByRole("button", { name: "Evening" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(within(sheet).getByRole("button", { name: "Delete theme" }));
    expect(within(themes).queryByRole("button", { name: "Evening" })).toBeNull();
    expect(within(sheet).queryByRole("textbox", { name: "Theme name" })).toBeNull();
  });

  it("offers the PC's view modes and options in its sheet, without a window's", async () => {
    const { viewport, onTurn, onLookUp } = reader();
    tap(viewport, 500);
    await userEvent.click(await screen.findByRole("button", { name: "Appearance" }));
    const sheet = screen.getByRole("dialog", { name: "Appearance" });
    const modes = within(sheet).getByRole("group", { name: "View mode" });
    expect(
      within(modes)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Continuous", "Semi-continuous", "Paginated", "VN"]);
    expect(within(sheet).getByRole("group", { name: "Letter spacing" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Hide furigana" })).toBeInTheDocument();
    for (const name of ["Maximum text width", "Reader max height", "Wheel step", "Pages"])
      expect(within(sheet).queryByRole("group", { name })).toBeNull();
    expect(within(sheet).queryByText("Background image")).toBeNull();

    await userEvent.click(within(sheet).getByRole("button", { name: "Tap a word to look it up" }));
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Tap or swipe to turn pages" }),
    );
    expect(
      within(sheet).getByRole("button", { name: "Volume keys turn pages" }),
    ).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    onLookUp.mockClear().mockReturnValue(true);
    tap(viewport, 950);
    expect(onLookUp).not.toHaveBeenCalled();
    expect(onTurn).not.toHaveBeenCalled();
  });
});

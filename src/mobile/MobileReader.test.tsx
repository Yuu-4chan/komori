import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../features/appearance/AppearanceProvider";
import type {
  ReaderBookmarkPlace,
  ReaderBookProgress,
  ReaderPageTurnAvailability,
} from "../features/reader/renderer";
import type { useBookmarks } from "../features/reader/useBookmarks";

const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => false }));

const { MobileReader } = await import("./MobileReader");

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
}: { pageTurns?: ReaderPageTurnAvailability; bookmarked?: boolean } = {}) {
  const viewport = document.createElement("div");
  document.body.append(viewport);
  const props = {
    onTurn: vi.fn(),
    onScroll: vi.fn(),
    onGoToEntry: vi.fn(),
    onGoToOffset: vi.fn((_offset: number, settled: (succeeded: boolean) => void) => settled(true)),
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
  };
  const touchRef = { current: (_event: TouchEvent) => {} };
  render(
    <AppearanceProvider store={null}>
      <MobileReader
        {...props}
        contents={contents}
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
        session={{ readingMs: () => 0, state: "counting" }}
        touchRef={touchRef}
        turning={false}
        viewportRef={{ current: viewport }}
      />
    </AppearanceProvider>,
  );
  return { ...props, viewport, touchRef };
}

function tap(target: HTMLElement, x: number, y = 400) {
  fireEvent.touchStart(target, {
    touches: [{ clientX: x, clientY: y }],
    changedTouches: [{ clientX: x, clientY: y }],
  });
  // False when the Reader cancels the tap's click.
  return fireEvent.touchEnd(target, { touches: [], changedTouches: [{ clientX: x, clientY: y }] });
}

function swipe(target: HTMLElement, from: number, to: number) {
  fireEvent.touchStart(target, {
    touches: [{ clientX: from, clientY: 400 }],
    changedTouches: [{ clientX: from, clientY: 400 }],
  });
  fireEvent.touchEnd(target, { touches: [], changedTouches: [{ clientX: to, clientY: 410 }] });
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

  it("shows the controls from the center, the clock or the footer, with the bars", async () => {
    const { viewport, onBack } = reader();
    expect(invoke).toHaveBeenCalledWith("show_system_bars", { shown: false });
    // The tap's click would land on the controls' backdrop and hide them again.
    expect(tap(viewport, 500)).toBe(false);
    const header = await screen.findByRole("banner");
    expect(within(header).getByText("A Book")).toBeTruthy();
    expect(within(header).getByText("Someone")).toBeTruthy();
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

  it("shows the chapter and position, and jumps where the slider is let go", async () => {
    const { viewport, onGoToOffset } = reader();
    tap(viewport, 500);
    const panel = await screen.findByRole("region", { name: "Reading position and tools" });
    expect(within(panel).getByText("Second")).toBeTruthy();
    expect(within(panel).getByText("25%")).toBeTruthy();
    const slider = within(panel).getByRole("slider", { name: "Position in the book" });
    fireEvent.change(slider, { target: { value: "6000" } });
    expect(within(panel).getByText("Third")).toBeTruthy();
    expect(within(panel).getByText("6,000 / 10,000 Ch.")).toBeTruthy();
    expect(onGoToOffset).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(onGoToOffset).toHaveBeenCalledWith(6_000, expect.any(Function));
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
    expect(within(sheet).getByRole("group", { name: "Theme" })).toBeTruthy();
  });
});

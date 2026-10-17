import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { registerWindowFlush } from "../../app/windowLifecycle";
import { AppearanceProvider } from "../appearance/AppearanceProvider";
import { AutoscrollSetting } from "../appearance/AutoscrollSetting";
import type { AppearancePreferences } from "../appearance/appearancePreferences";
import type {
  ReaderBookProgress,
  ReaderLocator,
  ReaderPositionBinding,
  ReaderPositionStore,
  ReaderPresentation,
  ReaderRendererFactory,
} from "./renderer";
import type { ReaderIdentity } from "./readerIdentity";
import { ReaderShell } from "./ReaderShell";

// The window's close flushers are kept as they are and only recorded.
vi.mock("../../app/windowLifecycle", async (importOriginal) => {
  const lifecycle = await importOriginal<typeof import("../../app/windowLifecycle")>();
  return { ...lifecycle, registerWindowFlush: vi.fn(lifecycle.registerWindowFlush) };
});

const pageActions = {
  advancePage: vi.fn(async () => undefined),
  retreatPage: vi.fn(async () => undefined),
};

function renderReader(
  factory?: ReaderRendererFactory,
  strict = false,
  saved?: Partial<AppearancePreferences>,
) {
  const tree = (
    <MemoryRouter initialEntries={["/reader"]}>
      <AppearanceProvider store={saved ? { load: async () => saved, save: vi.fn() } : null}>
        <Routes>
          <Route path="/reader" element={<ReaderShell rendererFactory={factory} />} />
          <Route path="/library" element={<h1>Library</h1>} />
        </Routes>
      </AppearanceProvider>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

describe("Reader shell", () => {
  it("shows an honest empty state and navigates back to Library", async () => {
    const user = userEvent.setup();
    renderReader();
    expect(
      screen.getByRole("heading", { name: "Your reading space is ready" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Reader sidebar" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Back to library" }));
    expect(screen.getByRole("heading", { name: "Library" })).toBeInTheDocument();
  });

  it("shows loading then a ready host through the Komori contract", async () => {
    let finish!: () => void;
    const mounted = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const factory: ReaderRendererFactory = () => ({
      ...pageActions,
      mount: (host) => {
        host.append(document.createElement("div"));
        return mounted.then(() => "ready" as const);
      },
      dispose: vi.fn(),
    });
    renderReader(factory);
    expect(
      screen.getByRole("heading", { name: "Preparing your reading space" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main").firstElementChild).toHaveAttribute("aria-busy", "true");
    finish();
    await waitFor(() => expect(screen.getByText("Reader ready")).toBeInTheDocument());
    expect(screen.queryByText("Preparing your reading space")).not.toBeInTheDocument();
  });

  it("reports renderer failure and disposes its partial mount", async () => {
    const dispose = vi.fn();
    const factory: ReaderRendererFactory = () => ({
      ...pageActions,
      mount: async (host) => {
        host.append(document.createElement("div"));
        throw Error("private detail");
      },
      dispose,
    });
    const { container } = renderReader(factory);
    expect(await screen.findByRole("alert")).toHaveTextContent("The reader could not start");
    expect(screen.queryByText("private detail")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous page" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
    expect(container.querySelector(".reader-viewport__host")?.childElementCount).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("clears a failed mount even if adapter disposal throws", async () => {
    const factory: ReaderRendererFactory = () => ({
      ...pageActions,
      mount: async (host) => {
        host.append(document.createElement("div"));
        throw Error("mount failed");
      },
      dispose: () => {
        throw Error("teardown failed");
      },
    });
    const { container } = renderReader(factory);
    expect(await screen.findByRole("alert")).toHaveTextContent("The reader could not start");
    expect(container.querySelector(".reader-viewport__host")?.childElementCount).toBe(0);
  });

  it("aborts and disposes each mount, including repeated development lifecycle mounts", async () => {
    const signals: AbortSignal[] = [];
    const dispose = vi.fn();
    const factory: ReaderRendererFactory = () => ({
      ...pageActions,
      mount: (host, signal) => {
        signals.push(signal);
        host.append(document.createElement("div"));
        return new Promise<"ready">(() => {});
      },
      dispose,
    });
    const { container, unmount } = renderReader(factory, true);
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(container.querySelector(".reader-viewport__host")?.childElementCount).toBe(1);
    unmount();
    expect(signals[1].aborted).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".reader-viewport__host")?.childElementCount ?? 0).toBe(0);
  });

  it("ignores a late initialization result after unmount", async () => {
    let finish!: (value: "ready") => void;
    const pending = new Promise<"ready">((resolve) => {
      finish = resolve;
    });
    let signal!: AbortSignal;
    const dispose = vi.fn();
    const factory: ReaderRendererFactory = () => ({
      ...pageActions,
      mount: (_host, nextSignal) => {
        signal = nextSignal;
        return pending;
      },
      dispose,
    });
    const { unmount } = renderReader(factory);
    unmount();
    expect(signal.aborted).toBe(true);
    finish("ready");
    await pending;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("replaces an old book renderer without showing its late completion", async () => {
    let finishFirst!: (value: "ready") => void;
    let firstSignal!: AbortSignal;
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const first: ReaderRendererFactory = () => ({
      ...pageActions,
      mount: (host, signal) => {
        firstSignal = signal;
        host.textContent = "old book";
        return new Promise<"ready">((resolve) => {
          finishFirst = resolve;
        });
      },
      dispose: firstDispose,
    });
    const second: ReaderRendererFactory = () => ({
      ...pageActions,
      mount: async (host) => {
        host.textContent = "new book";
        return "ready";
      },
      dispose: secondDispose,
    });
    const tree = (factory: ReaderRendererFactory) => (
      <MemoryRouter>
        <AppearanceProvider>
          <ReaderShell rendererFactory={factory} />
        </AppearanceProvider>
      </MemoryRouter>
    );
    const view = render(tree(first));
    view.rerender(tree(second));
    expect(firstSignal.aborted).toBe(true);
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".reader-viewport__host")).toHaveTextContent("new book");
    finishFirst("ready");
    await waitFor(() => expect(screen.getByText("Reader ready")).toBeInTheDocument());
    expect(view.container.querySelector(".reader-viewport__host")).not.toHaveTextContent(
      "old book",
    );
    view.unmount();
    expect(secondDispose).toHaveBeenCalledOnce();
  });

  it("fills the window with the book and floats the sidebar over it", async () => {
    const user = userEvent.setup();
    const { container } = renderReader();
    // No top or bottom bar: the Reader is the reading area and the sidebar.
    expect(container.querySelector("header")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Komori Reader" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /theme/ })).not.toBeInTheDocument();
    const sidebar = screen.getByRole("complementary", { name: "Reader sidebar" });
    // A floating sidebar starts hidden, so the book opens immersed.
    expect(sidebar).toHaveClass("reader-sidebar--floating", "reader-sidebar--hidden");
    await user.hover(sidebar);
    expect(sidebar).toHaveClass("reader-sidebar--shown");

    // It hides once the pointer leaves it, and the window's left edge brings it back.
    await user.unhover(sidebar);
    expect(sidebar).toHaveClass("reader-sidebar--hidden");
    const edge = container.querySelector(".reader-sidebar-hotspot")!;
    await user.hover(edge);
    expect(sidebar).toHaveClass("reader-sidebar--shown");
    await user.unhover(edge);
    await user.hover(sidebar);
    await user.unhover(sidebar);
    await user.click(edge);
    expect(sidebar).toHaveClass("reader-sidebar--shown");
  });

  it("starts compact windows with the floating sidebar hidden too and shows it from the left edge", async () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
    try {
      const user = userEvent.setup();
      const { container } = renderReader();
      const sidebar = screen.getByRole("complementary", { name: "Reader sidebar" });
      expect(sidebar).toHaveClass("reader-sidebar--hidden");
      await user.click(container.querySelector(".reader-sidebar-hotspot")!);
      expect(sidebar).toHaveClass("reader-sidebar--shown");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
    }
  });

  it("shows the sidebar to keyboard focus and hides it with Escape", async () => {
    const user = userEvent.setup();
    renderReader();
    const sidebar = screen.getByRole("complementary", { name: "Reader sidebar" });
    await user.tab();
    expect(screen.getByRole("link", { name: "Skip to reading area" })).toHaveFocus();
    await user.tab();
    const back = screen.getByRole("link", { name: "Back to library" });
    expect(back).toHaveFocus();
    expect(within(sidebar).getByRole("button", { name: "Reader appearance" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(sidebar).toHaveClass("reader-sidebar--hidden");
    expect(screen.getByRole("main")).toHaveFocus();
    // Tabbing back into the sidebar shows it again.
    await user.tab({ shift: true });
    expect(sidebar).toContainElement(document.activeElement as HTMLElement);
    expect(sidebar).toHaveClass("reader-sidebar--shown");
    // Arrows pressed on a control of a sidebar that hid as the pointer left read on.
    fireEvent.pointerLeave(sidebar);
    expect(sidebar).toHaveClass("reader-sidebar--hidden");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByRole("main")).toHaveFocus();
  });

  it("pins the sidebar beside the book, saves the choice, and floats it again", async () => {
    const user = userEvent.setup();
    const saved: boolean[] = [];
    const { container } = render(
      <MemoryRouter>
        <AppearanceProvider
          store={{
            load: async () => ({}),
            save: async (preferences) => {
              saved.push(preferences.readerSidebarPinned);
            },
          }}
        >
          <ReaderShell />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    const sidebar = await screen.findByRole("complementary", { name: "Reader sidebar" });
    const pin = screen.getByRole("button", { name: "Pin reader sidebar" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    await user.click(pin);
    expect(pin).toHaveAccessibleName("Unpin reader sidebar");
    expect(pin).toHaveAttribute("aria-pressed", "true");
    expect(sidebar).toHaveClass("reader-sidebar--pinned", "reader-sidebar--shown");
    expect(container.querySelector(".reader-shell")).toHaveClass("reader-shell--pinned");
    expect(container.querySelector(".reader-sidebar-hotspot")).toBeNull();
    await waitFor(() => expect(saved.at(-1)).toBe(true));
    // A pinned sidebar stays when the pointer leaves it or Escape is pressed.
    await user.unhover(sidebar);
    await user.keyboard("{Escape}");
    expect(sidebar).toHaveClass("reader-sidebar--shown");

    await user.click(pin);
    expect(sidebar).toHaveClass("reader-sidebar--floating");
    await waitFor(() => expect(saved.at(-1)).toBe(false));
  });

  it("opens with the saved pinned sidebar", async () => {
    render(
      <MemoryRouter>
        <AppearanceProvider
          store={{ load: async () => ({ readerSidebarPinned: true }), save: async () => undefined }}
        >
          <ReaderShell />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("complementary", { name: "Reader sidebar" })).toHaveClass(
      "reader-sidebar--pinned",
    );
    expect(screen.getByRole("button", { name: "Unpin reader sidebar" })).toBeInTheDocument();
  });

  it("floats a saved pinned sidebar where the book has no room beside it, and keeps the saved pin", async () => {
    // A controllable window width for the Reader's media queries.
    let width = 1000;
    const lists = new Map<string, { matches: boolean; listeners: Set<() => void> }>();
    const matches = (query: string) => width <= Number(/max-width: (\d+)px/.exec(query)![1]);
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => {
      const entry = lists.get(query) ?? { matches: matches(query), listeners: new Set() };
      lists.set(query, entry);
      return {
        get matches() {
          return matches(query);
        },
        media: query,
        addEventListener: (_type: string, listener: () => void) => entry.listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) =>
          entry.listeners.delete(listener),
      };
    }) as unknown as typeof window.matchMedia;
    const resize = (next: number) =>
      act(() => {
        width = next;
        for (const [query, entry] of lists)
          for (const listener of entry.listeners)
            (listener as (event: { matches: boolean }) => void)({ matches: matches(query) });
      });
    const saved: boolean[] = [];
    try {
      const { container } = render(
        <MemoryRouter>
          <AppearanceProvider
            store={{
              load: async () => ({ readerSidebarPinned: true }),
              save: async (preferences) => void saved.push(preferences.readerSidebarPinned),
            }}
          >
            <ReaderShell />
          </AppearanceProvider>
        </MemoryRouter>,
      );
      const sidebar = await screen.findByRole("complementary", { name: "Reader sidebar" });
      // Let the saved preferences load.
      await act(async () => undefined);
      // At 1080 px and below it floats and hides like an unpinned sidebar, with no pin to press.
      expect(sidebar).toHaveClass("reader-sidebar--floating", "reader-sidebar--hidden");
      expect(container.querySelector(".reader-shell")).toHaveClass("reader-shell--floating");
      expect(screen.queryByRole("button", { name: /pin reader sidebar/i })).toBeNull();
      fireEvent.pointerEnter(container.querySelector(".reader-sidebar-hotspot")!);
      expect(sidebar).toHaveClass("reader-sidebar--shown");
      fireEvent.pointerLeave(sidebar);
      expect(sidebar).toHaveClass("reader-sidebar--hidden");

      // Wider again, the saved pin docks it beside the book.
      resize(1280);
      expect(sidebar).toHaveClass("reader-sidebar--pinned", "reader-sidebar--shown");
      expect(container.querySelector(".reader-shell")).toHaveClass("reader-shell--pinned");
      expect(screen.getByRole("button", { name: "Unpin reader sidebar" })).toBeInTheDocument();
      resize(900);
      expect(sidebar).toHaveClass("reader-sidebar--floating");
      expect(saved).not.toContain(false);
    } finally {
      window.matchMedia = original;
    }
  });

  it("hides the floating sidebar once pages turn from the book", async () => {
    const factory: ReaderRendererFactory = () => ({
      advancePage: vi.fn(async () => undefined),
      retreatPage: vi.fn(async () => undefined),
      mount: async (_host, _signal, changed) => {
        changed({ canAdvance: true, canRetreat: true, forwardArrow: "ArrowRight" });
        return "ready";
      },
      dispose: vi.fn(),
    });
    renderReader(factory);
    await screen.findByText("Reader ready");
    const sidebar = screen.getByRole("complementary", { name: "Reader sidebar" });
    fireEvent.click(document.querySelector(".reader-sidebar-hotspot")!);
    expect(sidebar).toHaveClass("reader-sidebar--shown");
    screen.getByRole("main").focus();
    await userEvent.setup().keyboard("{ArrowRight}");
    expect(sidebar).toHaveClass("reader-sidebar--hidden");
  });

  it("keeps keyboard input inert while loading and at the beginning", async () => {
    let finish!: (result: "ready" | "error") => void;
    const factory: ReaderRendererFactory = () => ({
      ...pageActions,
      mount: (_host, _signal, changed) => {
        changed({ canAdvance: true, canRetreat: false });
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      dispose: vi.fn(),
    });
    renderReader(factory);
    const viewport = screen.getByRole("main");
    viewport.focus();
    await userEvent.setup().keyboard("{ArrowRight}{ArrowLeft}");
    expect(pageActions.advancePage).not.toHaveBeenCalled();
    expect(pageActions.retreatPage).not.toHaveBeenCalled();
    finish("ready");
    await waitFor(() => expect(screen.getByText("Reader ready")).toBeInTheDocument());
    await userEvent.setup().keyboard("{ArrowLeft}");
    expect(pageActions.retreatPage).not.toHaveBeenCalled();
  });

  it("ignores repeated turns and a late old-book action after switching", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const advanceOld = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const old: ReaderRendererFactory = () => ({
      mount: async (_host, _signal, changed) => {
        changed({ canAdvance: true, canRetreat: false });
        return "ready";
      },
      advancePage: advanceOld,
      retreatPage: vi.fn(async () => undefined),
      dispose: vi.fn(),
    });
    const advanceNew = vi.fn(async () => undefined);
    const nextBook: ReaderRendererFactory = () => ({
      mount: async (_host, _signal, changed) => {
        changed({ canAdvance: true, canRetreat: false });
        return "ready";
      },
      advancePage: advanceNew,
      retreatPage: vi.fn(async () => undefined),
      dispose: vi.fn(),
    });
    const tree = (factory: ReaderRendererFactory) => (
      <MemoryRouter>
        <AppearanceProvider>
          <ReaderShell rendererFactory={factory} />
        </AppearanceProvider>
      </MemoryRouter>
    );
    const view = render(tree(old));
    await waitFor(() => expect(screen.getByText("Reader ready")).toBeInTheDocument());
    screen.getByRole("main").focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(advanceOld).toHaveBeenCalledOnce();
    view.rerender(tree(nextBook));
    await waitFor(() => expect(screen.getByText("Reader ready")).toBeInTheDocument());
    finish();
    await user.keyboard("{ArrowRight}");
    expect(advanceOld).toHaveBeenCalledOnce();
    expect(advanceNew).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("scrolls a continuous book with repeated arrows and the chosen distance per wheel step", async () => {
    const scrollBy = vi.fn();
    const advancePage = vi.fn(async () => undefined);
    const factory: ReaderRendererFactory = () => ({
      mount: async (_host, _signal, changed) => {
        changed({
          canAdvance: true,
          canRetreat: true,
          forwardArrow: "ArrowLeft",
          scrollAxis: "horizontal",
        });
        return "ready";
      },
      advancePage,
      retreatPage: vi.fn(async () => undefined),
      scrollBy,
      dispose: vi.fn(),
    });
    renderReader(factory);
    await screen.findByText("Reader ready");
    const viewport = screen.getByRole("main");
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 1000 });
    viewport.focus();
    fireEvent.keyDown(viewport, { key: "ArrowDown", repeat: true });
    fireEvent.keyDown(viewport, { key: "ArrowLeft" });
    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    fireEvent.keyDown(viewport, { key: "ArrowUp" });
    // A wheel step scrolls 100px by default, and finer movement in proportion.
    fireEvent.wheel(viewport, { deltaY: 100 });
    fireEvent.wheel(viewport, { deltaY: -125 });
    fireEvent.wheel(viewport, { deltaY: 25 });
    fireEvent.wheel(viewport, { deltaY: 1, deltaMode: 2 });
    expect(scrollBy.mock.calls.map(([distance]) => distance)).toEqual([
      100, 100, -100, -100, 100, -100, 25, 100,
    ]);
    // The chosen step applies to the next wheel step.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reader appearance" }));
    const step = screen.getByRole("group", { name: "Wheel step" });
    expect(step).toHaveTextContent("100 px");
    await user.click(screen.getByRole("button", { name: "Increase Wheel step" }));
    await user.click(screen.getByRole("button", { name: "Increase Wheel step" }));
    expect(step).toHaveTextContent("120 px");
    fireEvent.wheel(viewport, { deltaY: 100 });
    fireEvent.wheel(viewport, { deltaY: -50 });
    expect(scrollBy.mock.calls.slice(-2).map(([distance]) => distance)).toEqual([120, -120]);
    expect(advancePage).not.toHaveBeenCalled();
  });

  it("turns to the neighbouring chapter when a chapter view cannot scroll further", async () => {
    // The book is at its chapter's end, so reading on turns and reading back scrolls.
    const scrollBy = vi.fn((distance: number) => distance < 0);
    const advancePage = vi.fn(async () => undefined);
    const retreatPage = vi.fn(async () => undefined);
    const factory: ReaderRendererFactory = () => ({
      mount: async (_host, _signal, changed) => {
        changed({
          canAdvance: true,
          canRetreat: true,
          forwardArrow: "ArrowRight",
          scrollAxis: "vertical",
        });
        return "ready";
      },
      advancePage,
      retreatPage,
      scrollBy,
      dispose: vi.fn(),
    });
    renderReader(factory);
    await screen.findByText("Reader ready");
    const viewport = screen.getByRole("main");
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 1000 });
    viewport.focus();
    fireEvent.wheel(viewport, { deltaY: 100 });
    expect(advancePage).toHaveBeenCalledOnce();
    await act(async () => undefined);
    fireEvent.keyDown(viewport, { key: "ArrowDown" });
    expect(advancePage).toHaveBeenCalledTimes(2);
    await act(async () => undefined);
    fireEvent.wheel(viewport, { deltaY: -100 });
    expect(scrollBy).toHaveBeenLastCalledWith(-100);
    expect(retreatPage).not.toHaveBeenCalled();
  });

  it("turns one page per wheel step, each waiting for the turn before it", async () => {
    const turns: Array<{ direction: string; finish: () => void }> = [];
    const turn = (direction: string) => () =>
      new Promise<void>((finish) => {
        turns.push({ direction, finish });
      });
    const factory: ReaderRendererFactory = () => ({
      mount: async (_host, _signal, changed) => {
        changed({ canAdvance: true, canRetreat: true, forwardArrow: "ArrowRight" });
        return "ready";
      },
      advancePage: vi.fn(turn("advance")),
      retreatPage: vi.fn(turn("retreat")),
      dispose: vi.fn(),
    });
    renderReader(factory);
    await screen.findByText("Reader ready");
    const viewport = screen.getByRole("main");
    const finishTurn = async () => {
      await act(async () => turns.at(-1)!.finish());
    };

    // Three quick wheel steps turn three pages, one after another.
    for (let step = 0; step < 3; step++) fireEvent.wheel(viewport, { deltaY: 100 });
    expect(turns.map(({ direction }) => direction)).toEqual(["advance"]);
    await finishTurn();
    await waitFor(() => expect(turns).toHaveLength(2));
    await finishTurn();
    await waitFor(() => expect(turns).toHaveLength(3));
    await finishTurn();
    expect(turns).toHaveLength(3);

    // Steps back cancel forward steps still waiting.
    fireEvent.wheel(viewport, { deltaY: 100 });
    fireEvent.wheel(viewport, { deltaY: 100 });
    fireEvent.wheel(viewport, { deltaY: -100 });
    await finishTurn();
    await waitFor(() => expect(turns).toHaveLength(5));
    expect(turns.at(-1)?.direction).toBe("retreat");
    await finishTurn();
    expect(turns).toHaveLength(5);

    // Touchpad movement turns once a whole step has built up.
    for (let step = 0; step < 4; step++) fireEvent.wheel(viewport, { deltaY: 30 });
    expect(turns).toHaveLength(6);
    await finishTurn();
    expect(turns).toHaveLength(6);
  });

  it("drops queued movement on edge arrival and requires fresh wheel input, while arrows bypass the guard", async () => {
    let changed!: (availability: import("./renderer").ReaderPageTurnAvailability) => void;
    let finish!: () => void;
    const advancePage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const retreatPage = vi.fn(async () => undefined);
    const factory: ReaderRendererFactory = () => ({
      mount: async (_host, _signal, publish) => {
        changed = publish;
        publish({ canAdvance: true, canRetreat: true });
        return "ready";
      },
      advancePage,
      retreatPage,
      dispose: vi.fn(),
    });
    renderReader(factory);
    await screen.findByText("Reader ready");
    const viewport = screen.getByRole("main");
    for (let i = 0; i < 5; i++) fireEvent.wheel(viewport, { deltaY: 100 });
    expect(advancePage).toHaveBeenCalledOnce();
    await act(async () => {
      changed({ canAdvance: true, canRetreat: true, advanceChapter: true });
      finish();
    });
    expect(advancePage).toHaveBeenCalledOnce();
    for (let i = 0; i < 2; i++) fireEvent.wheel(viewport, { deltaY: 100 });
    expect(advancePage).toHaveBeenCalledOnce();
    fireEvent.wheel(viewport, { deltaY: 100 });
    expect(advancePage).toHaveBeenCalledTimes(2);
    // A large packet during crossing cannot queue another chapter or page.
    fireEvent.wheel(viewport, { deltaY: 1000 });
    await act(async () => {
      changed({ canAdvance: true, canRetreat: true, retreatChapter: true });
      finish();
    });
    expect(advancePage).toHaveBeenCalledTimes(2);
    fireEvent.wheel(viewport, { deltaY: -100 });
    expect(retreatPage).not.toHaveBeenCalled();
    fireEvent.keyDown(viewport, { key: "ArrowLeft" });
    expect(retreatPage).toHaveBeenCalledOnce();
  });

  it("drops the old book's queued turns and ignores its late completion while the new book turns", async () => {
    let finishOld!: () => void;
    const oldAdvance = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishOld = resolve;
        }),
    );
    const newFinishes: Array<() => void> = [];
    const newAdvance = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          newFinishes.push(resolve);
        }),
    );
    const mount: import("./renderer").ReaderRenderer["mount"] = async (_host, _signal, changed) => {
      changed({ canAdvance: true, canRetreat: true });
      return "ready";
    };
    const oldFactory: ReaderRendererFactory = () => ({
      mount,
      advancePage: oldAdvance,
      retreatPage: vi.fn(),
      dispose: vi.fn(),
    });
    const newFactory: ReaderRendererFactory = () => ({
      mount,
      advancePage: newAdvance,
      retreatPage: vi.fn(),
      dispose: vi.fn(),
    });
    const tree = (factory: ReaderRendererFactory) => (
      <MemoryRouter>
        <AppearanceProvider store={null}>
          <ReaderShell rendererFactory={factory} />
        </AppearanceProvider>
      </MemoryRouter>
    );
    const { rerender } = render(tree(oldFactory));
    await screen.findByText("Reader ready");
    for (let i = 0; i < 5; i++) fireEvent.wheel(screen.getByRole("main"), { deltaY: 100 });
    expect(oldAdvance).toHaveBeenCalledOnce();
    rerender(tree(newFactory));
    await screen.findByText("Reader ready");
    fireEvent.wheel(screen.getByRole("main"), { deltaY: 100 });
    await act(async () => finishOld());
    fireEvent.wheel(screen.getByRole("main"), { deltaY: 100 });
    expect(newAdvance).toHaveBeenCalledOnce();
    await act(async () => newFinishes[0]());
    await waitFor(() => expect(newAdvance).toHaveBeenCalledTimes(2));
    await act(async () => newFinishes[1]());
    expect(oldAdvance).toHaveBeenCalledOnce();
    expect(newAdvance).toHaveBeenCalledTimes(2);
  });

  it("starts autoscroll in the reader and cancels it when its shared saved switch is disabled", async () => {
    const save = vi.fn(async () => undefined);
    const factory: ReaderRendererFactory = () => ({
      mount: async (_host, _signal, changed) => {
        changed({ canAdvance: true, canRetreat: true });
        return "ready";
      },
      ...pageActions,
      dispose: vi.fn(),
    });
    const { unmount } = render(
      <MemoryRouter>
        <AppearanceProvider store={{ load: async () => ({}), save }}>
          <AutoscrollSetting />
          <ReaderShell rendererFactory={factory} />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Reader ready");
    fireEvent.pointerDown(screen.getByRole("main"), { button: 1, clientX: 100, clientY: 100 });
    expect(document.querySelector(".autoscroll-marker")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector(".autoscroll-marker")).toBeNull();
    const user = userEvent.setup();
    // The switch lives in Settings > General alone; Reader appearance does not repeat it.
    await user.click(screen.getByRole("button", { name: "Reader appearance" }));
    expect(
      within(document.querySelector<HTMLElement>(".reader-sidebar")!).queryByRole("button", {
        name: "Middle-click autoscroll",
      }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Middle-click autoscroll" }));
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(
        expect.objectContaining({ middleClickAutoscroll: false }),
      ),
    );
    fireEvent.pointerDown(screen.getByRole("main"), { button: 1 });
    expect(document.querySelector(".autoscroll-marker")).toBeNull();
    unmount();
    expect(document.documentElement).not.toHaveClass("autoscroll-active");
  });

  it("accepts a content wheel turn and excludes sidebar and controls", async () => {
    const advancePage = vi.fn(async () => undefined);
    const retreatPage = vi.fn(async () => undefined);
    const factory: ReaderRendererFactory = () => ({
      mount: async (_host, _signal, changed) => {
        changed({ canAdvance: true, canRetreat: true, forwardArrow: "ArrowLeft" });
        return "ready";
      },
      advancePage,
      retreatPage,
      dispose: vi.fn(),
    });
    const { unmount } = renderReader(factory);
    await waitFor(() => expect(screen.getByText("Reader ready")).toBeInTheDocument());
    const viewport = screen.getByRole("main");
    fireEvent.wheel(viewport, { deltaY: 100 });
    expect(advancePage).toHaveBeenCalledOnce();
    fireEvent.wheel(screen.getByRole("complementary"), { deltaY: -100 });
    fireEvent.wheel(screen.getByRole("button", { name: "Pin reader sidebar" }), { deltaY: -100 });
    expect(retreatPage).not.toHaveBeenCalled();
    viewport.focus();
    await userEvent.setup().keyboard("{ArrowLeft}");
    expect(advancePage).toHaveBeenCalledTimes(2);
    unmount();
    fireEvent.wheel(viewport, { deltaY: 100 });
    expect(advancePage).toHaveBeenCalledTimes(2);
  });

  it("finishes a VN reveal, then reads on, by a click in the book or Space", async () => {
    const revealVnText = vi.fn();
    const advancePage = vi.fn(async () => undefined);
    let changed!: (turns: import("./renderer").ReaderPageTurnAvailability) => void;
    let publish!: (document: Document) => void;
    const turns = (vnRevealing: boolean) => ({
      canAdvance: true,
      canRetreat: false,
      scrollAxis: "vertical" as const,
      vnRevealing,
    });
    render(
      <MemoryRouter>
        <AppearanceProvider
          store={{ load: async () => ({ readerViewMode: "vn" }), save: async () => undefined }}
        >
          <ReaderShell
            rendererFactory={() => ({
              ...pageActions,
              advancePage,
              revealVnText,
              scrollBy: vi.fn(),
              mount: async (_host, _signal, onChanged, onContentDocument) => {
                changed = onChanged;
                publish = onContentDocument!;
                onChanged(turns(true));
                return "ready";
              },
              dispose: vi.fn(),
            })}
          />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Reader ready");
    const frame = document.body.appendChild(document.createElement("iframe"));
    const book = frame.contentDocument!;
    book.body.innerHTML = '<p>text <a href="#note">note</a></p>';
    act(() => publish(book));
    const text = book.querySelector("p")!;
    fireEvent.click(text);
    expect(revealVnText).toHaveBeenCalledTimes(1);
    // A modified click is someone else's.
    fireEvent.click(text, { shiftKey: true });
    fireEvent.keyDown(book.body, { key: " " });
    expect(revealVnText).toHaveBeenCalledTimes(2);
    const viewport = screen.getByRole("main");
    viewport.focus();
    fireEvent.keyDown(viewport, { key: " " });
    expect(revealVnText).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "Show all text" }));
    expect(revealVnText).toHaveBeenCalledTimes(4);
    expect(advancePage).not.toHaveBeenCalled();
    // Once all text shows, a click or Space reads on; a link only follows itself.
    act(() => changed(turns(false)));
    expect(screen.queryByRole("button", { name: "Show all text" })).not.toBeInTheDocument();
    fireEvent.click(book.querySelector("a")!);
    expect(advancePage).not.toHaveBeenCalled();
    fireEvent.click(text);
    await waitFor(() => expect(advancePage).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(viewport, { key: " " });
    await waitFor(() => expect(advancePage).toHaveBeenCalledTimes(2));
    // A held Space does not race through the book.
    fireEvent.keyDown(viewport, { key: " ", repeat: true });
    expect(advancePage).toHaveBeenCalledTimes(2);
    expect(revealVnText).toHaveBeenCalledTimes(4);
    frame.remove();
  });

  it("keeps a VN book's left click for lookup when Mouse click looks words up with it", async () => {
    const advancePage = vi.fn(async () => undefined);
    let publish!: (document: Document) => void;
    render(
      <MemoryRouter>
        <AppearanceProvider
          store={{
            load: async () => ({ readerViewMode: "vn", readerPopupMouseTrigger: "left" }),
            save: async () => undefined,
          }}
        >
          <ReaderShell
            rendererFactory={() => ({
              ...pageActions,
              advancePage,
              revealVnText: vi.fn(),
              scrollBy: vi.fn(),
              mount: async (_host, _signal, onChanged, onContentDocument) => {
                publish = onContentDocument!;
                onChanged({ canAdvance: true, canRetreat: false, scrollAxis: "vertical" });
                return "ready";
              },
              dispose: vi.fn(),
            })}
          />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Reader ready");
    const frame = document.body.appendChild(document.createElement("iframe"));
    const book = frame.contentDocument!;
    book.body.innerHTML = "<p>text</p>";
    act(() => publish(book));
    fireEvent.click(book.querySelector("p")!);
    await new Promise((settle) => setTimeout(settle, 50));
    expect(advancePage).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("main"), { key: " " });
    await waitFor(() => expect(advancePage).toHaveBeenCalledTimes(1));
    frame.remove();
  });

  it("releases input listeners from section documents that were discarded", async () => {
    // jsdom keeps a removed iframe's window; browsers clear defaultView as modeled here.
    const sectionDocument = () =>
      ({
        defaultView: window,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as Document & { defaultView: Window | null };
    let publish!: (document: Document) => void;
    const factory: ReaderRendererFactory = () => ({
      ...pageActions,
      mount: async (_host, _signal, changed, onContentDocument) => {
        publish = onContentDocument!;
        changed({ canAdvance: true, canRetreat: false });
        return "ready";
      },
      dispose: vi.fn(),
    });
    const { unmount } = renderReader(factory);
    await waitFor(() => expect(screen.getByText("Reader ready")).toBeInTheDocument());
    const discarded = sectionDocument();
    const current = sectionDocument();
    publish(discarded);
    expect(discarded.addEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
    discarded.defaultView = null;
    publish(current);

    expect(discarded.removeEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(discarded.removeEventListener).toHaveBeenCalledWith("wheel", expect.any(Function));
    expect(discarded.removeEventListener).toHaveBeenCalledWith("pointerdown", expect.any(Function));
    expect(current.removeEventListener).not.toHaveBeenCalled();
    unmount();
    // Every listener added (input, and the guard against the browser's own surfaces) goes.
    const types = (listener: unknown) =>
      vi
        .mocked(listener as (type: string) => void)
        .mock.calls.map(([type]) => type)
        .sort();
    expect(types(current.addEventListener)).toEqual(
      expect.arrayContaining(["keydown", "pointerover", "dragstart"]),
    );
    expect(types(current.removeEventListener)).toEqual(types(current.addEventListener));
    expect(types(discarded.removeEventListener)).toEqual(types(discarded.addEventListener));
  });

  it("renders nested contents, serializes a jump, and keeps sidebar wheel scrolling local", async () => {
    const user = userEvent.setup();
    let finish!: (success: boolean) => void;
    const jump = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const advance = vi.fn(async () => undefined);
    const factory: ReaderRendererFactory = () => ({
      mount: async (_host, _signal, changed, _document, contents) => {
        changed({ canAdvance: true, canRetreat: true });
        contents?.([
          {
            id: "toc.0",
            label: "第一章",
            navigable: false,
            children: [{ id: "toc.0.0", label: "長い日本語の章題", navigable: true, children: [] }],
          },
        ]);
        return "ready";
      },
      advancePage: advance,
      retreatPage: vi.fn(async () => undefined),
      goToContentsEntry: jump,
      dispose: vi.fn(),
    });
    renderReader(factory);
    await screen.findByText("Reader ready");
    expect(screen.getByText("第一章")).not.toHaveAttribute("role", "button");
    const chapter = screen.getByRole("button", { name: "長い日本語の章題" });
    fireEvent.wheel(screen.getByRole("navigation", { name: "Chapters" }), { deltaY: 400 });
    expect(advance).not.toHaveBeenCalled();
    await user.click(chapter);
    expect(jump).toHaveBeenCalledWith("toc.0.0");
    screen.getByRole("main").focus();
    await user.keyboard("{ArrowRight}");
    fireEvent.wheel(screen.getByRole("main"), { deltaY: 400 });
    expect(advance).not.toHaveBeenCalled();
    finish(true);
    await waitFor(() => expect(chapter).toHaveAttribute("aria-current", "location"));
    await user.keyboard("{ArrowRight}");
    expect(advance).toHaveBeenCalledOnce();
  });

  it("reports a path-safe failed TOC jump and discards an old book completion", async () => {
    let finish!: (success: boolean) => void;
    const old: ReaderRendererFactory = () => ({
      mount: async (_host, _signal, _changed, _document, contents) => {
        contents?.([{ id: "toc.0", label: "Old chapter", navigable: true, children: [] }]);
        return "ready";
      },
      advancePage: vi.fn(),
      retreatPage: vi.fn(),
      goToContentsEntry: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      dispose: vi.fn(),
    });
    const nextBook: ReaderRendererFactory = () => ({
      mount: async (_host, _signal, _changed, _document, contents) => {
        contents?.([{ id: "toc.0", label: "New chapter", navigable: true, children: [] }]);
        return "ready";
      },
      advancePage: vi.fn(),
      retreatPage: vi.fn(),
      goToContentsEntry: vi.fn(async () => false),
      dispose: vi.fn(),
    });
    const tree = (factory: ReaderRendererFactory) => (
      <MemoryRouter>
        <AppearanceProvider>
          <ReaderShell rendererFactory={factory} />
        </AppearanceProvider>
      </MemoryRouter>
    );
    const view = render(tree(old));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Old chapter" }));
    view.rerender(tree(nextBook));
    finish(true);
    await screen.findByRole("button", { name: "New chapter" });
    expect(screen.queryByText("Old chapter")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chapter" })).not.toHaveAttribute("aria-current");
    await userEvent.setup().click(screen.getByRole("button", { name: "New chapter" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open this entry");
    expect(screen.queryByText(/Text\/|epubcfi/i)).not.toBeInTheDocument();
    view.unmount();
  });

  function contentsReader(results: boolean[], forwardArrow: "ArrowLeft" | "ArrowRight") {
    const finishes: ((success: boolean) => void)[] = [];
    const jump = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishes.push(resolve);
        }),
    );
    const advance = vi.fn(async () => undefined);
    const factory: ReaderRendererFactory = () => ({
      mount: async (_host, _signal, changed, _document, contents) => {
        changed({ canAdvance: true, canRetreat: true, forwardArrow });
        contents?.(
          ["One", "Two", "Three"].map((label, index) => ({
            id: `toc.${index}`,
            label,
            navigable: true,
            children: [],
          })),
        );
        return "ready";
      },
      advancePage: advance,
      retreatPage: vi.fn(async () => undefined),
      goToContentsEntry: jump,
      dispose: vi.fn(),
    });
    const settle = async () => {
      const finish = finishes.shift()!;
      finish(results.shift()!);
      await waitFor(() => expect(document.querySelector("[aria-disabled]")).toBeNull());
    };
    return { factory, jump, advance, settle };
  }

  it("moves focus to the reading area after mouse and keyboard contents jumps", async () => {
    const user = userEvent.setup();
    const { factory, jump, advance, settle } = contentsReader([true, true, true], "ArrowLeft");
    renderReader(factory);
    await screen.findByText("Reader ready");
    const main = screen.getByRole("main");

    const one = screen.getByRole("button", { name: "One" });
    await user.click(one);
    // The chosen entry keeps focus while the jump is pending.
    expect(one).toHaveFocus();
    expect(one).toHaveAttribute("aria-disabled", "true");
    await settle();
    expect(main).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(advance).toHaveBeenCalledOnce();

    // The contents tree stays keyboard-operable after focus moved to the book.
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Three" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Two" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(jump).toHaveBeenLastCalledWith("toc.1");
    await settle();
    expect(main).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(advance).toHaveBeenCalledTimes(2);

    // A reader who moves focus elsewhere during the jump keeps it there.
    await user.click(screen.getByRole("button", { name: "Three" }));
    const pin = screen.getByRole("button", { name: "Pin reader sidebar" });
    pin.focus();
    await settle();
    expect(pin).toHaveFocus();
    expect(screen.getByRole("button", { name: "Three" })).toHaveAttribute(
      "aria-current",
      "location",
    );
  });

  it("keeps focus on the entry after a failed contents jump", async () => {
    const user = userEvent.setup();
    const { factory, advance, settle } = contentsReader([false], "ArrowRight");
    renderReader(factory);
    await screen.findByText("Reader ready");
    const two = screen.getByRole("button", { name: "Two" });
    two.focus();
    await user.keyboard("{Enter}");
    await settle();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open this entry");
    expect(two).toHaveFocus();
    expect(two).not.toHaveAttribute("aria-current");
    await user.keyboard("{ArrowRight}");
    expect(advance).not.toHaveBeenCalled();
  });

  it("hides the compact sidebar after a contents jump and turns pages", async () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
    try {
      const user = userEvent.setup();
      const { factory, advance, settle } = contentsReader([true], "ArrowRight");
      const { container } = renderReader(factory);
      await screen.findByText("Reader ready");
      await user.click(container.querySelector(".reader-sidebar-hotspot")!);
      await user.click(screen.getByRole("button", { name: "Two" }));
      await settle();
      expect(screen.getByRole("complementary", { name: "Reader sidebar" })).toHaveClass(
        "reader-sidebar--hidden",
      );
      expect(screen.getByRole("main")).toHaveFocus();
      await user.keyboard("{ArrowRight}");
      expect(advance).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
    }
  });

  it("restores through the book's store, saves settled positions, and flushes on switch", async () => {
    const at = (progress: number): ReaderLocator => ({ spineIndex: 1, progress });
    const bindings: ReaderPositionBinding[] = [];
    const factory = (): ReaderRendererFactory => () => ({
      ...pageActions,
      mount: async (_host, _signal, _turns, _document, _contents, position) => {
        if (position) bindings.push(position);
        return "ready";
      },
      dispose: vi.fn(),
    });
    const store = (saved: ReaderLocator | null) => ({
      load: vi.fn(async () => saved),
      save: vi.fn(async (_locator: ReaderLocator) => undefined),
    });
    const firstStore = store(at(0.3));
    const secondStore = store(null);
    const tree = (rendererFactory: ReaderRendererFactory, positionStore: ReaderPositionStore) => (
      <MemoryRouter>
        <AppearanceProvider>
          <ReaderShell rendererFactory={rendererFactory} positionStore={positionStore} />
        </AppearanceProvider>
      </MemoryRouter>
    );
    const view = render(tree(factory(), firstStore));
    await waitFor(() => expect(bindings).toHaveLength(1));
    expect(await bindings[0].initial).toEqual(at(0.3));

    bindings[0].onLocationChanged(at(0.4));
    await waitFor(() => expect(firstStore.save).toHaveBeenCalledWith(at(0.4)));
    // This position is still inside the write throttle when the book is switched.
    bindings[0].onLocationChanged(at(0.5));
    view.rerender(tree(factory(), secondStore));
    await waitFor(() => expect(firstStore.save).toHaveBeenLastCalledWith(at(0.5)));
    await waitFor(() => expect(bindings).toHaveLength(2));
    expect(await bindings[1].initial).toBeNull();

    // A late location from the old book is never written for either catalog ID.
    bindings[0].onLocationChanged(at(0.9));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstStore.save).toHaveBeenCalledTimes(2);
    expect(secondStore.save).not.toHaveBeenCalled();
    view.unmount();
  });

  it("flushes a pending save when the Reader is disposed and ignores later locations", async () => {
    let binding: ReaderPositionBinding | undefined;
    const factory: ReaderRendererFactory = () => ({
      ...pageActions,
      mount: async (_host, _signal, _turns, _document, _contents, position) => {
        binding = position;
        return "ready";
      },
      dispose: vi.fn(),
    });
    const positionStore = {
      load: vi.fn(async () => Promise.reject(Error("storage"))),
      save: vi.fn(async (_locator: ReaderLocator) => undefined),
    };
    const view = render(
      <MemoryRouter>
        <AppearanceProvider>
          <ReaderShell rendererFactory={factory} positionStore={positionStore} />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("Reader ready")).toBeInTheDocument());
    expect(await binding!.initial).toBeNull();
    binding!.onLocationChanged({ spineIndex: 0, progress: 0.1 });
    await waitFor(() => expect(positionStore.save).toHaveBeenCalledOnce());
    binding!.onLocationChanged({ spineIndex: 2, progress: 0.6 });
    view.unmount();
    await waitFor(() =>
      expect(positionStore.save).toHaveBeenLastCalledWith({ spineIndex: 2, progress: 0.6 }),
    );
    binding!.onLocationChanged({ spineIndex: 3, progress: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(positionStore.save).toHaveBeenCalledTimes(2);
  });

  it("saves where an unsettled scroll stopped when the window or the book closes", async () => {
    const at = (progress: number): ReaderLocator => ({ spineIndex: 1, progress });
    let binding: ReaderPositionBinding | undefined;
    let shown = at(0.4);
    const factory: ReaderRendererFactory = () => ({
      ...pageActions,
      mount: async (_host, _signal, _turns, _document, _contents, position) => {
        binding = position;
        return "ready";
      },
      // The renderer publishes the place its scroll stopped at before the scroll settles.
      settlePosition: vi.fn(() => binding!.onLocationChanged(shown)),
      dispose: vi.fn(),
    });
    const positionStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async (_locator: ReaderLocator) => undefined),
    };
    const registered = vi.mocked(registerWindowFlush).mock.calls.length;
    const view = render(
      <MemoryRouter>
        <AppearanceProvider>
          <ReaderShell rendererFactory={factory} positionStore={positionStore} />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Reader ready");
    // Closing the window runs every flusher registered since the Reader opened.
    const flushers = vi
      .mocked(registerWindowFlush)
      .mock.calls.slice(registered)
      .map(([flush]) => flush);
    await act(async () => {
      await Promise.all(flushers.map((flush) => flush()));
    });
    expect(positionStore.save).toHaveBeenLastCalledWith(at(0.4));

    shown = at(0.6);
    view.unmount();
    await waitFor(() => expect(positionStore.save).toHaveBeenLastCalledWith(at(0.6)));
  });

  it("records whole-book progress for the Library, latest first, and flushes it on close", async () => {
    let publish!: (progress: ReaderBookProgress) => void;
    const factory: ReaderRendererFactory = () => ({
      ...pageActions,
      mount: async (_host, _signal, _turns, _document, _contents, _position, onProgress) => {
        publish = onProgress!;
        return "ready";
      },
      dispose: vi.fn(),
    });
    const positionStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async (_locator: ReaderLocator) => undefined),
      saveProgress: vi.fn(async (_progress: object) => undefined),
    };
    const view = render(
      <MemoryRouter>
        <AppearanceProvider>
          <ReaderShell rendererFactory={factory} positionStore={positionStore} />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Reader ready");
    // Nothing is recorded before the book is counted.
    act(() =>
      publish({ unit: "characters", current: 0, total: 0, chapter: { current: 0, total: 0 } }),
    );
    act(() =>
      publish({
        unit: "characters",
        current: 100,
        total: 1000,
        chapter: { current: 5, total: 50 },
      }),
    );
    await waitFor(() =>
      expect(positionStore.saveProgress).toHaveBeenCalledWith({
        unit: "characters",
        current: 100,
        total: 1000,
      }),
    );
    act(() =>
      publish({
        unit: "characters",
        current: 400,
        total: 1000,
        chapter: { current: 5, total: 50 },
      }),
    );
    view.unmount();
    await waitFor(() =>
      expect(positionStore.saveProgress).toHaveBeenLastCalledWith({
        unit: "characters",
        current: 400,
        total: 1000,
      }),
    );
    expect(positionStore.saveProgress).toHaveBeenCalledTimes(2);
  });

  it("shows the book's card with its series and progress, and tools that return to the contents", async () => {
    const user = userEvent.setup();
    let publish!: (progress: ReaderBookProgress) => void;
    const factory: ReaderRendererFactory = () => ({
      ...pageActions,
      mount: async (_host, _signal, _turns, _document, _contents, _position, onProgress) => {
        publish = onProgress!;
        return "ready";
      },
      dispose: vi.fn(),
    });
    const book = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "星降る町の手紙",
      author: "森川 遥",
      availability: "available" as const,
      hasCover: false,
    };
    const view = render(
      <MemoryRouter>
        <AppearanceProvider>
          <ReaderShell
            rendererFactory={factory}
            identity={{
              status: "book",
              book: { ...book, series: "星降る町の手紙", seriesIndex: 2 },
              cover: null,
            }}
          />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Reader ready");
    const sidebar = screen.getByRole("complementary", { name: "Reader sidebar" });
    expect(within(sidebar).getByRole("heading", { name: "星降る町の手紙" })).toBeInTheDocument();
    expect(within(sidebar).getByText("森川 遥")).toBeInTheDocument();
    // A series is a group: its name only, never a number.
    expect(within(sidebar).getByText("星降る町の手紙", { selector: "p" })).toBeInTheDocument();
    expect(sidebar).not.toHaveTextContent("· 2");
    // No progress until the book is counted.
    expect(within(sidebar).queryByRole("progressbar")).not.toBeInTheDocument();
    act(() =>
      publish({
        unit: "characters",
        current: 22104,
        total: 189420,
        chapter: { current: 100, total: 2000 },
      }),
    );
    expect(within(sidebar).getByRole("progressbar", { name: "Book progress" })).toHaveAttribute(
      "aria-valuenow",
      "11",
    );
    expect(sidebar).toHaveTextContent(
      `${(22104).toLocaleString()} / ${(189420).toLocaleString()} Ch. · 11%`,
    );
    expect(within(sidebar).getByLabelText("Chapter 5% read")).toBeInTheDocument();

    // The contents show by default; each tool opens its panel, and a second press returns.
    const tools = within(sidebar).getByRole("group", { name: "Book tools" });
    expect(
      within(tools)
        .getAllByRole("button")
        .map((tool) => tool.textContent),
    ).toEqual(["Images", "Bookmarks", "Notes", "Search"]);
    const search = within(tools).getByRole("button", { name: "Search" });
    await user.click(search);
    expect(search).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("heading", { name: "Chapters" })).not.toBeInTheDocument();
    await user.click(search);
    expect(search).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("heading", { name: "Chapters" })).toBeInTheDocument();
    expect(search).toHaveFocus();

    // A book outside any series shows no series line.
    view.rerender(
      <MemoryRouter>
        <AppearanceProvider>
          <ReaderShell
            rendererFactory={factory}
            identity={{ status: "book", book: { ...book, series: null }, cover: null }}
          />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    expect(within(sidebar).queryByText(/· 2$/)).not.toBeInTheDocument();
  });

  it("shows book and chapter progress in the footer once the book is counted", async () => {
    let publish!: (progress: ReaderBookProgress) => void;
    const factory: ReaderRendererFactory = () => ({
      ...pageActions,
      mount: async (_host, _signal, _turns, _document, _contents, _position, onProgress) => {
        publish = onProgress!;
        return "ready";
      },
      dispose: vi.fn(),
    });
    renderReader(factory, false, {
      readerShowChapterPosition: true,
      readerShowChapterPercentage: true,
    });
    await screen.findByText("Reader ready");
    // No numbers until the adapter has counted the book.
    expect(screen.queryByRole("group", { name: "Book progress" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Chapter progress" })).not.toBeInTheDocument();
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();

    act(() =>
      publish({
        unit: "characters",
        current: 12345,
        total: 234567,
        chapter: { current: 2345, total: 20000 },
      }),
    );
    const progress = screen.getByRole("group", { name: "Book progress" });
    expect(progress).toHaveTextContent(
      `${(12345).toLocaleString()} / ${(234567).toLocaleString()} Ch.`,
    );
    expect(progress).toHaveTextContent(/5%$/);
    const chapter = screen.getByRole("group", { name: "Chapter progress" });
    expect(chapter).toHaveTextContent(
      `${(2345).toLocaleString()} / ${(20000).toLocaleString()} Ch.Chapter 11%`,
    );
    // Book characters, book %, chapter characters, chapter %.
    expect(
      progress.compareDocumentPosition(chapter) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("Reader ready")).toBeInTheDocument();

    act(() =>
      publish({
        unit: "characters",
        current: 234000,
        total: 234567,
        chapter: { current: 19999, total: 20000 },
      }),
    );
    expect(progress).toHaveTextContent(/99%$/);
    expect(chapter).toHaveTextContent(/Chapter 99%$/);
    act(() =>
      publish({
        unit: "characters",
        current: 234567,
        total: 234567,
        chapter: { current: 20000, total: 20000 },
      }),
    );
    expect(progress).toHaveTextContent(/100%$/);
    expect(chapter).toHaveTextContent(/Chapter 100%$/);
    // A new chapter starts again from zero.
    act(() =>
      publish({
        unit: "characters",
        current: 214567,
        total: 234567,
        chapter: { current: 0, total: 500 },
      }),
    );
    expect(chapter).toHaveTextContent(`0 / 500 Ch.Chapter 0%`);
    // Books counted in words say Wo. instead of Ch.
    act(() =>
      publish({ unit: "words", current: 6500, total: 65000, chapter: { current: 50, total: 200 } }),
    );
    expect(progress).toHaveTextContent(
      `${(6500).toLocaleString()} / ${(65000).toLocaleString()} Wo.10%`,
    );
    expect(chapter).toHaveTextContent(`50 / 200 Wo.Chapter 25%`);
    expect(screen.queryByTitle("characters")).not.toBeInTheDocument();
  });

  it("marks the contents entry of the chapter being read", async () => {
    const user = userEvent.setup();
    let publish!: (progress: ReaderBookProgress) => void;
    const at = (entryId?: string): ReaderBookProgress => ({
      unit: "characters",
      current: 10,
      total: 100,
      chapter: { current: 0, total: 50, ...(entryId && { entryId }) },
    });
    const factory: ReaderRendererFactory = () => ({
      ...pageActions,
      mount: async (_host, _signal, changed, _document, contents, _position, onProgress) => {
        publish = onProgress!;
        changed({ canAdvance: true, canRetreat: true });
        contents?.([
          {
            id: "toc.0",
            label: "Part",
            navigable: true,
            children: [{ id: "toc.0.0", label: "Chapter 1", navigable: true, children: [] }],
          },
          { id: "toc.1", label: "Chapter 2", navigable: true, children: [] },
        ]);
        return "ready";
      },
      // Like the adapter, a jump publishes its settled position with the chosen entry.
      goToContentsEntry: async (entryId) => {
        publish(at(entryId));
        return true;
      },
      dispose: vi.fn(),
    });
    renderReader(factory);
    await screen.findByText("Reader ready");
    const marked = () =>
      Array.from(document.querySelectorAll('[aria-current="location"]'), (entry) =>
        entry.getAttribute("aria-label"),
      );
    // Nothing is marked until the opened or resumed position is known.
    expect(marked()).toEqual([]);

    act(() => publish(at("toc.0.0")));
    expect(screen.getByRole("button", { name: "Chapter 1" })).toHaveAttribute(
      "aria-current",
      "location",
    );
    expect(marked()).toEqual(["Chapter 1"]);
    // Turning into the next chapter moves the mark.
    act(() => publish(at("toc.1")));
    expect(marked()).toEqual(["Chapter 2"]);
    // The contents read as a timeline, and the sidebar's foot names the chapter and its share.
    const progressOf = (name: string) =>
      screen.getByRole("button", { name }).closest("li")?.getAttribute("data-progress");
    expect(["Part", "Chapter 1", "Chapter 2"].map(progressOf)).toEqual(["read", "read", "current"]);
    const status = document.querySelector(".reader-sidebar__status") as HTMLElement;
    expect(within(status).getByText("Chapter 2")).toBeInTheDocument();
    expect(within(status).getByLabelText("Chapter 0% read")).toHaveTextContent("0%");
    expect(within(status).getByRole("progressbar", { name: "Book progress" })).toHaveAttribute(
      "aria-valuenow",
      "10",
    );
    // Text before the first destination has no entry.
    act(() => publish(at()));
    expect(marked()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Part" }));
    await waitFor(() => expect(marked()).toEqual(["Part"]));
    // The next settled position replaces the chosen entry.
    act(() => publish(at("toc.0.0")));
    expect(marked()).toEqual(["Chapter 1"]);
  });

  it("clears progress for a new book and ignores a late old-book value", async () => {
    const publishers: Array<(progress: ReaderBookProgress) => void> = [];
    const factory = (): ReaderRendererFactory => () => ({
      ...pageActions,
      mount: async (_host, _signal, _turns, _document, _contents, _position, onProgress) => {
        publishers.push(onProgress!);
        return "ready";
      },
      dispose: vi.fn(),
    });
    const tree = (rendererFactory: ReaderRendererFactory) => (
      <MemoryRouter>
        <AppearanceProvider
          store={{
            load: async () => ({
              readerShowChapterPosition: true,
              readerShowChapterPercentage: true,
            }),
            save: vi.fn(),
          }}
        >
          <ReaderShell rendererFactory={rendererFactory} />
        </AppearanceProvider>
      </MemoryRouter>
    );
    const view = render(tree(factory()));
    await screen.findByText("Reader ready");
    act(() =>
      publishers[0]({
        unit: "characters",
        current: 50,
        total: 100,
        chapter: { current: 5, total: 10 },
      }),
    );
    expect(screen.getByRole("group", { name: "Book progress" })).toHaveTextContent("50%");
    expect(screen.getByRole("group", { name: "Chapter progress" })).toHaveTextContent("50%");

    view.rerender(tree(factory()));
    await waitFor(() => expect(publishers).toHaveLength(2));
    await screen.findByText("Reader ready");
    expect(screen.queryByRole("group", { name: "Book progress" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Chapter progress" })).not.toBeInTheDocument();
    act(() =>
      publishers[0]({
        unit: "characters",
        current: 90,
        total: 100,
        chapter: { current: 9, total: 10 },
      }),
    );
    expect(screen.queryByRole("group", { name: "Book progress" })).not.toBeInTheDocument();
    act(() =>
      publishers[1]({
        unit: "characters",
        current: 1,
        total: 400,
        chapter: { current: 1, total: 40 },
      }),
    );
    expect(screen.getByRole("group", { name: "Book progress" })).toHaveTextContent(/0%$/);
    expect(screen.getByRole("group", { name: "Chapter progress" })).toHaveTextContent(
      /Chapter 2%$/,
    );
    view.unmount();
  });

  describe("Appearance", () => {
    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }

    /** The presentation every book gets until the reader changes something. */
    const shown = {
      vnParagraphs: 1,
      vnTextSpeed: 40,
      fontPair: {
        asian: { source: "google", id: "noto-sans-jp" },
        western: { source: "preset", id: "georgia" },
        downloaded: [],
        weights: { western: 400, asian: 400 },
      },
      fontFamilyGroup1: "yu-mincho",
      fontFamilyGroup2: "segoe-ui",
      fontSize: 16,
      lineHeight: 1.65,
      fontWeight: 400,
      paragraphIndent: 1,
      paragraphMargin: 0,
      maxWidth: 4000,
      pageLayout: "double",
      maxHeight: 4000,
      writingMode: "horizontal",
      textOrientation: "mixed",
      textJustification: false,
      prettyTextWrap: false,
      letterSpacing: 0,
      wordSpacing: 0,
      hideFurigana: false,
      furiganaStyle: "hide",
      blurImage: false,
      blurMode: "all",
      // Hojicha's colors.
      textColor: "#3e2f22",
      selectionColor: "#d4b98e",
      highlightColor: "#d4b98e",
    } satisfies ReaderPresentation;

    const dusk = {
      id: "0b8a3c2e-4d5f-4a6b-8c7d-9e0f1a2b3c4d",
      name: "Dusk",
      background: "#101820",
      text: "#f0e6d2",
      selection: "#445566",
      highlight: "#778899",
      footerText: "#a09880",
    };

    /** The reading area's page, text, and footer text colors. */
    function readingAreaColors() {
      const area = document.querySelector<HTMLElement>(".reader-reading-area")!;
      return ["--reader-page", "--reader-ink", "--reader-footer-text"].map((name) =>
        area.style.getPropertyValue(name),
      );
    }

    /** A stepper's shown value: the number in its field and the unit beside it. */
    function shownValue(group: HTMLElement) {
      const field = within(group).getByRole<HTMLInputElement>("textbox");
      return field.value + (field.nextElementSibling?.textContent ?? "");
    }

    function readerWithAppearance(
      factory: ReaderRendererFactory,
      saved: Partial<AppearancePreferences> = {},
      identity?: ReaderIdentity,
    ) {
      return render(
        <MemoryRouter>
          <AppearanceProvider store={{ load: async () => saved, save: async () => undefined }}>
            <ReaderShell rendererFactory={factory} identity={identity} />
          </AppearanceProvider>
        </MemoryRouter>,
      );
    }

    it("opens the Appearance panel and changes the font size through the renderer", async () => {
      const user = userEvent.setup();
      const presentations: Array<ReaderPresentation | undefined> = [];
      const setPresentation = vi.fn(async (_presentation: ReaderPresentation) => undefined);
      const factory: ReaderRendererFactory = () => ({
        ...pageActions,
        mount: async (...args) => {
          presentations.push(args[7]);
          return "ready";
        },
        setPresentation,
        dispose: vi.fn(),
      });
      renderReader(factory);
      await screen.findByText("Reader ready");
      expect(presentations).toEqual([shown]);

      const entry = screen.getByRole("button", { name: "Reader appearance" });
      expect(entry).toHaveAttribute("aria-pressed", "false");
      await user.click(entry);
      expect(entry).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Chapters" })).not.toBeInTheDocument();
      const size = screen.getByRole("group", { name: "Font size" });
      expect(size).toHaveTextContent("16 px");

      await user.click(screen.getByRole("button", { name: "Increase Font size" }));
      expect(size).toHaveTextContent("17 px");
      await waitFor(() => expect(setPresentation).toHaveBeenCalledWith({ ...shown, fontSize: 17 }));
      await user.click(screen.getByRole("button", { name: "Decrease Font size" }));
      await waitFor(() => expect(setPresentation).toHaveBeenLastCalledWith(shown));
      expect(size).toHaveTextContent("16 px");

      // The panel's back control returns to the reader controls and keeps focus nearby.
      await user.click(screen.getByRole("button", { name: "Back to reader controls" }));
      expect(screen.getByRole("heading", { name: "Chapters" })).toBeInTheDocument();
      expect(entry).toHaveAttribute("aria-pressed", "false");
      expect(entry).toHaveFocus();
      // A second press of the entry also returns to the reader controls.
      await user.click(entry);
      await user.click(entry);
      expect(screen.getByRole("heading", { name: "Chapters" })).toBeInTheDocument();
    });

    it("saves both ordered font choices without remounting and explains fallbacks", async () => {
      const user = userEvent.setup();
      const mount = vi.fn(async () => "ready" as const);
      const setPresentation = vi.fn(async () => undefined);
      const save = vi.fn(async () => undefined);
      render(
        <MemoryRouter>
          <AppearanceProvider store={{ load: async () => ({}), save }}>
            <ReaderShell
              rendererFactory={() => ({ ...pageActions, mount, setPresentation, dispose: vi.fn() })}
            />
          </AppearanceProvider>
        </MemoryRouter>,
      );
      await screen.findByText("Reader ready");
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      const first = screen.getByRole("combobox", { name: "Western font" });
      const second = screen.getByRole("combobox", { name: "Asian font" });
      expect(first.compareDocumentPosition(second)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(
        second.compareDocumentPosition(screen.getByRole("combobox", { name: "Asian font weight" })),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      // Each font menu opens with its search focused and returns focus once a font is chosen.
      await user.click(screen.getByRole("button", { name: "Choose Western font" }));
      await user.click(screen.getByRole("option", { name: "Segoe UI" }));
      await user.clear(second);
      await user.type(second, "System serif");
      await user.keyboard("{Enter}");
      expect(second).toHaveFocus();
      await waitFor(() =>
        expect(setPresentation).toHaveBeenLastCalledWith({
          ...shown,
          fontPair: {
            asian: { source: "preset", id: "serif" },
            western: { source: "preset", id: "segoe-ui" },
            downloaded: [],
            weights: { western: 400, asian: 400 },
          },
        }),
      );
      await waitFor(() =>
        expect(save).toHaveBeenLastCalledWith(
          expect.objectContaining({
            readerWesternFont: { source: "preset", id: "segoe-ui" },
            readerAsianFont: { source: "preset", id: "serif" },
          }),
        ),
      );
      // The panel explains nothing it shows: no notes under its settings.
      expect(screen.queryByText(/Western text and Asian characters/)).not.toBeInTheDocument();
      expect(mount).toHaveBeenCalledOnce();
    });

    it("keeps the size within its range with the limit button still focused", async () => {
      const user = userEvent.setup();
      renderReader();
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      const decrease = screen.getByRole("button", { name: "Decrease Font size" });
      for (let step = 0; step < 8; step++) await user.click(decrease);
      expect(screen.getByRole("group", { name: "Font size" })).toHaveTextContent("8 px");
      expect(decrease).toHaveAttribute("aria-disabled", "true");
      expect(decrease).toHaveFocus();
      await user.click(decrease);
      expect(screen.getByRole("group", { name: "Font size" })).toHaveTextContent("8 px");
    });

    it("queues a size change behind a turn, applies the latest size, and holds turns meanwhile", async () => {
      const user = userEvent.setup();
      const turn = deferred();
      const reflow = deferred();
      const advancePage = vi.fn(() => turn.promise);
      const setPresentation = vi.fn(() => reflow.promise);
      const jump = vi.fn(async () => true);
      const factory: ReaderRendererFactory = () => ({
        ...pageActions,
        advancePage,
        mount: async (_host, _signal, changed, _document, contents) => {
          changed({ canAdvance: true, canRetreat: true });
          contents?.([{ id: "toc.0", label: "Chapter", navigable: true, children: [] }]);
          return "ready";
        },
        goToContentsEntry: jump,
        setPresentation,
        dispose: vi.fn(),
      });
      renderReader(factory);
      await screen.findByText("Reader ready");
      screen.getByRole("main").focus();
      await user.keyboard("{ArrowRight}");
      expect(advancePage).toHaveBeenCalledOnce();

      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      const increase = screen.getByRole("button", { name: "Increase Font size" });
      await user.click(increase);
      await user.click(increase);
      expect(setPresentation).not.toHaveBeenCalled();
      await act(async () => turn.resolve());
      await waitFor(() => expect(setPresentation).toHaveBeenCalledOnce());
      expect(setPresentation).toHaveBeenCalledWith({ ...shown, fontSize: 18 });

      // The book is reflowing: turns and contents jumps wait for it.
      screen.getByRole("main").focus();
      await user.keyboard("{ArrowRight}");
      expect(advancePage).toHaveBeenCalledOnce();
      await user.click(screen.getByRole("button", { name: "Back to reader controls" }));
      const chapter = screen.getByRole("button", { name: "Chapter" });
      expect(chapter).toHaveAttribute("aria-disabled", "true");
      await user.click(chapter);
      expect(jump).not.toHaveBeenCalled();

      await act(async () => reflow.resolve());
      await waitFor(() => expect(chapter).not.toHaveAttribute("aria-disabled"));
      screen.getByRole("main").focus();
      await user.keyboard("{ArrowRight}");
      expect(advancePage).toHaveBeenCalledTimes(2);
      expect(setPresentation).toHaveBeenCalledOnce();
    });

    it("applies a size chosen while the book opens once it is ready, and opens the next book at it", async () => {
      const user = userEvent.setup();
      const opened = deferred();
      const presentations: Array<ReaderPresentation | undefined> = [];
      const setPresentation = vi.fn(async (_presentation: ReaderPresentation) => undefined);
      const factory = (): ReaderRendererFactory => () => ({
        ...pageActions,
        mount: async (...args) => {
          presentations.push(args[7]);
          if (presentations.length === 1) await opened.promise;
          return "ready";
        },
        setPresentation,
        dispose: vi.fn(),
      });
      const tree = (rendererFactory: ReaderRendererFactory) => (
        <MemoryRouter>
          <AppearanceProvider>
            <ReaderShell rendererFactory={rendererFactory} />
          </AppearanceProvider>
        </MemoryRouter>
      );
      const view = render(tree(factory()));
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      await user.click(screen.getByRole("button", { name: "Increase Font size" }));
      expect(setPresentation).not.toHaveBeenCalled();
      await act(async () => opened.resolve());
      await screen.findByText("Reader ready");
      await waitFor(() => expect(setPresentation).toHaveBeenCalledWith({ ...shown, fontSize: 17 }));

      // The size is session-wide: the next book opens at it without another reflow.
      view.rerender(tree(factory()));
      await waitFor(() => expect(presentations).toHaveLength(2));
      expect(presentations[1]).toEqual({ ...shown, fontSize: 17 });
      await screen.findByText("Reader ready");
      expect(setPresentation).toHaveBeenCalledOnce();
      view.unmount();
    });

    it("says the book is being laid out while a change reflows it", async () => {
      const user = userEvent.setup();
      const reflow = deferred();
      const setPresentation = vi.fn(() => reflow.promise);
      renderReader(() => ({
        ...pageActions,
        mount: async () => "ready",
        setPresentation,
        dispose: vi.fn(),
      }));
      await screen.findByText("Reader ready");
      expect(screen.queryByText("Laying out the book")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      await user.click(screen.getByRole("button", { name: "Increase Font size" }));
      expect(await screen.findByText("Laying out the book")).toHaveAttribute("role", "status");
      await act(async () => reflow.resolve());
      await waitFor(() => expect(screen.queryByText("Laying out the book")).toBeNull());
    });

    it("says a continuous book is laid out whole while it opens", async () => {
      const opened = deferred();
      readerWithAppearance(
        () => ({
          ...pageActions,
          mount: async () => {
            await opened.promise;
            return "ready";
          },
          dispose: vi.fn(),
        }),
        { readerViewMode: "continuous" },
        {
          status: "book",
          book: {
            id: "11111111-1111-4111-8111-111111111111",
            title: "A long book",
            author: "An author",
            availability: "available",
            hasCover: false,
          },
          cover: null,
        },
      );
      expect(await screen.findByText("Preparing your book")).toBeInTheDocument();
      expect(screen.getByText("Laying out the whole book.")).toBeInTheDocument();
      await act(async () => opened.resolve());
      await waitFor(() => expect(screen.queryByText("Laying out the whole book.")).toBeNull());
    });

    it("shows every setting at its default, in order, without book or automatic values", async () => {
      const user = userEvent.setup();
      renderReader(() => ({ ...pageActions, mount: async () => "ready", dispose: vi.fn() }));
      await screen.findByText("Reader ready");
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      const typography = screen.getByRole("region", { name: "Typography" });
      const pageFlow = screen.getByRole("region", { name: "Page flow" });

      // Theme leads the panel with its swatches, Hojicha chosen, and no editor or description.
      const theme = screen.getByRole("region", { name: "Theme" });
      expect(theme.compareDocumentPosition(typography)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(within(theme).getByRole("heading", { name: "Theme" })).toBeInTheDocument();
      expect(theme).not.toHaveTextContent("Reader-only colors");
      expect(
        within(theme)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual([
        "あPaper",
        "あSepia",
        "あNight",
        "あSakura",
        "あMatcha",
        "あHojicha",
        "あSolarized",
        "あNord",
        "あGruvbox",
        "あRosé Pine",
        "あTokyo Night",
        "あLatte",
        "あFrappé",
        "あMacchiato",
        "あMocha",
        "あCustom: new theme",
      ]);
      expect(within(theme).getByRole("button", { name: "Hojicha" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(within(theme).queryByRole("textbox")).toBeNull();
      expect(readingAreaColors()).toEqual(["#ebdfcb", "#3e2f22", "#807262"]);

      const weight = within(typography).getByRole("combobox", { name: "Western font weight" });
      expect(weight).toHaveValue("400");
      expect(
        within(weight)
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual(["100", "200", "300", "400", "500", "600", "700", "800", "900"]);
      const typographySteppers = within(typography).getAllByRole("group");
      expect(typographySteppers.map(shownValue)).toEqual(["16px", "1.65", "1em", "0px", "0px"]);
      expect(within(typography).getByRole("group", { name: "Paragraph indentation" })).toBe(
        typographySteppers[2],
      );
      expect(within(typography).getByRole("group", { name: "Letter spacing" })).toBe(
        typographySteppers[3],
      );
      expect(within(typography).getByRole("group", { name: "Word spacing" })).toBe(
        typographySteppers[4],
      );

      const choices = ["View mode", "Writing mode", "Text orientation"].map((name) =>
        within(pageFlow).getByRole("group", { name }),
      );
      const steppers = [
        "Paragraph margin",
        "Maximum text width",
        "Reader max height",
        "Wheel step",
      ].map((name) => within(pageFlow).getByRole("group", { name }));
      for (const [before, after] of [...choices, ...steppers].map((group, index, all) => [
        group,
        all[index + 1],
      ]))
        if (after)
          expect(before.compareDocumentPosition(after)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(
        within(choices[1])
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["Horizontal", "Vertical"]);
      expect(within(choices[1]).getByRole("button", { name: "Horizontal" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        within(choices[2])
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["Mixed", "Upright"]);
      expect(within(choices[2]).getByRole("button", { name: "Mixed" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(steppers.map(shownValue)).toEqual(["0px", "4000px", "4000px", "100px"]);

      // Text behavior follows Page flow with paragraph choices before Hide furigana.
      const textBehavior = screen.getByRole("region", { name: "Text behavior" });
      expect(pageFlow.compareDocumentPosition(textBehavior)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(
        within(textBehavior)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["Text justification", "Pretty text wrap", "Hide furigana"]);
      expect(within(textBehavior).getByRole("button", { name: "Hide furigana" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );

      // Images follows Text behavior and holds only Blur image, off.
      const images = screen.getByRole("region", { name: "Images" });
      expect(textBehavior.compareDocumentPosition(images)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(images).not.toHaveTextContent("Spoiler-sensitive");
      expect(
        within(images)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["Blur image", "All", "After ToC"]);
      expect(within(images).getByRole("button", { name: "Blur image" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(screen.queryByRole("button", { name: /^Reset/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /^(Book|Auto|Manual|Default)$/ })).toBeNull();
    });

    it("passes every changed setting to the renderer along with the others", async () => {
      const user = userEvent.setup();
      const setPresentation = vi.fn(async (_presentation: ReaderPresentation) => undefined);
      renderReader(() => ({
        ...pageActions,
        mount: async () => "ready",
        setPresentation,
        dispose: vi.fn(),
      }));
      await screen.findByText("Reader ready");
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));

      await user.selectOptions(
        screen.getByRole("combobox", { name: "Western font weight" }),
        "700",
      );
      await user.click(screen.getByRole("button", { name: "Increase Line height" }));
      await user.click(screen.getByRole("button", { name: "Decrease Paragraph indentation" }));
      await user.click(screen.getByRole("button", { name: "Increase Paragraph margin" }));
      await user.click(screen.getByRole("button", { name: "Decrease Maximum text width" }));
      const vertical = screen.getByRole("button", { name: "Vertical" });
      await user.click(vertical);
      expect(vertical).toHaveAttribute("aria-pressed", "true");
      expect(vertical).toHaveFocus();
      const upright = screen.getByRole("button", { name: "Upright" });
      await user.click(upright);
      expect(upright).toHaveFocus();
      const hideFurigana = screen.getByRole("button", { name: "Hide furigana" });
      await user.click(hideFurigana);
      expect(hideFurigana).toHaveAttribute("aria-pressed", "true");
      expect(hideFurigana).toHaveFocus();
      const furiganaStyle = screen.getByRole("combobox", { name: "Hide furigana style" });
      expect(
        within(furiganaStyle)
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual(["Hide", "Partial", "Toggle", "Full"]);
      for (const style of ["partial", "toggle", "full", "hide"]) {
        await user.selectOptions(furiganaStyle, style);
        await waitFor(() =>
          expect(setPresentation).toHaveBeenLastCalledWith(
            expect.objectContaining({ hideFurigana: true, furiganaStyle: style }),
          ),
        );
      }
      const blurImage = screen.getByRole("button", { name: "Blur image" });
      await user.click(blurImage);
      expect(blurImage).toHaveAttribute("aria-pressed", "true");
      expect(blurImage).toHaveFocus();
      expect(screen.getByRole("group", { name: "Line height" })).toHaveTextContent("1.70");
      expect(screen.getByRole("group", { name: "Paragraph indentation" })).toHaveTextContent(
        "0.5 em",
      );
      expect(screen.getByRole("group", { name: "Paragraph margin" })).toHaveTextContent("2 px");
      expect(screen.getByRole("group", { name: "Maximum text width" })).toHaveTextContent(
        "3990 px",
      );
      await waitFor(() =>
        expect(setPresentation).toHaveBeenLastCalledWith({
          ...shown,
          fontWeight: 700,
          fontPair: { ...shown.fontPair!, weights: { western: 700, asian: 400 } },
          lineHeight: 1.7,
          paragraphIndent: 0.5,
          paragraphMargin: 2,
          maxWidth: 3990,
          writingMode: "vertical",
          textOrientation: "upright",
          hideFurigana: true,
          blurImage: true,
        }),
      );

      await user.click(screen.getByRole("button", { name: "Horizontal" }));
      await user.click(screen.getByRole("button", { name: "Mixed" }));
      await user.click(hideFurigana);
      expect(hideFurigana).toHaveAttribute("aria-pressed", "false");
      expect(
        screen.queryByRole("combobox", { name: "Hide furigana style" }),
      ).not.toBeInTheDocument();
      await user.click(blurImage);
      expect(blurImage).toHaveAttribute("aria-pressed", "false");
      await waitFor(() =>
        expect(setPresentation).toHaveBeenLastCalledWith({
          ...shown,
          fontWeight: 700,
          fontPair: { ...shown.fontPair!, weights: { western: 700, asian: 400 } },
          lineHeight: 1.7,
          paragraphIndent: 0.5,
          paragraphMargin: 2,
          maxWidth: 3990,
        }),
      );
    });

    it.each(["available", "unavailable", "fixed-layout"] as const)(
      "saves the scoped blur choice and explains %s contents",
      async (boundary) => {
        const user = userEvent.setup();
        const mount = vi.fn(async () => "ready" as const);
        const setPresentation = vi.fn(async () => undefined);
        readerWithAppearance(() => ({
          ...pageActions,
          mount,
          setPresentation,
          getImageBlurBoundary: () => boundary,
          dispose: vi.fn(),
        }));
        await screen.findByText("Reader ready");
        await user.click(screen.getByRole("button", { name: "Reader appearance" }));
        const mode = screen.getByRole("button", { name: "After ToC" });
        await user.click(mode);
        await user.click(screen.getByRole("button", { name: "Blur image" }));
        await waitFor(() =>
          expect(setPresentation).toHaveBeenLastCalledWith({
            ...shown,
            blurImage: true,
            blurMode: "after-toc",
          }),
        );
        expect(mode).toHaveAttribute("aria-pressed", "true");
        expect(
          screen.getByText(
            boundary === "available"
              ? "Images through the contents page stay clear."
              : boundary === "fixed-layout"
                ? "Fixed-layout images keep their original appearance."
                : "No usable contents page was identified. All images are blurred.",
          ),
        ).toHaveTextContent(
          boundary === "available"
            ? "Images through the contents page stay clear"
            : boundary === "fixed-layout"
              ? "Fixed-layout images keep their original appearance"
              : "No usable contents page was identified. All images are blurred",
        );
        expect(mount).toHaveBeenCalledOnce();
      },
    );

    it("keeps each stepper within its range, keeping focus at a limit", async () => {
      const user = userEvent.setup();
      const factory: ReaderRendererFactory = () => ({
        ...pageActions,
        mount: async () => "ready",
        dispose: vi.fn(),
      });
      const limits = [
        ["Line height", "3.00", "1.00"],
        ["Paragraph indentation", "20 em", "0 em"],
        ["Paragraph margin", "200 px", "0 px"],
        ["Maximum text width", "1000000 px", "100 px"],
        ["Reader max height", "1000000 px", "100 px"],
      ] as const;
      const { unmount } = readerWithAppearance(factory, {
        readerLineHeight: 2.95,
        readerParagraphIndent: 19.5,
        readerParagraphMargin: 198,
        readerMaxWidth: 999_990,
        readerMaxHeight: 999_990,
      });
      await screen.findByText("Reader ready");
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      for (const [label, highest] of limits) {
        const increase = screen.getByRole("button", { name: `Increase ${label}` });
        await user.click(increase);
        await user.click(increase);
        expect(screen.getByRole("group", { name: label })).toHaveTextContent(highest);
        expect(increase).toHaveAttribute("aria-disabled", "true");
        expect(increase).toHaveFocus();
      }
      unmount();

      readerWithAppearance(factory, {
        readerLineHeight: 1.05,
        readerParagraphIndent: 0.5,
        readerParagraphMargin: 2,
        readerMaxWidth: 110,
        readerMaxHeight: 110,
      });
      await screen.findByText("Reader ready");
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      for (const [label, , lowest] of limits) {
        const decrease = screen.getByRole("button", { name: `Decrease ${label}` });
        await user.click(decrease);
        await user.click(decrease);
        expect(screen.getByRole("group", { name: label })).toHaveTextContent(lowest);
        expect(decrease).toHaveAttribute("aria-disabled", "true");
        expect(decrease).toHaveFocus();
      }
    });

    it("steps the max height down from the full height to just below the reading area's", async () => {
      const user = userEvent.setup();
      const setPresentation = vi.fn(async (_presentation: ReaderPresentation) => undefined);
      const { container } = renderReader(() => ({
        ...pageActions,
        mount: async () => "ready",
        setPresentation,
        dispose: vi.fn(),
      }));
      await screen.findByText("Reader ready");
      const host = container.querySelector<HTMLElement>(".reader-viewport__host")!;
      const area = { height: 873 };
      Object.defineProperty(host, "clientHeight", { configurable: true, get: () => area.height });
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      const height = screen.getByRole("group", { name: "Reader max height" });
      const decrease = screen.getByRole("button", { name: "Decrease Reader max height" });

      // 4000px cannot shorten an 873px reading area, so one step visibly does.
      await user.click(decrease);
      await waitFor(() => expect(height).toHaveTextContent("870 px"));
      await waitFor(() =>
        expect(setPresentation).toHaveBeenLastCalledWith({ ...shown, maxHeight: 870 }),
      );
      area.height = 870;
      await user.click(decrease);
      await waitFor(() => expect(height).toHaveTextContent("860 px"));
      area.height = 860;
      // Stepping up is one step at a time, beyond the reading area too.
      await user.click(screen.getByRole("button", { name: "Increase Reader max height" }));
      expect(height).toHaveTextContent("870 px");

      // An exact height steps to the one below it.
      area.height = 870;
      await user.click(decrease);
      await waitFor(() => expect(height).toHaveTextContent("860 px"));
    });

    it("applies and saves typed values, rounded to each step and kept within each range", async () => {
      const user = userEvent.setup();
      const setPresentation = vi.fn(async (_presentation: ReaderPresentation) => undefined);
      const save = vi.fn(async (_preferences: AppearancePreferences) => undefined);
      render(
        <MemoryRouter>
          <AppearanceProvider store={{ load: async () => ({}), save }}>
            <ReaderShell
              rendererFactory={() => ({
                ...pageActions,
                mount: async () => "ready",
                setPresentation,
                dispose: vi.fn(),
              })}
            />
          </AppearanceProvider>
        </MemoryRouter>,
      );
      await screen.findByText("Reader ready");
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      const size = screen.getByRole("textbox", { name: "Font size" });
      const lineHeight = screen.getByRole("textbox", { name: "Line height" });
      const indent = screen.getByRole("textbox", { name: "Paragraph indentation" });

      await user.clear(size);
      await user.type(size, "21{Enter}");
      expect(size).toHaveValue("21");
      await user.clear(lineHeight);
      await user.type(lineHeight, "1.83");
      await user.tab();
      expect(lineHeight).toHaveValue("1.85");
      await user.clear(indent);
      await user.type(indent, "35{Enter}");
      expect(indent).toHaveValue("20");
      // Escape and an entry that is not a number keep the value.
      await user.clear(size);
      await user.type(size, "30{Escape}");
      await user.tab();
      await user.clear(lineHeight);
      await user.type(lineHeight, "tall{Enter}");
      expect(size).toHaveValue("21");
      expect(lineHeight).toHaveValue("1.85");

      const typed = { ...shown, fontSize: 21, lineHeight: 1.85, paragraphIndent: 20 };
      await waitFor(() => expect(setPresentation).toHaveBeenLastCalledWith(typed));
      await waitFor(() =>
        expect(save).toHaveBeenLastCalledWith(
          expect.objectContaining({
            readerFontSize: 21,
            readerLineHeight: 1.85,
            readerParagraphIndent: 20,
          }),
        ),
      );
    });

    it("applies a typed max height as typed, even while a step down measures", async () => {
      const user = userEvent.setup();
      const setPresentation = vi.fn(async (_presentation: ReaderPresentation) => undefined);
      const { container } = renderReader(() => ({
        ...pageActions,
        mount: async () => "ready",
        setPresentation,
        dispose: vi.fn(),
      }));
      await screen.findByText("Reader ready");
      const host = container.querySelector<HTMLElement>(".reader-viewport__host")!;
      Object.defineProperty(host, "clientHeight", { configurable: true, get: () => 873 });
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      const height = screen.getByRole("textbox", { name: "Reader max height" });

      // A step down from 4000px would go to 870px; a typed height does not.
      await user.clear(height);
      await user.type(height, "2004{Enter}");
      expect(height).toHaveValue("2000");
      await waitFor(() =>
        expect(setPresentation).toHaveBeenLastCalledWith({ ...shown, maxHeight: 2000 }),
      );
      await user.clear(height);
      await user.type(height, "20{Enter}");
      expect(height).toHaveValue("100");

      // A height typed while a step down still measures replaces it.
      await user.clear(height);
      await user.type(height, "4000{Enter}");
      fireEvent.click(screen.getByRole("button", { name: "Decrease Reader max height" }));
      fireEvent.change(height, { target: { value: "1500" } });
      fireEvent.keyDown(height, { key: "Enter" });
      await waitFor(() =>
        expect(setPresentation).toHaveBeenLastCalledWith({ ...shown, maxHeight: 1500 }),
      );
      expect(height).toHaveValue("1500");
    });

    it("opens a book at every saved setting", async () => {
      const user = userEvent.setup();
      const presentations: Array<ReaderPresentation | undefined> = [];
      readerWithAppearance(
        () => ({
          ...pageActions,
          mount: async (...args) => {
            presentations.push(args[7]);
            return "ready";
          },
          setPresentation: vi.fn(async () => undefined),
          dispose: vi.fn(),
        }),
        {
          readerAsianFont: { source: "preset", id: "georgia" },
          readerWesternFont: { source: "preset", id: "inter" },
          readerFontFamilyGroup1: "georgia",
          readerFontFamilyGroup2: "inter",
          readerFontSize: 20,
          readerLineHeight: 1.5,
          readerFontWeight: 300,
          readerWesternFontWeight: 300,
          readerAsianFontWeight: 300,
          readerParagraphIndent: 0,
          readerParagraphMargin: 200,
          readerMaxWidth: 120,
          readerMaxHeight: 900,
          readerWritingMode: "vertical",
          readerTextOrientation: "upright",
          readerTextJustification: true,
          readerPrettyTextWrap: true,
          readerLetterSpacing: -3,
          readerWordSpacing: 24,
          readerHideFurigana: true,
          readerFuriganaStyle: "full",
          readerBlurImage: true,
          readerBlurMode: "after-toc",
          readerTheme: dusk.id,
          readerCustomThemes: [dusk],
        },
      );
      await screen.findByText("Reader ready");
      expect(readingAreaColors()).toEqual(["#101820", "#f0e6d2", "#a09880"]);
      expect(presentations).toEqual([
        {
          fontFamilyGroup1: "georgia",
          fontFamilyGroup2: "inter",
          fontPair: {
            asian: { source: "preset", id: "georgia" },
            western: { source: "preset", id: "inter" },
            downloaded: [],
            weights: { western: 300, asian: 300 },
          },
          fontSize: 20,
          vnParagraphs: 1,
          vnTextSpeed: 40,
          lineHeight: 1.5,
          fontWeight: 300,
          paragraphIndent: 0,
          paragraphMargin: 200,
          maxWidth: 120,
          pageLayout: "double",
          maxHeight: 900,
          writingMode: "vertical",
          textOrientation: "upright",
          textJustification: true,
          prettyTextWrap: true,
          letterSpacing: -3,
          wordSpacing: 24,
          hideFurigana: true,
          blurImage: true,
          blurMode: "after-toc",
          furiganaStyle: "full",
          textColor: "#f0e6d2",
          selectionColor: "#445566",
          highlightColor: "#778899",
        },
      ]);
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      expect(screen.getByRole("button", { name: "Dusk" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("textbox", { name: "Theme name" })).toHaveValue("Dusk");
      expect(screen.getByRole("combobox", { name: "Western font weight" })).toHaveValue("300");
      expect(screen.getByRole("group", { name: "Paragraph indentation" })).toHaveTextContent(
        "0 em",
      );
      expect(screen.getByRole("group", { name: "Paragraph margin" })).toHaveTextContent("200 px");
      expect(screen.getByRole("group", { name: "Maximum text width" })).toHaveTextContent("120 px");
      expect(screen.getByRole("group", { name: "Reader max height" })).toHaveTextContent("900 px");
      expect(screen.getByRole("button", { name: "Vertical" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "Upright" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "Hide furigana" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "Blur image" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("chooses presets and custom themes, recoloring the book and saving each change", async () => {
      const user = userEvent.setup();
      const setPresentation = vi.fn(async (_presentation: ReaderPresentation) => undefined);
      const saved: AppearancePreferences[] = [];
      render(
        <MemoryRouter>
          <AppearanceProvider
            store={{
              load: async () => ({}),
              save: async (preferences) => {
                saved.push(preferences);
              },
            }}
          >
            <ReaderShell
              rendererFactory={() => ({
                ...pageActions,
                mount: async () => "ready",
                setPresentation,
                dispose: vi.fn(),
              })}
            />
          </AppearanceProvider>
        </MemoryRouter>,
      );
      await screen.findByText("Reader ready");
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      const theme = screen.getByRole("region", { name: "Theme" });

      // A preset colors the page, its text, the footer, and the book's text and selection.
      const night = within(theme).getByRole("button", { name: "Night" });
      await user.click(night);
      expect(night).toHaveAttribute("aria-pressed", "true");
      expect(night).toHaveFocus();
      expect(readingAreaColors()).toEqual(["#16181d", "#d9dce3", "#8f9298"]);
      await waitFor(() =>
        expect(setPresentation).toHaveBeenLastCalledWith({
          ...shown,
          textColor: "#d9dce3",
          selectionColor: "#3e4e6e",
          highlightColor: "#475b82",
        }),
      );
      await waitFor(() => expect(saved.at(-1)?.readerTheme).toBe("night"));

      // Custom creates a theme from the shown colors, chooses it, and opens its editor.
      await user.click(within(theme).getByRole("button", { name: "Custom: new theme" }));
      const first = within(theme).getByRole("button", { name: "Custom 1" });
      expect(first).toHaveAttribute("aria-pressed", "true");
      expect(night).toHaveAttribute("aria-pressed", "false");
      const name = within(theme).getByRole("textbox", { name: "Theme name" });
      expect(name).toHaveValue("Custom 1");
      expect(
        ["Background", "Text", "Highlight", "Selection", "Footer text"].map(
          (label) =>
            within(theme).getByRole<HTMLInputElement>("textbox", { name: `${label} HEX` }).value,
        ),
      ).toEqual(["#16181d", "#d9dce3", "#475b82", "#3e4e6e", "#8f9298"]);
      await waitFor(() => expect(saved.at(-1)?.readerCustomThemes).toHaveLength(1));
      const id = saved.at(-1)!.readerCustomThemes[0].id;
      expect(saved.at(-1)?.readerTheme).toBe(id);

      // A typed color applies once whole; an incomplete one is marked and reverts on leaving.
      const background = within(theme).getByRole("textbox", { name: "Background HEX" });
      await user.clear(background);
      await user.type(background, "#2A3B4C");
      expect(readingAreaColors()[0]).toBe("#2a3b4c");
      const text = within(theme).getByRole("textbox", { name: "Text HEX" });
      await user.clear(text);
      await user.type(text, "#fed");
      expect(text).toHaveAttribute("aria-invalid", "true");
      await user.tab();
      expect(text).toHaveValue("#d9dce3");
      expect(text).toHaveAttribute("aria-invalid", "false");
      fireEvent.change(within(theme).getByRole("textbox", { name: "Selection HEX" }), {
        target: { value: "#aabbcc" },
      });
      fireEvent.change(within(theme).getByRole("textbox", { name: "Footer text HEX" }), {
        target: { value: "#123456" },
      });
      expect(readingAreaColors()).toEqual(["#2a3b4c", "#d9dce3", "#123456"]);
      await waitFor(() =>
        expect(setPresentation).toHaveBeenLastCalledWith({
          ...shown,
          textColor: "#d9dce3",
          selectionColor: "#aabbcc",
          highlightColor: "#475b82",
        }),
      );

      // Highlight changes independently, accepting only a whole HEX color.
      const highlight = within(theme).getByRole("textbox", { name: "Highlight HEX" });
      await user.clear(highlight);
      await user.type(highlight, "#bad");
      expect(highlight).toHaveAttribute("aria-invalid", "true");
      await user.tab();
      expect(highlight).toHaveValue("#475b82");
      await user.clear(highlight);
      await user.type(highlight, "#654321");
      await waitFor(() =>
        expect(setPresentation).toHaveBeenLastCalledWith({
          ...shown,
          textColor: "#d9dce3",
          selectionColor: "#aabbcc",
          highlightColor: "#654321",
        }),
      );
      expect(within(theme).getByRole("textbox", { name: "Selection HEX" })).toHaveValue("#aabbcc");

      // Renaming applies each valid name; an empty one reverts on leaving.
      await user.clear(name);
      await user.type(name, "Evening");
      expect(within(theme).getByRole("button", { name: "Evening" })).toBe(first);
      await user.clear(name);
      await user.tab();
      expect(name).toHaveValue("Evening");
      await waitFor(() =>
        expect(saved.at(-1)?.readerCustomThemes).toEqual([
          {
            id,
            name: "Evening",
            background: "#2a3b4c",
            text: "#d9dce3",
            selection: "#aabbcc",
            highlight: "#654321",
            footerText: "#123456",
          },
        ]),
      );

      // A second theme gets its own swatch after the first, and each can be chosen again.
      await user.click(within(theme).getByRole("button", { name: "Custom: new theme" }));
      const second = within(theme).getByRole("button", { name: "Custom 1" });
      expect(
        within(theme)
          .getAllByRole("button", { name: /^(Mocha|Evening|Custom 1|Custom: new theme)$/ })
          .map((button) => button.textContent),
      ).toEqual(["あMocha", "あEvening", "あCustom 1", "あCustom: new theme"]);
      expect(within(theme).getByRole("textbox", { name: "Background HEX" })).toHaveValue("#2a3b4c");
      await user.click(within(theme).getByRole("button", { name: "Sepia" }));
      expect(within(theme).queryByRole("textbox", { name: "Theme name" })).toBeNull();
      await user.click(first);
      expect(within(theme).getByRole("textbox", { name: "Theme name" })).toHaveValue("Evening");

      // Deleting the chosen theme returns to Hojicha, with focus on it, and keeps the other.
      await user.click(within(theme).getByRole("button", { name: "Delete theme" }));
      const hojicha = within(theme).getByRole("button", { name: "Hojicha" });
      expect(hojicha).toHaveAttribute("aria-pressed", "true");
      expect(hojicha).toHaveFocus();
      expect(within(theme).queryByRole("button", { name: "Evening" })).toBeNull();
      expect(second).toHaveAttribute("aria-pressed", "false");
      expect(readingAreaColors()).toEqual(["#ebdfcb", "#3e2f22", "#807262"]);
      await waitFor(() => expect(saved.at(-1)?.readerTheme).toBe("hojicha"));
      expect(saved.at(-1)?.readerCustomThemes.map((custom) => custom.name)).toEqual(["Custom 1"]);
      await waitFor(() => expect(setPresentation).toHaveBeenLastCalledWith(shown));
    });

    it("keeps the Custom swatch from creating more themes than the limit", async () => {
      const user = userEvent.setup();
      readerWithAppearance(
        () => ({ ...pageActions, mount: async () => "ready", dispose: vi.fn() }),
        {
          readerCustomThemes: Array.from({ length: 32 }, (_, index) => ({
            ...dusk,
            id: dusk.id.slice(0, -2) + index.toString(16).padStart(2, "0"),
            name: `Theme ${index + 1}`,
          })),
        },
      );
      await screen.findByText("Reader ready");
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      const create = screen.getByRole("button", { name: "Custom: new theme" });
      expect(create).toBeDisabled();
      expect(create).toHaveAttribute("title", "Up to 32 custom themes can be kept.");
      expect(screen.getByRole("button", { name: "Theme 32" })).toBeInTheDocument();
    });

    it("chooses Continuous, Semi-continuous, and Paginated in Page flow and passes the mode to the renderer", async () => {
      const user = userEvent.setup();
      const setPresentation = vi.fn(async (_presentation: ReaderPresentation) => undefined);
      const factory: ReaderRendererFactory = () => ({
        ...pageActions,
        mount: async () => "ready",
        setPresentation,
        dispose: vi.fn(),
      });
      renderReader(factory);
      await screen.findByText("Reader ready");
      await user.click(screen.getByRole("button", { name: "Reader appearance" }));
      const view = screen.getByRole("group", { name: "View mode" });
      const continuous = within(view).getByRole("button", { name: "Continuous" });
      const paginated = within(view).getByRole("button", { name: "Paginated" });
      const chapters = within(view).getByRole("button", { name: "Semi-continuous" });
      expect(
        within(view)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["Continuous", "Semi-continuous", "Paginated", "VN"]);
      expect(paginated).toHaveAttribute("aria-pressed", "true");
      await user.click(continuous);
      expect(continuous).toHaveAttribute("aria-pressed", "true");
      expect(continuous).toHaveFocus();
      await waitFor(() =>
        expect(setPresentation).toHaveBeenLastCalledWith({ ...shown, viewMode: "continuous" }),
      );
      await user.click(chapters);
      expect(chapters).toHaveAttribute("aria-pressed", "true");
      await waitFor(() =>
        expect(setPresentation).toHaveBeenLastCalledWith({ ...shown, viewMode: "semi-continuous" }),
      );
      await user.click(within(view).getByRole("button", { name: "VN" }));
      const count = screen.getByRole("textbox", { name: "VN paragraphs" });
      fireEvent.change(count, { target: { value: "3" } });
      fireEvent.keyDown(count, { key: "Enter" });
      const speed = screen.getByRole("textbox", { name: "Text reveal speed" });
      fireEvent.change(speed, { target: { value: "80" } });
      fireEvent.keyDown(speed, { key: "Enter" });
      await waitFor(() =>
        expect(setPresentation).toHaveBeenLastCalledWith({
          ...shown,
          viewMode: "vn",
          vnParagraphs: 3,
          vnTextSpeed: 80,
        }),
      );
      await user.click(paginated);
      expect(paginated).toHaveAttribute("aria-pressed", "true");
      await waitFor(() =>
        expect(setPresentation).toHaveBeenLastCalledWith({
          ...shown,
          vnParagraphs: 3,
          vnTextSpeed: 80,
        }),
      );
    });
  });
});

import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppearanceProvider } from "../appearance/AppearanceProvider";
import { ReaderShell } from "./ReaderShell";
import { ReaderImageViewer } from "./ReaderImageViewer";
import { useImageResource } from "./ReaderImagesPanel";
import type {
  ReaderRenderer,
  ReaderRendererFactory,
  ReaderImages,
  ReaderImageResource,
} from "./renderer";

const images: ReaderImages = {
  items: [
    { id: "first", alt: "Real cover", label: "Opening", section: 1 },
    { id: "second", alt: "Real drawing", label: "Chapter", section: 3 },
  ],
  truncated: false,
  failedSections: 0,
};
function adapter(): ReaderRenderer {
  return {
    mount: vi.fn(async (_host, _signal, turns) => {
      turns({ canAdvance: true, canRetreat: true });
      return "ready" as const;
    }),
    advancePage: vi.fn(async () => undefined),
    retreatPage: vi.fn(async () => undefined),
    dispose: vi.fn(),
    listImages: vi.fn(async () => images),
    loadImage: vi.fn(async (id) => ({ url: `blob:${id}`, width: 640, height: 480 })),
    releaseImage: vi.fn(),
    goToImage: vi.fn(async () => true),
    setPresentation: vi.fn(async () => undefined),
  };
}
function shell(factory?: ReaderRendererFactory) {
  return (
    <MemoryRouter>
      <AppearanceProvider>
        <ReaderShell rendererFactory={factory} />
      </AppearanceProvider>
    </MemoryRouter>
  );
}
async function open() {
  await waitFor(() => expect(screen.getByText("Reader ready")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "Images" }));
}

describe("Reader images", () => {
  it("drops old selections and releases invisible, cancelled and late thumbnail resources", async () => {
    let finish!: (resource: ReaderImageResource) => void;
    const load = vi.fn<NonNullable<ReaderRenderer["loadImage"]>>(async (id) =>
      id === "slow"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { url: `blob:${id}`, width: 100, height: 150 },
    );
    const release = vi.fn();
    const view = renderHook(
      ({ id, enabled }) => useImageResource(id, "thumbnail", enabled, 0, load, release),
      { initialProps: { id: "first", enabled: true } },
    );
    await waitFor(() => expect(view.result.current.resource?.url).toBe("blob:first"));
    view.rerender({ id: "slow", enabled: true });
    expect(view.result.current.resource).toBeNull();
    expect(release).toHaveBeenCalledWith("blob:first");
    const pending = load.mock.calls.at(-1)![2];
    view.rerender({ id: "last", enabled: true });
    expect(pending.aborted).toBe(true);
    await act(async () => finish({ url: "blob:late", width: 100, height: 150 }));
    expect(release).toHaveBeenCalledWith("blob:late");
    expect(view.result.current.resource?.url).toBe("blob:last");
    view.rerender({ id: "last", enabled: false });
    expect(view.result.current.resource).toBeNull();
    expect(release).toHaveBeenCalledWith("blob:last");
    view.unmount();
  });
  it("fits portrait and rotated art to the measured available area without changing its proportions", async () => {
    let resize!: () => void;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const view = render(
      <ReaderImageViewer
        session={{ items: images.items, index: 0, signal: new AbortController().signal }}
        navigationBusy={false}
        onJump={() => false}
        onClose={() => {}}
        loadImage={async () => ({ url: "blob:portrait", width: 1000, height: 2000 })}
        releaseImage={() => {}}
      />,
    );
    try {
      const stage = screen.getByRole("group", { name: "Image pan area" });
      Object.defineProperty(stage, "clientWidth", { configurable: true, value: 800 });
      Object.defineProperty(stage, "clientHeight", { configurable: true, value: 600 });
      act(() => resize());
      const image = await screen.findByRole("img", { name: "Real cover" });
      expect(image.style.width).toBe("300px");
      expect(image.style.height).toBe("600px");
      await userEvent.click(screen.getByRole("button", { name: "Rotate image clockwise" }));
      expect(image.style.width).toBe("400px");
      expect(image.style.height).toBe("800px");
      expect(image.parentElement!.style.width).toBe("800px");
      expect(image.parentElement!.style.height).toBe("600px");
      Object.defineProperty(stage, "clientWidth", { value: 300 });
      act(() => resize());
      expect(image.style.width).toBe("150px");
      expect(image.style.height).toBe("300px");
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  });
  it("browses by keyboard and pointer with zoom/rotation, focus return and no book navigation", async () => {
    const renderer = adapter();
    const factory = vi.fn(() => renderer);
    render(shell(factory));
    await open();
    const first = await screen.findByRole("button", { name: "Open image 1: Real cover" });
    first.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Book image viewer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close image viewer" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Previous image" })).toBeDisabled();
    // From the sidebar's images the viewer is docked beside them: not modal, nor a focus trap.
    expect(screen.getByRole("dialog")).not.toHaveAttribute("aria-modal");
    expect(first).toHaveAttribute("aria-current", "true");
    await userEvent.keyboard("+");
    expect(screen.getByText("125%")).toBeInTheDocument();
    await userEvent.keyboard("r");
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getByRole("img", { name: "Real cover" }).style.transform,
      ).toBe("translate(-50%, -50%) rotate(90deg)"),
    );
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByText(/Image 2 of 2/)).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next image" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Previous image" }));
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await userEvent.click(screen.getByRole("button", { name: "Rotate image clockwise" }));
    await userEvent.click(screen.getByRole("button", { name: "Reset image view" }));
    expect(screen.getByText("100%")).toBeInTheDocument();
    const wheel = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(screen.getByLabelText("Image pan area"), wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(screen.getByText("125%")).toBeInTheDocument();
    // The wheel browses images, one per step, without wrapping.
    const pan = screen.getByLabelText("Image pan area");
    fireEvent.wheel(pan, { deltaY: 100 });
    expect(screen.getByText(/Image 2 of 2/)).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
    fireEvent.wheel(pan, { deltaY: 100 });
    expect(screen.getByText(/Image 2 of 2/)).toBeInTheDocument();
    // A touchpad's finer movement browses once a whole step has built up.
    fireEvent.wheel(pan, { deltaY: -40 });
    fireEvent.wheel(pan, { deltaY: -40 });
    expect(screen.getByText(/Image 2 of 2/)).toBeInTheDocument();
    fireEvent.wheel(pan, { deltaY: -30 });
    expect(screen.getByText(/Image 1 of 2/)).toBeInTheDocument();
    // An image larger than the stage scrolls instead.
    Object.defineProperty(pan, "scrollHeight", { configurable: true, value: 2000 });
    const scroll = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
    fireEvent(pan, scroll);
    expect(scroll.defaultPrevented).toBe(false);
    expect(screen.getByText(/Image 1 of 2/)).toBeInTheDocument();
    // The sidebar's images stay beside the viewer: another shows in it at once, and becomes current.
    const second = screen.getByRole("button", { name: "Open image 2: Real drawing" });
    await userEvent.click(second);
    expect(screen.getByText(/Image 2 of 2/)).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(second).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Close image viewer" })).toHaveFocus();
    await userEvent.click(first);
    expect(screen.getByText(/Image 1 of 2/)).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(first).toHaveFocus();
    await userEvent.click(first);
    await userEvent.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(renderer.advancePage).not.toHaveBeenCalled();
    expect(renderer.retreatPage).not.toHaveBeenCalled();
    expect(renderer.goToImage).not.toHaveBeenCalled();
    expect(renderer.setPresentation).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledOnce();
    expect(renderer.releaseImage).toHaveBeenCalled();
  });
  it("serializes explicit jumps, keeps failed jumps reviewable and focuses the book after success", async () => {
    const renderer = adapter();
    render(shell(() => renderer));
    await open();
    await userEvent.click(await screen.findByRole("button", { name: /Open image 2/ }));
    vi.mocked(renderer.goToImage!).mockResolvedValueOnce(false);
    await userEvent.click(screen.getByRole("button", { name: "Go to location" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open");
    let finish!: (success: boolean) => void;
    vi.mocked(renderer.goToImage!).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Go to location" }));
    expect(screen.getByRole("button", { name: "Go to location" })).toBeDisabled();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByText(/Image 2 of 2/)).toBeInTheDocument();
    await act(async () => finish(true));
    await waitFor(() => expect(document.getElementById("reader-main")).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(renderer.goToImage).toHaveBeenCalledWith("second", expect.any(AbortSignal));
  });
  it("reports empty, partial, load and image failures with retry", async () => {
    const renderer = adapter();
    vi.mocked(renderer.listImages!).mockRejectedValueOnce(Error("private detail"));
    render(shell(() => renderer));
    await open();
    expect(await screen.findByText("Could not load book images.")).toBeInTheDocument();
    expect(screen.queryByText("private detail")).not.toBeInTheDocument();
    vi.mocked(renderer.listImages!).mockResolvedValueOnce({
      items: [],
      failedSections: 1,
      truncated: true,
    });
    await userEvent.click(screen.getByRole("button", { name: "Retry images" }));
    expect(await screen.findByText(/No images found/)).toBeInTheDocument();
    expect(screen.getByText(/Some sections/)).toBeInTheDocument();
    expect(screen.getByText(/first bounded/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to reader controls" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Images" })).toHaveFocus());
    vi.mocked(renderer.loadImage!).mockRejectedValue(Error("private"));
    await open();
    await userEvent.click(await screen.findByRole("button", { name: /Open image 1/ }));
    expect(await screen.findByText("This image could not be displayed.")).toBeInTheDocument();
    vi.mocked(renderer.loadImage!).mockResolvedValue({
      url: "blob:retry",
      width: 100,
      height: 100,
    });
    await userEvent.click(screen.getByRole("button", { name: "Retry image" }));
    expect(await screen.findByRole("img", { name: "Real cover" })).toBeInTheDocument();
  });
  it("cancels obsolete discovery and releases late image loads on book change/disposal", async () => {
    const old = adapter();
    let discovered!: (value: ReaderImages) => void;
    vi.mocked(old.listImages!).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          discovered = resolve;
        }),
    );
    const factory = () => old;
    const view = render(shell(factory));
    await open();
    const signal = vi.mocked(old.listImages!).mock.calls[0][0];
    const next = adapter();
    view.rerender(shell(() => next));
    expect(signal.aborted).toBe(true);
    await act(async () => discovered(images));
    await waitFor(() => expect(next.listImages).toHaveBeenCalled());
    let loaded!: (resource: ReaderImageResource) => void;
    vi.mocked(next.loadImage!).mockImplementation((_, size) =>
      size === "viewer"
        ? new Promise((resolve) => {
            loaded = resolve;
          })
        : Promise.resolve({ url: "blob:thumb", width: 100, height: 100 }),
    );
    await userEvent.click(await screen.findByRole("button", { name: /Open image 1/ }));
    const pending = vi.mocked(next.loadImage!).mock.calls.find((call) => call[1] === "viewer")![2];
    view.unmount();
    expect(pending.aborted).toBe(true);
    await act(async () => loaded({ url: "blob:late", width: 1, height: 1 }));
    expect(next.releaseImage).toHaveBeenCalledWith("blob:late");
  });
  it("keeps viewer jumps cancelled after closing and prevents modal keys reaching book documents", async () => {
    const renderer = adapter();
    let content!: Document;
    vi.mocked(renderer.mount).mockImplementation(async (_host, _signal, turns, onDocument) => {
      turns({ canAdvance: true, canRetreat: true });
      content = document.implementation.createHTMLDocument();
      onDocument?.(content);
      return "ready";
    });
    let finish!: (success: boolean) => void;
    vi.mocked(renderer.goToImage!).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(shell(() => renderer));
    await open();
    await userEvent.click(await screen.findByRole("button", { name: /Open image 1/ }));
    content.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(renderer.advancePage).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Go to location" }));
    const signal = vi.mocked(renderer.goToImage!).mock.calls[0][1];
    await userEvent.click(screen.getByRole("button", { name: "Close image viewer" }));
    expect(signal.aborted).toBe(true);
    await act(async () => finish(true));
    expect(document.getElementById("reader-main")).not.toHaveFocus();
  });
  it("opens a clicked book occurrence, preserves blur gestures and cancels obsolete direct opens", async () => {
    const renderer = adapter();
    let content!: Document;
    vi.mocked(renderer.mount).mockImplementation(async (_host, _signal, _turns, onDocument) => {
      content = document.implementation.createHTMLDocument();
      content.body.innerHTML =
        '<a href="#other"><img alt="Book art"></a><svg><rect /></svg><img data-komori-image-action="reveal">';
      onDocument?.(content);
      return "ready";
    });
    let finish!: (result: { items: typeof images.items; index: number }) => void;
    renderer.imageAt = vi.fn<NonNullable<ReaderRenderer["imageAt"]>>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(shell(() => renderer));
    await waitFor(() => expect(screen.getByText("Reader ready")).toBeInTheDocument());
    const clickImage = (selector: string, options: MouseEventInit = {}) =>
      act(() => {
        content
          .querySelector(selector)!
          .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...options }));
      });
    clickImage("[data-komori-image-action]");
    clickImage("img", { ctrlKey: true });
    expect(renderer.imageAt).not.toHaveBeenCalled();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    content.querySelector("img")!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    const firstSignal = vi.mocked(renderer.imageAt!).mock.calls[0][1];
    clickImage("rect");
    expect(firstSignal.aborted).toBe(true);
    expect(renderer.imageAt).toHaveBeenLastCalledWith(
      content.querySelector("svg"),
      expect.any(AbortSignal),
    );
    await act(async () => finish({ items: images.items, index: 1 }));
    expect(await screen.findByText(/Image 2 of 2/)).toBeInTheDocument();
    expect(renderer.goToImage).not.toHaveBeenCalled();
    // From the book the viewer is modal, and Tab stays within it.
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Close image viewer" })).toHaveFocus();
    screen.getByRole("button", { name: "Zoom out" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Go to location" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Zoom out" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Close image viewer" }));
    expect(vi.mocked(renderer.imageAt!).mock.calls[1][1].aborted).toBe(true);
    clickImage("img");
    const pending = vi.mocked(renderer.imageAt!).mock.calls[2][1];
    view.unmount();
    expect(pending.aborted).toBe(true);
    await act(async () => finish({ items: images.items, index: 0 }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    vi.mocked(renderer.imageAt!).mockClear();
    clickImage("img");
    expect(renderer.imageAt).not.toHaveBeenCalled();
  });
  it("keeps boundary keys from resetting zoom and begins each sidebar panel at its heading", async () => {
    render(shell(() => adapter()));
    await open();
    const content = document.querySelector<HTMLElement>(".reader-sidebar__content")!;
    content.scrollTop = 300;
    await userEvent.click(screen.getByRole("button", { name: "Reader appearance" }));
    expect(content.scrollTop).toBe(0);
    expect(screen.getByRole("heading", { name: "Appearance" }).closest("header")).toHaveClass(
      "reader-subpanel-heading",
    );
    await userEvent.click(screen.getByRole("button", { name: "Back to reader controls" }));
    expect(
      within(screen.getByRole("group", { name: "Book tools" })).getAllByRole("button"),
    ).toHaveLength(4);
    await open();
    await userEvent.click(await screen.findByRole("button", { name: /Open image 1/ }));
    await userEvent.keyboard("+{ArrowLeft}");
    expect(screen.getByText("125%")).toBeInTheDocument();
    expect(screen.getByText(/Image 1 of 2/)).toBeInTheDocument();
  });
});

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderScrollbar, type ReaderScrollTrack } from "./ReaderScrollbar";
import type { ReaderScrollMetrics } from "./renderer";

function track(initial: ReaderScrollMetrics | null) {
  let metrics = initial;
  const listeners = new Set<() => void>();
  const value: ReaderScrollTrack & { set(next: ReaderScrollMetrics): void } = {
    metrics: () => metrics,
    scrollTo: vi.fn(),
    watch: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      metrics = next;
      for (const listener of listeners) listener();
    },
  };
  return value;
}

function sized(
  element: Element,
  box: { left: number; top: number; width: number; height: number },
) {
  element.getBoundingClientRect = () =>
    ({ ...box, right: box.left + box.width, bottom: box.top + box.height }) as DOMRect;
}

afterEach(() => vi.useRealTimers());

describe("Reader scrollbar", () => {
  it("stays hidden while the book turns pages or fits in view", () => {
    const { container, rerender } = render(<ReaderScrollbar track={track(null)} refresh={0} />);
    expect(container.querySelector(".reader-scrollbar")).toBeNull();
    const fits = track({ axis: "vertical", reversed: false, position: 0, length: 0, visible: 500 });
    rerender(<ReaderScrollbar track={fits} refresh={1} />);
    expect(container.querySelector(".reader-scrollbar")).toBeNull();
  });

  it("follows a vertical scroll along the right edge, drags its thumb and pages from its track", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const book = track({
      axis: "vertical",
      reversed: false,
      position: 0,
      length: 1500,
      visible: 500,
    });
    const { container } = render(<ReaderScrollbar track={book} refresh={0} />);
    const bar = container.querySelector<HTMLElement>(".reader-scrollbar--vertical")!;
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(bar.style.getPropertyValue("--reader-scroll-thumb")).toBe("max(32px, 25%)");
    expect(bar.style.getPropertyValue("--reader-scroll-along")).toBe("0");
    act(() =>
      book.set({ axis: "vertical", reversed: false, position: 750, length: 1500, visible: 500 }),
    );
    act(() => vi.advanceTimersToNextFrame());
    expect(bar.style.getPropertyValue("--reader-scroll-along")).toBe("0.5");

    // 400 px of track: a 100 px thumb travels 300 px for 1500 px of book.
    sized(bar, { left: 990, top: 0, width: 12, height: 400 });
    fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientY: 200 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientY: 230 });
    expect(book.scrollTo).toHaveBeenLastCalledWith(900);
    fireEvent.pointerUp(bar, { pointerId: 1 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientY: 300 });
    expect(book.scrollTo).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(bar, { button: 0, pointerId: 2, clientY: 20 });
    expect(book.scrollTo).toHaveBeenLastCalledWith(300);
    fireEvent.pointerDown(bar, { button: 0, pointerId: 3, clientY: 390 });
    expect(book.scrollTo).toHaveBeenLastCalledWith(1200);
  });

  it("runs along the bottom edge from the right for a right-to-left vertical book", () => {
    const book = track({
      axis: "horizontal",
      reversed: true,
      position: 0,
      length: 3000,
      visible: 1000,
    });
    const { container } = render(<ReaderScrollbar track={book} refresh={0} />);
    const bar = container.querySelector<HTMLElement>(".reader-scrollbar--horizontal")!;
    expect(bar.style.getPropertyValue("--reader-scroll-along")).toBe("1");
    sized(bar, { left: 0, top: 788, width: 1000, height: 12 });
    // The thumb, 250 px wide, starts at the right end; dragging it left reads on.
    fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 900 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 825 });
    expect(book.scrollTo).toHaveBeenLastCalledWith(300);
    fireEvent.pointerUp(bar, { pointerId: 1 });
    // Pressing the track to the thumb's left pages forward.
    fireEvent.pointerDown(bar, { button: 0, pointerId: 2, clientX: 100 });
    expect(book.scrollTo).toHaveBeenLastCalledWith(900);
  });
});

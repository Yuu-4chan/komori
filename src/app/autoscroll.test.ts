import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptsAutoscroll,
  AutoscrollController,
  autoscrollSpeed,
  scrollableAncestor,
} from "./autoscroll";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const pointer = (type: string, target: Element, values: MouseEventInit = {}) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...values }));

describe("middle-click autoscroll", () => {
  it("excludes controls across document realms and selects the nearest scrollable axis", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const doc = frame.contentDocument!;
    doc.body.innerHTML =
      '<button><span>control</span></button><div contenteditable="true">edit</div><a>link</a><p>text</p>';
    for (const selector of ["span", "div", "a"])
      expect(acceptsAutoscroll(doc.querySelector(selector))).toBe(false);
    expect(acceptsAutoscroll(doc.querySelector("p"))).toBe(true);
    const boundary = document.createElement("main");
    const panel = document.createElement("div");
    panel.style.overflowX = "auto";
    const child = document.createElement("span");
    panel.append(child);
    boundary.append(panel);
    Object.defineProperties(panel, { scrollWidth: { value: 500 }, clientWidth: { value: 100 } });
    expect(scrollableAncestor(child, boundary)).toBe(panel);
    expect(autoscrollSpeed(10)).toBe(0);
    expect(autoscrollSpeed(-100)).toBeLessThan(0);
    // Farther from the origin is always faster, with no ceiling.
    expect(autoscrollSpeed(400)).toBeGreaterThan(autoscrollSpeed(200));
    expect(autoscrollSpeed(1000)).toBeGreaterThan(autoscrollSpeed(400));
  });

  it("carries sub-pixel distance between frames so slow speeds still move in whole pixels", () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const move = vi.fn();
    const controller = new AutoscrollController(document, () => ({ axes: "vertical", move }));
    controller.addDocument(document);
    pointer("pointerdown", document.body, { button: 1, clientX: 0, clientY: 0 });
    // 30 px down scrolls at about 39 px/s: well under a pixel per frame.
    pointer("pointermove", document.body, { clientX: 0, clientY: 30 });
    for (let time = 0; time <= 1000; time += 16) callbacks.shift()!(time);
    const moved = move.mock.calls.reduce((sum, [, y]) => sum + y, 0);
    expect(move.mock.calls.every(([, y]) => Number.isInteger(y) && y > 0)).toBe(true);
    expect(moved).toBeGreaterThan(30);
    expect(moved).toBeLessThan(40);
    controller.dispose();
  });

  it("scrolls from book documents, cancels without clicking underneath, and releases frames and listeners", () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const move = vi.fn();
    const stopped = vi.fn();
    const clicked = vi.fn();
    const controller = new AutoscrollController(
      document,
      () => ({ axes: "vertical", move }),
      stopped,
    );
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const doc = frame.contentDocument!;
    controller.addDocument(document);
    controller.addDocument(doc);
    controller.addDocument(doc);
    pointer("pointerdown", doc.body, { button: 1, clientX: 30, clientY: 30 });
    expect(document.querySelector(".autoscroll-marker")).not.toBeNull();
    pointer("pointermove", document.body, { clientX: 130, clientY: 130 });
    callbacks.shift()!(100);
    callbacks.shift()!(116);
    expect(move).toHaveBeenCalledWith(0, expect.any(Number));
    expect(move.mock.calls[0][1]).toBeGreaterThan(0);
    document.body.addEventListener("click", clicked);
    pointer("pointerdown", document.body, { button: 0 });
    pointer("click", document.body, { button: 0 });
    expect(clicked).not.toHaveBeenCalled();
    expect(stopped).toHaveBeenCalledOnce();
    expect(document.querySelector(".autoscroll-marker")).toBeNull();
    expect(doc.documentElement).not.toHaveClass("autoscroll-active");
    controller.dispose();
    expect(cancel).toHaveBeenCalled();
    pointer("pointerdown", doc.body, { button: 1 });
    expect(document.querySelector(".autoscroll-marker")).toBeNull();
  });

  it.each(["keydown", "wheel", "pointercancel", "blur", "resize", "pagehide"])(
    "cancels on %s",
    (type) => {
      vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
      const controller = new AutoscrollController(document, () => ({
        axes: "both",
        move: vi.fn(),
      }));
      controller.addDocument(document);
      pointer("pointerdown", document.body, { button: 1 });
      const event =
        type === "keydown"
          ? new KeyboardEvent(type, { key: "Escape", cancelable: true })
          : new Event(type);
      (type === "blur" || type === "resize" || type === "pagehide"
        ? window
        : document
      ).dispatchEvent(event);
      expect(document.querySelector(".autoscroll-marker")).toBeNull();
      controller.dispose();
    },
  );
});

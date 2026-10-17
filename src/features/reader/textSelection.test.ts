import { afterEach, describe, expect, it, vi } from "vitest";
import { watchTextSelection } from "./textSelection";
import { defaultLookupTriggers, type LookupTriggerPreferences } from "./lookupTriggers";
import { FuriganaSession } from "./furigana";

// These gesture regressions deliberately enable selection, left clicks and delayed hover.
const selectionTriggers = {
  ...defaultLookupTriggers,
  readerPopupMouseSelection: true,
  readerPopupMouseTrigger: "left" as const,
  readerPopupHoverDelay: 420,
};

function book(patch: Partial<LookupTriggerPreferences> = {}) {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const doc = iframe.contentDocument!;
  doc.body.innerHTML = "<p><ruby>読<rt>よ</rt></ruby><span>書する</span></p><input />";
  const ruby = doc.querySelector("ruby")!.firstChild!;
  const span = doc.querySelector("span")!.firstChild!;
  const createRange = doc.createRange.bind(doc);
  let hitNode: Node = ruby;
  vi.spyOn(doc, "createRange").mockImplementation(() => {
    const range = createRange();
    range.getClientRects = () =>
      [
        { left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20 },
      ] as unknown as DOMRectList;
    return range;
  });
  Object.defineProperty(doc, "caretRangeFromPoint", {
    value: () => {
      const range = createRange();
      range.setStart(hitNode, 0);
      return range;
    },
  });
  const report = vi.fn();
  const scans = vi.fn(() => 1);
  const cleanup = watchTextSelection(doc, () => undefined, report, scans, {
    ...selectionTriggers,
    ...patch,
  });
  const pointer = (type: string, init: MouseEventInit = {}) =>
    doc.dispatchEvent(
      new MouseEvent(type, { clientX: 20, clientY: 20, bubbles: true, cancelable: true, ...init }),
    );
  const key = (init: KeyboardEventInit, target: EventTarget = doc) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const select = () => {
    const range = doc.createRange();
    range.setStart(ruby, 0);
    range.setEnd(span, 1);
    doc.getSelection()!.removeAllRanges();
    doc.getSelection()!.addRange(range);
    return range;
  };
  return {
    doc,
    iframe,
    report,
    scans,
    cleanup,
    pointer,
    key,
    select,
    hit: (node: Node = span) => {
      hitNode = node;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("Reader lookup gesture precedence and cancellation", () => {
  it.each(["partial", "toggle", "full"] as const)(
    "%s ruby activation owns direct click lookup while selections and Shift scans remain available",
    (style) => {
      vi.useFakeTimers();
      const view = book({ readerPopupClickLookup: true });
      const session = new FuriganaSession(
        () => session.apply(view.doc, 0, true, style),
        () => true,
      );
      session.apply(view.doc, 0, true, style);
      session.watchDocuments([view.doc]);
      const ruby = view.doc.querySelector("ruby")!;
      const pointer = (type: string) =>
        ruby.dispatchEvent(
          new MouseEvent(type, { clientX: 20, clientY: 20, bubbles: true, cancelable: true }),
        );
      pointer("mousedown");
      pointer("pointerdown");
      expect(pointer("pointerup")).toBe(false);
      pointer("click");
      vi.runAllTimers();
      expect(ruby.hasAttribute("data-komori-furigana-revealed")).toBe(true);
      expect(view.report).not.toHaveBeenCalled();
      expect(view.scans).not.toHaveBeenCalled();
      view.pointer("pointermove", { shiftKey: true });
      expect(view.report).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ origin: "shift", text: "読書する" }),
      );
      view.report.mockClear();
      pointer("pointerdown");
      view.select();
      expect(pointer("pointerup")).toBe(true);
      vi.runAllTimers();
      expect(view.report).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ origin: "pointer", text: "読書" }),
      );
      session.dispose();
      view.cleanup();
    },
  );

  it.each([false, true])(
    "gates every automatic English gesture before reporting or allocating scans (CJK only %s)",
    (enabled) => {
      vi.useFakeTimers();
      const view = book({
        readerPopupCjkOnly: enabled,
        readerPopupClickLookup: true,
        readerPopupHoverLookup: true,
      });
      view.doc.querySelector("ruby")!.firstChild!.textContent = "English";
      view.doc.querySelector("span")!.firstChild!.textContent = " text";
      const range = view.select();
      view.pointer("pointerup");
      vi.runAllTimers();
      view.doc.getSelection()!.removeAllRanges();
      view.doc.getSelection()!.addRange(range);
      view.key({ key: "Enter", shiftKey: true });
      view.doc.getSelection()!.removeAllRanges();
      view.pointer("pointermove", { shiftKey: true });
      view.pointer("pointermove");
      vi.runAllTimers();
      view.pointer("pointerdown");
      view.pointer("pointerup");
      vi.runAllTimers();
      if (enabled) {
        expect(view.report.mock.calls.filter(([selection]) => selection !== null)).toHaveLength(0);
        expect(view.scans).not.toHaveBeenCalled();
      } else {
        expect(view.report.mock.calls.map(([selection]) => selection?.origin)).toEqual(
          expect.arrayContaining(["pointer", "shortcut", "shift", "hover", "click"]),
        );
        expect(view.scans).toHaveBeenCalled();
      }
      view.cleanup();
    },
  );

  it.each([
    ["shift-enter", { key: "Enter", shiftKey: true }],
    ["alt-x", { key: "X", altKey: true }],
    ["ctrl-space", { key: " ", ctrlKey: true }],
  ] as const)(
    "handles %s only with selected text, preserves its range, and ignores editable input",
    (preset, input) => {
      const view = book({ readerPopupShortcutPreset: preset });
      expect(view.key(input).defaultPrevented).toBe(false);
      const range = view.select();
      expect(view.key(input, view.doc.querySelector("input")!).defaultPrevented).toBe(false);
      expect(view.key({ ...input, repeat: true }).defaultPrevented).toBe(false);
      expect(view.key({ ...input, isComposing: true }).defaultPrevented).toBe(false);
      expect(view.key(input, document).defaultPrevented).toBe(true);
      expect(view.report).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ origin: "shortcut", text: "読書" }),
      );
      view.doc.dispatchEvent(new KeyboardEvent("keyup", input));
      expect(view.report).toHaveBeenCalledTimes(1);
      expect(view.doc.getSelection()!.getRangeAt(0)).toBe(range);
      view.cleanup();
      expect(view.key(input).defaultPrevented).toBe(false);
    },
  );

  it("gates shortcuts and Shift before allocating scans, retaining keyboard release", () => {
    const view = book({ readerPopupKeyboardShortcut: false, readerPopupShiftLookup: false });
    view.pointer("pointermove", { shiftKey: true });
    view.key({ key: "Shift" });
    view.select();
    expect(view.key({ key: "Enter", shiftKey: true }).defaultPrevented).toBe(false);
    expect(view.report).not.toHaveBeenCalled();
    expect(view.scans).not.toHaveBeenCalled();
    view.doc.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", shiftKey: true }));
    expect(view.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ origin: "keyboard" }),
    );
    view.cleanup();
  });

  it("an app-focused shortcut does not consume a later changed book keyboard selection", () => {
    const view = book();
    view.select();
    view.key({ key: "Enter", shiftKey: true }, document);
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", shiftKey: true }));
    const range = view.doc.getSelection()!.getRangeAt(0);
    range.setEnd(view.doc.querySelector("span")!.firstChild!, 2);
    view.doc.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", shiftKey: true }));
    expect(view.report).toHaveBeenCalledTimes(2);
    expect(view.report).toHaveBeenLastCalledWith(
      expect.objectContaining({ origin: "keyboard", text: "読書す" }),
    );
    view.cleanup();
  });

  it("a direct left click scans ruby base text, but a selection or drag wins", () => {
    vi.useFakeTimers();
    const view = book({ readerPopupClickLookup: true, readerPopupHoverLookup: true });
    view.pointer("pointerdown");
    view.pointer("pointerup");
    vi.runAllTimers();
    expect(view.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ origin: "click", text: "読書する", scanId: 1 }),
    );
    view.report.mockClear();
    view.pointer("pointerdown");
    view.select();
    view.pointer("pointermove", { buttons: 1, clientX: 28 });
    view.pointer("pointerup");
    vi.runAllTimers();
    expect(view.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ origin: "pointer", text: "読書" }),
    );
    view.report.mockClear();
    view.pointer("pointerdown");
    view.doc.getSelection()!.removeAllRanges();
    view.pointer("pointermove", { buttons: 1, clientX: 29 });
    view.pointer("pointerup");
    vi.runAllTimers();
    expect(view.report.mock.calls.filter(([value]) => value?.origin === "click")).toHaveLength(0);
    view.cleanup();
  });

  it("double click wins over its automatic selection report and leaves selection usable", () => {
    vi.useFakeTimers();
    const view = book({ readerPopupClickLookup: true, readerPopupMouseTrigger: "double" });
    view.pointer("pointerdown");
    const range = view.select();
    // Real WebView2 PointerEvent.detail is zero on a double-click release.
    view.pointer("pointerup", { detail: 0 });
    view.pointer("dblclick", { detail: 2 });
    vi.runAllTimers();
    expect(view.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ origin: "click", text: "読書する" }),
    );
    expect(view.doc.getSelection()!.getRangeAt(0)).toBe(range);
    view.cleanup();
  });

  it("keeps the context menu unless a configured Shift right click hits readable text", () => {
    const view = book({ readerPopupClickLookup: true, readerPopupMouseTrigger: "shift-right" });
    expect(view.pointer("contextmenu", { button: 2 })).toBe(true);
    expect(view.pointer("contextmenu", { button: 0, shiftKey: true })).toBe(true);
    expect(view.pointer("contextmenu", { button: 2, shiftKey: true, clientX: 40 })).toBe(true);
    expect(view.pointer("contextmenu", { button: 2, shiftKey: true })).toBe(false);
    expect(view.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ origin: "click" }),
    );
    view.cleanup();
    const disabled = book({
      readerPopupClickLookup: false,
      readerPopupMouseTrigger: "shift-right",
    });
    expect(disabled.pointer("contextmenu", { button: 2, shiftKey: true })).toBe(true);
    expect(disabled.report).not.toHaveBeenCalled();
    disabled.cleanup();
  });

  it("a configured middle press scans readable text ahead of autoscroll, and blank space keeps it", () => {
    const view = book({ readerPopupClickLookup: true, readerPopupMouseTrigger: "middle" });
    const later = vi.fn();
    view.doc.addEventListener("pointerdown", later, true);
    expect(view.pointer("pointerdown", { button: 1, clientX: 40 })).toBe(true);
    expect(later).toHaveBeenCalledOnce();
    expect(view.report).not.toHaveBeenCalled();
    expect(view.pointer("pointerdown", { button: 1 })).toBe(false);
    expect(later).toHaveBeenCalledOnce();
    expect(view.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ origin: "click", text: "読書する" }),
    );
    expect(view.pointer("auxclick", { button: 1 })).toBe(false);
    view.cleanup();
    for (const settings of [
      { readerPopupClickLookup: false, readerPopupMouseTrigger: "middle" as const },
      { readerPopupClickLookup: true, readerPopupMouseTrigger: "left" as const },
    ]) {
      const other = book(settings);
      expect(other.pointer("pointerdown", { button: 1 })).toBe(true);
      expect(other.report).not.toHaveBeenCalled();
      other.cleanup();
    }
  });

  it.each([150, 420, 1200])(
    "hovers once after %i ms on the same character, resetting on a new character",
    (delay) => {
      vi.useFakeTimers();
      const view = book({ readerPopupHoverLookup: true, readerPopupHoverDelay: delay });
      view.pointer("pointermove");
      vi.advanceTimersByTime(delay - 1);
      expect(view.report).not.toHaveBeenCalled();
      view.pointer("pointermove", { clientX: 21 });
      vi.advanceTimersByTime(1);
      expect(view.report).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ origin: "hover", text: "読書する" }),
      );
      view.pointer("pointermove");
      vi.advanceTimersByTime(delay);
      expect(view.report).toHaveBeenCalledTimes(1);
      view.hit();
      view.pointer("pointermove");
      vi.advanceTimersByTime(delay);
      expect(view.report).toHaveBeenLastCalledWith(expect.objectContaining({ text: "書する" }));
      expect(view.report).toHaveBeenCalledTimes(2);
      view.cleanup();
    },
  );

  it.each([
    "leave",
    "blur",
    "scroll",
    "pointercancel",
    "pointerdown",
    "key",
    "off-text",
    "invalidate",
    "dispose",
  ])("cancels delayed hover on %s", (action) => {
    vi.useFakeTimers();
    const view = book({ readerPopupHoverLookup: true });
    view.pointer("pointermove");
    vi.advanceTimersByTime(200);
    if (action === "leave") view.doc.documentElement.dispatchEvent(new Event("pointerleave"));
    else if (action === "blur") view.doc.defaultView!.dispatchEvent(new Event("blur"));
    else if (action === "key") view.key({ key: "a" });
    else if (action === "off-text") view.pointer("pointermove", { clientX: 100 });
    else if (action === "invalidate") view.cleanup.cancelPending();
    else if (action === "dispose") view.cleanup();
    else view.pointer(action);
    vi.runAllTimers();
    expect(view.report).not.toHaveBeenCalled();
    view.cleanup();
  });

  it("Shift takes priority over hover and left click on the same gesture", () => {
    vi.useFakeTimers();
    const view = book({ readerPopupClickLookup: true, readerPopupHoverLookup: true });
    view.pointer("pointermove", { shiftKey: true });
    view.pointer("pointerdown", { shiftKey: true });
    view.pointer("pointerup", { shiftKey: true });
    vi.runAllTimers();
    expect(view.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ origin: "shift" }),
    );
    view.cleanup();
  });

  it("master disable suppresses every gesture before a scan allocation", () => {
    vi.useFakeTimers();
    const view = book({
      readerPopupEnabled: false,
      readerPopupClickLookup: true,
      readerPopupHoverLookup: true,
    });
    view.select();
    view.key({ key: "Enter", shiftKey: true });
    view.pointer("pointermove", { shiftKey: true });
    view.pointer("pointermove");
    view.pointer("pointerup");
    vi.runAllTimers();
    expect(view.report).not.toHaveBeenCalled();
    expect(view.scans).not.toHaveBeenCalled();
    view.cleanup();
  });

  it("settings changes cancel timers and wait for fresh input, while retaining selection-clear ownership", () => {
    vi.useFakeTimers();
    const view = book({ readerPopupHoverLookup: true });
    view.pointer("pointermove");
    vi.advanceTimersByTime(200);
    view.cleanup.setSettings({ ...selectionTriggers, readerPopupHoverLookup: false });
    view.cleanup.setSettings({ ...selectionTriggers, readerPopupHoverLookup: true });
    vi.runAllTimers();
    expect(view.report).not.toHaveBeenCalled();
    view.key({ key: "Shift" });
    expect(view.report).not.toHaveBeenCalled();
    const range = view.select();
    view.pointer("pointerup");
    vi.runAllTimers();
    expect(view.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ origin: "pointer" }),
    );
    view.cleanup.setSettings({ ...selectionTriggers, readerPopupClickLookup: true });
    expect(view.doc.getSelection()!.getRangeAt(0)).toBe(range);
    view.doc.dispatchEvent(new KeyboardEvent("keyup", { key: "a" }));
    expect(view.report).toHaveBeenCalledTimes(1);
    view.doc.getSelection()!.removeAllRanges();
    view.doc.dispatchEvent(new Event("selectionchange"));
    expect(view.report).toHaveBeenLastCalledWith(null);
    view.cleanup();
  });
});

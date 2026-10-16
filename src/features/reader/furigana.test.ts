import { describe, expect, it, vi } from "vitest";
import { FuriganaSession } from "./furigana";
import { readableText } from "./readingMeasure";
import type { ReaderFuriganaStyle } from "./presentation";

const action = "data-komori-furigana-action";
const revealed = "data-komori-furigana-revealed";
function bookDocument() {
  const doc = document.implementation.createHTMLDocument();
  doc.body.innerHTML =
    '<p><ruby role="note" tabindex="-1" aria-label="Original">漢<rp>(</rp><rt>かん</rt><rp>)</rp></ruby>字 <ruby>本<rt>ほん</rt></ruby></p>';
  return doc;
}
const rules = (doc: Document) => doc.querySelector("style[data-komori-hide-furigana]")?.textContent;

function fixture(mode: ReaderFuriganaStyle = "toggle") {
  const doc = bookDocument();
  const session = new FuriganaSession(
    () => session.apply(doc, 2, true, mode),
    () => true,
  );
  session.apply(doc, 2, true, mode);
  session.watchDocuments([doc]);
  return { doc, session, ruby: doc.querySelector("ruby")! };
}

describe("furigana styles and session reveals", () => {
  it.each(["hide", "partial", "toggle", "full"] as const)(
    "keeps base text, annotations and XHTML in %s",
    (mode) => {
      const { doc, session } = fixture(mode);
      expect(readableText(doc)).toBe("漢字 本");
      expect(doc.querySelector("rt")?.textContent).toBe("かん");
      const serialized = new XMLSerializer().serializeToString(doc);
      expect(serialized).toContain("data-komori-hide-furigana");
      expect(serialized).not.toContain("&gt;");
      expect(rules(doc)).toContain(
        mode === "hide"
          ? "display: none"
          : mode === "partial"
            ? "opacity: 0.35"
            : "visibility: hidden",
      );
      if (mode === "hide") expect(doc.querySelector(`[${action}]`)).toBeNull();
      else expect(doc.querySelectorAll(`[${action}]`)).toHaveLength(2);
      session.dispose();
    },
  );

  it("toggles one occurrence, consumes the plain click and remembers a serialized view", () => {
    const { doc, session, ruby } = fixture();
    const downstream = vi.fn();
    doc.addEventListener("click", downstream);
    const click = () =>
      ruby.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(click()).toBe(false);
    expect(ruby?.hasAttribute(revealed)).toBe(true);
    expect(ruby?.getAttribute("aria-label")).toBe("Hide reading for 漢");
    expect(ruby?.getAttribute("aria-pressed")).toBe("true");
    expect(doc.querySelectorAll("ruby")[1]?.hasAttribute(revealed)).toBe(false);
    expect(downstream).not.toHaveBeenCalled();
    const revisited = new DOMParser().parseFromString(
      new XMLSerializer().serializeToString(doc),
      "application/xhtml+xml",
    );
    session.apply(revisited, 2, true, "toggle");
    expect(revisited.querySelector("ruby")?.hasAttribute(revealed)).toBe(true);
    session.apply(revisited, 3, true, "toggle");
    expect(revisited.querySelector("ruby")?.hasAttribute(revealed)).toBe(false);
    click();
    expect(ruby?.hasAttribute(revealed)).toBe(false);
    session.dispose();
  });

  it.each(["partial", "full"] as const)(
    "%s reveals on click and stays revealed on another click",
    (mode) => {
      const { ruby, doc, session } = fixture(mode);
      expect(rules(doc)).toContain("@media (hover: hover)");
      ruby.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      ruby.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(ruby?.hasAttribute(revealed)).toBe(true);
      session.dispose();
    },
  );

  it("Toggle has no hover reveal and accepts Enter/Space once per press", () => {
    const { ruby, doc, session } = fixture();
    expect(rules(doc)).not.toContain(":hover");
    ruby.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(ruby?.hasAttribute(revealed)).toBe(true);
    ruby.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, repeat: true }));
    expect(ruby?.hasAttribute(revealed)).toBe(true);
    ruby.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(ruby?.hasAttribute(revealed)).toBe(false);
    session.dispose();
  });

  it("leaves selection, modified gestures and links available", () => {
    const { ruby, doc, session } = fixture();
    const downstream = vi.fn();
    doc.addEventListener("click", downstream);
    for (const modifiers of [
      { shiftKey: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
      { button: 1 },
    ])
      ruby.dispatchEvent(new MouseEvent("click", { bubbles: true, ...modifiers }));
    expect(downstream).toHaveBeenCalledTimes(5);
    vi.spyOn(doc, "getSelection").mockReturnValue({ isCollapsed: false } as Selection);
    ruby.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(downstream).toHaveBeenCalledTimes(6);
    expect(ruby?.hasAttribute(revealed)).toBe(false);
    const link = doc.createElement("a");
    link.href = "#chapter";
    doc.body.append(link);
    link.append(doc.querySelectorAll("ruby")[1]);
    session.apply(doc, 3, true, "toggle");
    expect(link.querySelector("ruby")?.hasAttribute(action)).toBe(false);
    session.dispose();
  });

  it("allows Chromium drags starting on ruby while restoring keyboard access and cleaning timers", () => {
    vi.useFakeTimers();
    try {
      const { ruby, doc, session } = fixture();
      const press = () =>
        ruby.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      // Leave the browser's default selection action available, without mouse focus.
      expect(press()).toBe(true);
      expect(ruby.hasAttribute("tabindex")).toBe(false);
      vi.runAllTimers();
      expect(ruby.getAttribute("tabindex")).toBe("0");
      press();
      session.watchDocuments([]);
      expect(ruby.getAttribute("tabindex")).toBe("0");
      expect(vi.getTimerCount()).toBe(0);
      session.watchDocuments([doc]);
      press();
      session.apply(doc, 2, false, "toggle");
      vi.runAllTimers();
      expect(ruby.getAttribute("tabindex")).toBe("-1");
      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores publisher attributes on off/Hide and retains the session reveal", () => {
    const { ruby, doc, session } = fixture();
    ruby.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    session.apply(doc, 2, false, "full");
    expect(rules(doc)).toBeUndefined();
    expect(ruby?.getAttribute("role")).toBe("note");
    expect(ruby?.getAttribute("tabindex")).toBe("-1");
    expect(ruby?.getAttribute("aria-label")).toBe("Original");
    expect(ruby?.hasAttribute("aria-pressed")).toBe(false);
    session.apply(doc, 2, true, "hide");
    expect(ruby?.hasAttribute(action)).toBe(false);
    session.apply(doc, 2, true, "toggle");
    expect(ruby?.hasAttribute(revealed)).toBe(true);
    expect(doc.querySelectorAll("style[data-komori-hide-furigana]")).toHaveLength(1);
    session.dispose();
  });

  it("releases discarded document listeners and clears reveals on book disposal", () => {
    const { ruby, doc, session } = fixture();
    session.watchDocuments([]);
    ruby.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(ruby?.hasAttribute(revealed)).toBe(false);
    session.watchDocuments([doc]);
    ruby.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(ruby?.hasAttribute(revealed)).toBe(true);
    session.dispose();
    const downstream = vi.fn();
    doc.addEventListener("click", downstream);
    ruby.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(downstream).toHaveBeenCalledOnce();
    const newBook = new FuriganaSession(
      () => {},
      () => true,
    );
    newBook.apply(doc, 2, true, "toggle");
    expect(ruby?.hasAttribute(revealed)).toBe(false);
    newBook.dispose();
  });

  it("does not change a reveal while the renderer is navigating or disposed", () => {
    const doc = bookDocument();
    const refresh = vi.fn();
    const session = new FuriganaSession(refresh, () => false);
    session.apply(doc, 0, true, "toggle");
    session.watchDocuments([doc]);
    doc.querySelector("ruby")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(refresh).not.toHaveBeenCalled();
    session.dispose();
    session.apply(doc, 0, false, "hide");
    expect(rules(doc)).toContain("visibility: hidden");
  });
});

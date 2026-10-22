import { describe, expect, it } from "vitest";
import {
  LOOKUP_MARKS,
  markBoxes,
  NOTE_HOVER,
  NOTE_MARKS,
  noteAtPoint,
  noteHoverCursor,
  noteHighlightRanges,
  paintLookupMatch,
  paintSelection,
  SELECTION_MARKS,
  textRanges,
} from "./noteHighlights";

const locator = { spineIndex: 0, sectionKey: "abcd1234", contentKey: "a".repeat(64), progress: 0 };
describe("saved passage paint resolution", () => {
  it("resolves ruby base, inline and supplementary text at the saved occurrence, excluding annotations", () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = "<p>本文 Before <ruby>本<rt>ほん</rt></ruby><b>文𠮷</b> after 本文𠮷</p>";
    const start = "本文 Before ".length;
    const note = {
      passage: "本文𠮷",
      locator: { ...locator, progress: start / doc.body.textContent!.length },
    };
    const html = doc.body.innerHTML;
    const ranges = noteHighlightRanges(doc, note);
    expect(ranges.map((r) => r.toString())).toEqual(["本", "文𠮷"]);
    expect(doc.body.innerHTML).toBe(html);
    expect(noteHighlightRanges(doc, { ...note, passage: "Missing" })).toEqual([]);
    expect(
      noteHighlightRanges(doc, {
        ...note,
        locator: { ...locator, progress: (start - 3) / doc.body.textContent!.length },
      }),
    ).toEqual([]);
  });
  it("resolves captured multiline passages with trimmed whitespace and ignores inactive text", () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = "<p>  First<br>Line</p><p>Next <span hidden>hidden</span>end</p>";
    const ranges = noteHighlightRanges(doc, { passage: "First\nLine\nNext end", locator });
    expect(ranges.map((r) => r.toString()).join("")).toBe("FirstLineNext end");
    expect(ranges.every((r) => !r.startContainer.parentElement?.closest("[hidden]"))).toBe(true);
  });
  it("pads marks around their letters, joins one line's pieces and keeps lines apart", () => {
    const line = (left: number, top: number, width: number) => ({ left, top, width, height: 20 });
    // Two pieces of one line, then the next line.
    const boxes = markBoxes([line(0, 0, 40), line(40, 0, 30), line(0, 30, 50)], false);
    expect(boxes).toHaveLength(2);
    expect(boxes[0].left).toBeCloseTo(-3);
    expect(boxes[0].width).toBeCloseTo(76);
    expect(boxes[0].top).toBeCloseTo(-2.4);
    expect(boxes[0].height).toBeCloseTo(24.8);
    expect(boxes[1].top).toBeGreaterThan(boxes[0].top + boxes[0].height);
    // Far apart on one line, two passages stay two marks; empty boxes paint nothing.
    expect(markBoxes([line(0, 0, 20), line(200, 0, 20), line(0, 0, 0)], false)).toHaveLength(2);
  });
  it("pads vertical lines across their width", () => {
    const [box] = markBoxes(
      [
        { left: 100, top: 0, width: 20, height: 60 },
        { left: 100, top: 60, width: 20, height: 40 },
      ],
      true,
    );
    expect(box.left).toBeCloseTo(97.6);
    expect(box.width).toBeCloseTo(24.8);
    expect(box.top).toBeCloseTo(-3);
    expect(box.height).toBeCloseTo(106);
  });
  it("rules every line of a passage with the same room, never touching the next line", () => {
    // Lines 24px apart with 20px of text: 4px between them leaves 1px of room each way.
    const boxes = markBoxes(
      [0, 24, 48].map((top) => ({ left: 0, top, width: 50, height: 20 })),
      false,
    );
    expect(boxes.map((box) => box.height)).toEqual([22, 22, 22]);
    for (let index = 1; index < boxes.length; index++)
      expect(boxes[index].top - (boxes[index - 1].top + boxes[index - 1].height)).toBe(2);
  });
  it("marks each piece of text without indents, line breaks or annotations", () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = "<p>　First line\n</p>\n\n<p>  <ruby>本<rt>ほん</rt></ruby>文 </p>";
    const range = doc.createRange();
    range.selectNodeContents(doc.body);
    expect(textRanges(range).map((piece) => piece.toString())).toEqual(["First line", "本", "文"]);
  });
});

describe("saved passage clicks and the painted selection", () => {
  it("names the note whose mark is under a point, the later one first", () => {
    const doc = document.implementation.createHTMLDocument();
    const layer = doc.createElement("div");
    layer.setAttribute(NOTE_MARKS, "");
    const mark = (id: string, left: number) => {
      const span = doc.createElement("span");
      span.setAttribute("data-note-id", id);
      span.getBoundingClientRect = () =>
        ({ left, right: left + 40, top: 0, bottom: 20 }) as DOMRect;
      layer.append(span);
    };
    mark("first", 0);
    mark("second", 30);
    doc.documentElement.append(layer);
    expect(noteAtPoint(doc, 10, 10)).toBe("first");
    expect(noteAtPoint(doc, 35, 10)).toBe("second");
    expect(noteAtPoint(doc, 100, 10)).toBeNull();
  });
  it("shows the hand over a saved passage, but not while selecting or pressing", () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = "<p>Saved passage</p>";
    const layer = doc.createElement("div");
    layer.setAttribute(NOTE_MARKS, "");
    const span = doc.createElement("span");
    span.setAttribute("data-note-id", "note");
    span.getBoundingClientRect = () => ({ left: 0, right: 40, top: 0, bottom: 20 }) as DOMRect;
    layer.append(span);
    doc.documentElement.append(layer);
    const stop = noteHoverCursor(doc);
    const root = doc.documentElement;
    const move = (x: number, buttons = 0) =>
      doc.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: 10, buttons }));
    expect(doc.querySelector(`[${NOTE_HOVER}-style]`)?.textContent).toContain("cursor: pointer");
    move(10);
    expect(root.hasAttribute(NOTE_HOVER)).toBe(true);
    move(100);
    expect(root.hasAttribute(NOTE_HOVER)).toBe(false);
    move(10, 1);
    expect(root.hasAttribute(NOTE_HOVER)).toBe(false);
    move(10);
    root.dispatchEvent(new MouseEvent("pointerleave"));
    expect(root.hasAttribute(NOTE_HOVER)).toBe(false);
    move(10);
    stop();
    expect(root.hasAttribute(NOTE_HOVER)).toBe(false);
    expect(doc.querySelector(`[${NOTE_HOVER}-style]`)).toBeNull();
  });
  it("adds its marks only while text is selected", () => {
    // A document with a window, as a displayed section has.
    const doc = document;
    doc.body.innerHTML = "<p>Selected text</p>";
    const stop = paintSelection(doc);
    const marks = () => doc.documentElement.querySelector(`[${SELECTION_MARKS}]`);
    expect(marks()).toBeNull();
    doc.getSelection()!.selectAllChildren(doc.body);
    doc.dispatchEvent(new Event("selectionchange"));
    expect(marks()).not.toBeNull();
    expect(doc.querySelector(`[${SELECTION_MARKS}-hide]`)?.textContent).toContain("::selection");
    doc.getSelection()!.removeAllRanges();
    doc.dispatchEvent(new Event("selectionchange"));
    expect(marks()).toBeNull();
    expect(doc.querySelector(`[${SELECTION_MARKS}-hide]`)).toBeNull();
    stop();
    doc.body.replaceChildren();
  });
  it("marks a lookup's match as selected text is marked, without selecting it", () => {
    const doc = document;
    doc.body.innerHTML = "<p>読む本</p>";
    const text = doc.querySelector("p")!.firstChild!;
    const match = doc.createRange();
    match.setStart(text, 0);
    match.setEnd(text, 2);
    const marks = () => doc.documentElement.querySelector(`:scope > [${LOOKUP_MARKS}]`);
    expect(paintLookupMatch(doc, [])).toBeTypeOf("function");
    expect(marks()).toBeNull();
    const clear = paintLookupMatch(doc, [match]);
    // The selection's rounded marks, in their own layer outside the body.
    expect(marks()?.getAttribute("aria-hidden")).toBe("true");
    expect(doc.querySelector(`[${LOOKUP_MARKS}-style]`)?.textContent).toContain(
      "border-radius: 0.2em",
    );
    expect(doc.getSelection()!.rangeCount).toBe(0);
    clear();
    expect(marks()).toBeNull();
    expect(doc.querySelector(`[${LOOKUP_MARKS}-style]`)).toBeNull();
    doc.body.replaceChildren();
  });
});

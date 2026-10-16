import { searchText } from "./bookSearch";
import type { NotePassage } from "./notes";

const excluded = "rt, rp, script, style, template, noscript, [hidden], [aria-hidden='true']";

/** Resolve only the saved start, never another occurrence of the same passage. */
export function noteHighlightRanges(document: Document, note: NotePassage): Range[] {
  return noteHighlightResolver(document)(note);
}

/** Build the section text map once for all annotations in that displayed document. */
export function noteHighlightResolver(document: Document): (note: NotePassage) => Range[] {
  if (!document.body) return () => [];
  const nodes: Array<{ node: Text; offset: number }> = [];
  let total = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, offset: total });
    total += (node as Text).length;
  }
  const mapped = searchText(document);
  return (note) => {
    const start = Math.round(note.locator.progress * total);
    const firstNode = nodes.find(
      ({ node, offset }) => offset + node.length > start && !node.parentElement?.closest(excluded),
    );
    if (!firstNode) return [];
    const mappedStart = mapped.offsetAt(firstNode.node, Math.max(0, start - firstNode.offset));
    if (mappedStart === null) return [];
    // Capture adds paragraph breaks; rendered whitespace can differ at those boundaries.
    const pattern = note.passage
      .split(/\s+/u)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    const match = new RegExp(`^(\\s*)(${pattern})`, "u").exec(mapped.text.slice(mappedStart));
    if (!match) return [];
    const first = mapped.point(mappedStart + match[1].length);
    const last = mapped.point(mappedStart + match[0].length - 1);
    if (!first || !last) return [];
    const before = document.createRange();
    before.setStart(document.body, 0);
    before.setEnd(first.startContainer, first.startOffset);
    const offset = before.toString().length;
    const endNode = nodes.find((item) => item.node === last.startContainer);
    if (!endNode) return [];
    const end = endNode.offset + last.startOffset + 1;
    return nodes.flatMap(({ node, offset: nodeStart }) => {
      if (
        nodeStart + node.length <= offset ||
        nodeStart >= end ||
        node.parentElement?.closest(excluded)
      )
        return [];
      const range = document.createRange();
      range.setStart(node, Math.max(0, offset - nodeStart));
      range.setEnd(node, Math.min(node.length, end - nodeStart));
      return [range];
    });
  };
}

/** The layer that holds a section's saved-passage marks, outside the book's body. */
export const NOTE_MARKS = "data-komori-note-marks";
/** The layer that paints the reader's text selection the same way, above saved passages. */
export const SELECTION_MARKS = "data-komori-selection-marks";
/** Each saved-passage mark names its note. */
const NOTE_ID = "data-note-id";
const XHTML = "http://www.w3.org/1999/xhtml";

/**
 * A range's text as one range per text node, without annotations and without the
 * whitespace at either end of each piece, so a paragraph's indent or the line breaks
 * between blocks are never marked.
 */
export function textRanges(range: Range): Range[] {
  const root = range.commonAncestorContainer;
  const document = root.ownerDocument ?? (root as Document);
  const pieces: Range[] = [];
  const add = (node: Text) => {
    if (node.parentElement?.closest(excluded)) return;
    let start = node === range.startContainer ? range.startOffset : 0;
    let end = node === range.endContainer ? range.endOffset : node.length;
    while (start < end && /\s/u.test(node.data[start])) start++;
    while (end > start && /\s/u.test(node.data[end - 1])) end--;
    if (start >= end) return;
    const piece = document.createRange();
    piece.setStart(node, start);
    piece.setEnd(node, end);
    pieces.push(piece);
  };
  if (root.nodeType === Node.TEXT_NODE) {
    add(root as Text);
    return pieces;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (range.intersectsNode(node)) add(node as Text);
  return pieces;
}

export interface MarkBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The smallest space kept between the marks of neighbouring lines, in pixels. */
const LINE_GAP = 2;

/**
 * Padded boxes behind a passage's text, one per line: pieces of one line join into one box,
 * each box leaves a little room around the letters, and every line gets the same room
 * across it, never reaching into the next line, so a passage reads as evenly ruled lines.
 */
export function markBoxes(rects: readonly MarkBox[], vertical: boolean): MarkBox[] {
  // Along the line and across it, whatever the writing direction.
  const lines = rects
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) =>
      vertical
        ? {
            start: rect.top,
            end: rect.top + rect.height,
            from: rect.left,
            to: rect.left + rect.width,
          }
        : {
            start: rect.left,
            end: rect.left + rect.width,
            from: rect.top,
            to: rect.top + rect.height,
          },
    )
    .sort((a, b) => a.from - b.from || a.start - b.start);
  const merged: typeof lines = [];
  for (const piece of lines) {
    const line = merged.find((other) => {
      const overlap = Math.min(other.to, piece.to) - Math.max(other.from, piece.from);
      const thickness = Math.min(other.to - other.from, piece.to - piece.from);
      return (
        overlap > thickness / 2 &&
        piece.start <= other.end + thickness / 2 &&
        piece.end >= other.start - thickness / 2
      );
    });
    if (!line) merged.push({ ...piece });
    else {
      line.start = Math.min(line.start, piece.start);
      line.end = Math.max(line.end, piece.end);
      line.from = Math.min(line.from, piece.from);
      line.to = Math.max(line.to, piece.to);
    }
  }
  merged.sort((a, b) => a.from - b.from || a.start - b.start);
  let across = Math.min(...merged.map((line) => (line.to - line.from) * 0.12));
  for (let index = 1; index < merged.length; index++) {
    const gap = merged[index].from - merged[index - 1].to;
    // Only neighbouring lines limit the room; marks far apart keep theirs.
    if (gap >= 0 && gap < merged[index].to - merged[index].from)
      across = Math.min(across, Math.max(0, (gap - LINE_GAP) / 2));
  }
  return merged.map((line) => {
    const thickness = line.to - line.from;
    const along = thickness * 0.15;
    const start = line.start - along;
    const length = line.end - line.start + along * 2;
    const from = line.from - across;
    const size = thickness + across * 2;
    return vertical
      ? { left: from, top: start, width: size, height: length }
      : { left: start, top: from, width: length, height: size };
  });
}

interface MarkGroup {
  /** The note a group of marks belongs to. */
  id?: string;
  ranges: Range[];
}

/**
 * A layer of padded, rounded marks behind a section's text, without changing EPUB markup,
 * selection, text measure or layout. The marks follow every reflow of the section; the
 * Reader theme's important rule sets their color, and books without one keep `fallback`.
 */
function paintMarks(
  document: Document,
  attribute: string,
  fallback: string,
  depth: number,
  groups: () => MarkGroup[],
): { schedule: () => void; clear: () => void } {
  const view = document.defaultView as (Window & typeof globalThis) | null;
  const root = document.documentElement;
  if (!view || !root) return { schedule: () => {}, clear: () => {} };
  const style = document.createElementNS(XHTML, "style");
  style.setAttribute(`${attribute}-style`, "");
  // Outside the body, so neither its columns nor its transforms move the layer.
  style.textContent =
    `:root [${attribute}] { position: absolute; inset: 0; overflow: hidden; ` +
    `pointer-events: none; z-index: ${depth}; margin: 0; padding: 0; border: 0; }\n` +
    `:root [${attribute}] span { position: absolute; border-radius: 0.2em; ` +
    `background-color: ${fallback}; }`;
  const layer = document.createElementNS(XHTML, "div");
  layer.setAttribute(attribute, "");
  layer.setAttribute("aria-hidden", "true");
  (document.head ?? root).append(style);
  root.append(layer);
  let frame = 0;
  const paint = () => {
    frame = 0;
    const writing = document.body ? view.getComputedStyle(document.body).writingMode : "";
    const vertical = writing.startsWith("vertical") || writing.startsWith("sideways");
    layer.replaceChildren(
      ...groups().flatMap(({ id, ranges }) => {
        const rects = ranges
          .flatMap(textRanges)
          .flatMap((range) =>
            typeof range.getClientRects === "function" ? [...range.getClientRects()] : [],
          );
        const boxes = markBoxes(
          rects.map((rect) => ({
            left: rect.left + view.scrollX,
            top: rect.top + view.scrollY,
            width: rect.width,
            height: rect.height,
          })),
          vertical,
        );
        return boxes.map((box) => {
          const mark = document.createElementNS(XHTML, "span") as HTMLElement;
          if (id) mark.setAttribute(NOTE_ID, id);
          mark.style.left = `${box.left}px`;
          mark.style.top = `${box.top}px`;
          mark.style.width = `${box.width}px`;
          mark.style.height = `${box.height}px`;
          return mark;
        });
      }),
    );
  };
  const schedule = () => {
    if (!frame) frame = view.requestAnimationFrame(paint);
  };
  paint();
  // Reflows (font, size, spacing, view, window) move the text; repaint after each.
  const resize =
    typeof view.ResizeObserver === "function" ? new view.ResizeObserver(schedule) : null;
  resize?.observe(root);
  if (document.body) resize?.observe(document.body);
  const mutations =
    typeof view.MutationObserver === "function" ? new view.MutationObserver(schedule) : null;
  mutations?.observe(document.head ?? root, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  mutations?.observe(root, { attributes: true, attributeFilter: ["style", "class"] });
  if (document.body)
    mutations?.observe(document.body, { attributes: true, attributeFilter: ["style", "class"] });
  view.addEventListener("resize", schedule);
  void document.fonts?.ready.then(schedule, () => {});
  return {
    schedule,
    clear: () => {
      if (frame) view.cancelAnimationFrame(frame);
      frame = -1;
      resize?.disconnect();
      mutations?.disconnect();
      view.removeEventListener("resize", schedule);
      layer.remove();
      style.remove();
    },
  };
}

/** Paint saved passages, each note's marks naming it, below the reader's selection. */
export function paintNoteHighlights(
  document: Document,
  notes: ReadonlyArray<{ id: string; ranges: Range[] }>,
): () => void {
  if (!notes.some((note) => note.ranges.length)) return () => {};
  return paintMarks(document, NOTE_MARKS, "#f0d889", -2, () =>
    notes.map(({ id, ranges }) => ({ id, ranges })),
  ).clear;
}

/** The saved passage whose mark is under a point of the section's viewport, if any. */
export function noteAtPoint(document: Document, x: number, y: number): string | null {
  const layer = document.documentElement?.querySelector(`:scope > [${NOTE_MARKS}]`);
  const marks = layer ? [...layer.children] : [];
  // A later note paints over an earlier one.
  for (const mark of marks.reverse()) {
    const box = mark.getBoundingClientRect();
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)
      return mark.getAttribute(NOTE_ID);
  }
  return null;
}

/** Set on the section's root while the pointer is over a saved passage. */
export const NOTE_HOVER = "data-komori-note-hover";

/**
 * The hand over a saved passage, whose plain click opens its menu, as over a link. The marks
 * take no pointer events, so the pointer is followed through the section instead.
 */
export function noteHoverCursor(document: Document): () => void {
  const root = document.documentElement;
  if (!root) return () => {};
  const style = document.createElementNS(XHTML, "style");
  style.setAttribute(`${NOTE_HOVER}-style`, "");
  style.textContent = `:root[${NOTE_HOVER}], :root[${NOTE_HOVER}] * { cursor: pointer !important; }`;
  (document.head ?? root).append(style);
  const move = (event: PointerEvent) => {
    const over =
      event.buttons === 0 &&
      document.getSelection()?.isCollapsed !== false &&
      !!noteAtPoint(document, event.clientX, event.clientY);
    if (root.hasAttribute(NOTE_HOVER) !== over) root.toggleAttribute(NOTE_HOVER, over);
  };
  const leave = () => root.removeAttribute(NOTE_HOVER);
  document.addEventListener("pointermove", move, { passive: true });
  root.addEventListener("pointerleave", leave);
  return () => {
    document.removeEventListener("pointermove", move);
    root.removeEventListener("pointerleave", leave);
    leave();
    style.remove();
  };
}

/**
 * Paint the reader's selection as the same ruled line marks as saved passages instead of the
 * browser's block, which fills whole lines, indents and the space between paragraphs. The
 * browser's own selection stays, transparent, so copying and lookups are unchanged. The marks
 * exist only while something is selected, so pages without a selection measure as before.
 */
export function paintSelection(document: Document): () => void {
  let painted: { style: Element; painter: ReturnType<typeof paintMarks> } | null = null;
  const ranges = () => {
    const selection = document.getSelection();
    const ranges: Range[] = [];
    if (selection && !selection.isCollapsed)
      for (let index = 0; index < selection.rangeCount; index++)
        ranges.push(selection.getRangeAt(index));
    return ranges;
  };
  const clear = () => {
    painted?.painter.clear();
    painted?.style.remove();
    painted = null;
  };
  const change = () => {
    if (!ranges().length) clear();
    else if (painted) painted.painter.schedule();
    else {
      const style = document.createElementNS(XHTML, "style");
      style.setAttribute(`${SELECTION_MARKS}-hide`, "");
      style.textContent = ":root ::selection { background-color: transparent; }";
      (document.head ?? document.documentElement)?.append(style);
      painted = {
        style,
        painter: paintMarks(document, SELECTION_MARKS, "Highlight", -1, () => [
          { ranges: ranges() },
        ]),
      };
    }
  };
  document.addEventListener("selectionchange", change);
  return () => {
    document.removeEventListener("selectionchange", change);
    clear();
  };
}

import type { ReaderRect, ReaderSelection } from "./renderer";
import {
  defaultLookupTriggers,
  editableTarget,
  matchesLookupShortcut,
  lookupTextAllowed,
  triggerEnabled,
  type LookupTriggerPreferences,
} from "./lookupTriggers";
import { noteAtPoint } from "./noteHighlights";

export type SelectionWatch = (() => void) & {
  cancelPending: () => void;
  setSettings: (settings: LookupTriggerPreferences) => void;
};

/**
 * Report the reader's text selection in one displayed section document: its text and where
 * it shows once a pointer or keyboard selection ends with readable text, and null once it is
 * cleared. Shift pointer scans use the same report without changing the selection.
 * Returns a cleanup that removes the listeners.
 */
export function watchTextSelection(
  document: Document,
  readingArea: () => HTMLElement | undefined,
  report: (selection: ReaderSelection | null) => void,
  onPointerScan?: (ranges: Range[]) => number,
  settings: LookupTriggerPreferences = defaultLookupTriggers,
): SelectionWatch {
  let selectionOwned = false;
  const stopScanning = watchPointerScan(
    document,
    readingArea,
    (selection) => {
      selectionOwned = false;
      const range = currentRange();
      reported = range ? rangeBounds(range) : null;
      report(selection);
    },
    onPointerScan,
    settings,
  );
  let reported: RangeBounds | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const currentRange = () => {
    const selection = document.getSelection();
    return selection && selection.rangeCount > 0 && !selection.isCollapsed
      ? selection.getRangeAt(0)
      : null;
  };
  const clear = () => {
    if (!reported) return;
    reported = null;
    if (selectionOwned) report(null);
    selectionOwned = false;
  };
  // A pointer reports its selection again even when it is the same one, such as a word
  // selected again after its popup closed; a key reports only a changed selection, so the
  // release of a page-turn key or Escape does not bring the popup back.
  const read = (origin: "pointer" | "keyboard" | "shortcut") => {
    const range = currentRange();
    const text = range ? selectedText(range) : "";
    if (!range || !text.trim()) {
      clear();
      return;
    }
    const bounds = rangeBounds(range);
    if (origin === "keyboard" && reported && sameBounds(reported, bounds)) return false;
    reported = bounds;
    if (!triggerEnabled(settings, origin) || !lookupTextAllowed(settings, text)) return false;
    selectionOwned = true;
    report({
      origin,
      text,
      sentence: sentenceAt(range),
      rect: selectionRect(range, document.defaultView?.frameElement, readingArea()),
      writingMode: writingModeAt(range.startContainer),
    });
    return true;
  };
  // Rebinding after a settings change must not turn an unchanged selection into a new
  // keyboard-release lookup. It never changes the browser's actual range.
  const initial = currentRange();
  if (initial) reported = rangeBounds(initial);
  // The browser finishes a pointer's selection, or collapses one clicked inside, only after
  // the pointer's release has been dispatched.
  const onPointerUp = (event: PointerEvent) => {
    clearTimeout(timer);
    if (event.button > 0 || editableTarget(event.target)) return;
    if (
      settings.readerPopupClickLookup &&
      settings.readerPopupMouseTrigger === "double" &&
      event.detail >= 2
    )
      return;
    timer = setTimeout(() => read("pointer"), 0);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      !triggerEnabled(settings, "shortcut") ||
      !matchesLookupShortcut(event, settings.readerPopupShortcutPreset)
    )
      return;
    if (read("shortcut")) {
      event.preventDefault();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (!editableTarget(event.target)) read("keyboard");
  };
  // Chromium PointerEvent.detail is zero even for the second release. The following
  // dblclick arrives before our deferred selection read, so cancel that read here.
  const onDoubleClick = (event: MouseEvent) => {
    if (
      triggerEnabled(settings, "click") &&
      settings.readerPopupMouseTrigger === "double" &&
      !editableTarget(event.target)
    )
      clearTimeout(timer);
  };
  const onSelectionChange = () => {
    if (!currentRange()) clear();
  };
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("keyup", onKeyUp);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("dblclick", onDoubleClick);
  const keyboardDocuments = new Set([document, document.defaultView?.frameElement?.ownerDocument]);
  for (const target of keyboardDocuments) target?.addEventListener("keydown", onKeyDown);
  const cancelPending = () => {
    clearTimeout(timer);
    stopScanning.cancelPending();
  };
  return Object.assign(
    () => {
      stopScanning();
      clearTimeout(timer);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("dblclick", onDoubleClick);
      for (const target of keyboardDocuments) target?.removeEventListener("keydown", onKeyDown);
    },
    {
      cancelPending,
      setSettings: (next: LookupTriggerPreferences) => {
        settings = next;
        clearTimeout(timer);
        stopScanning.setSettings(next);
      },
    },
  );
}

/** Modifier scans use detached ranges only; they never change the browser selection. */
function watchPointerScan(
  document: Document,
  readingArea: () => HTMLElement | undefined,
  report: (selection: ReaderSelection | null) => void,
  onPointerScan?: (ranges: Range[]) => number,
  settings: LookupTriggerPreferences = defaultLookupTriggers,
): SelectionWatch {
  let pointer: { x: number; y: number } | null = null;
  let scanned: RangeBounds | null = null;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let clickTimer: ReturnType<typeof setTimeout> | undefined;
  let hovering: RangeBounds | null = null;
  let pressing = false;
  let press: { x: number; y: number; moved: boolean } | null = null;
  const cancelHover = () => {
    clearTimeout(hoverTimer);
    hovering = null;
  };
  const cancelPending = () => {
    cancelHover();
    clearTimeout(clickTimer);
    scanned = null;
    pointer = null;
    press = null;
    pressing = false;
  };
  const scan = (origin: "shift" | "click" | "hover", deduplicate = true) => {
    if (!pointer || !triggerEnabled(settings, origin)) return false;
    const range = characterAtPoint(document, pointer.x, pointer.y);
    if (!range) {
      scanned = null;
      return false;
    }
    const bounds = rangeBounds(range);
    if (deduplicate && scanned && sameBounds(scanned, bounds)) return false;
    const { text, ranges } = textFromCharacter(range, settings.readerPopupScanLength);
    if (!text.trim() || !lookupTextAllowed(settings, text)) return false;
    scanned = bounds;
    report({
      origin,
      ...(onPointerScan ? { scanId: onPointerScan(ranges) } : {}),
      text,
      sentence: sentenceAt(range),
      rect: selectionRect(range, document.defaultView?.frameElement, readingArea()),
      writingMode: writingModeAt(range.startContainer),
    });
    return true;
  };
  const move = (event: PointerEvent) => {
    pointer = { x: event.clientX, y: event.clientY };
    if (press && Math.hypot(pointer.x - press.x, pointer.y - press.y) > 4) press.moved = true;
    if (pressing || event.buttons || editableTarget(event.target)) {
      cancelHover();
      return;
    }
    if (event.shiftKey && triggerEnabled(settings, "shift")) {
      cancelHover();
      scan("shift");
      return;
    }
    scanned = null;
    if (!triggerEnabled(settings, "hover")) return;
    const range = characterAtPoint(document, pointer.x, pointer.y);
    if (!range) {
      cancelHover();
      return;
    }
    const bounds = rangeBounds(range);
    if (hovering && sameBounds(hovering, bounds)) return;
    cancelHover();
    hovering = bounds;
    hoverTimer = setTimeout(() => scan("hover"), settings.readerPopupHoverDelay);
  };
  const leave = () => {
    pointer = null;
    scanned = null;
    cancelHover();
  };
  const onLeave = (event: PointerEvent) => {
    if (event.target === document || event.target === document.documentElement) leave();
  };
  const down = (event: KeyboardEvent) => {
    cancelHover();
    if (event.key === "Shift" && !event.repeat && !editableTarget(event.target)) scan("shift");
  };
  const up = (event: KeyboardEvent) => {
    if (event.key === "Shift") scanned = null;
  };
  const pointerDown = (event: PointerEvent) => {
    cancelHover();
    pressing = true;
    press = { x: event.clientX, y: event.clientY, moved: false };
  };
  const pointerUp = (event: PointerEvent) => {
    pressing = false;
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      press?.moved ||
      editableTarget(event.target)
    ) {
      press = null;
      return;
    }
    const moved = press?.moved;
    press = null;
    if (moved || !triggerEnabled(settings, "click") || settings.readerPopupMouseTrigger !== "left")
      return;
    if (event.shiftKey && triggerEnabled(settings, "shift")) return;
    // A click on a saved passage opens its menu instead.
    if (noteAtPoint(document, event.clientX, event.clientY)) return;
    pointer = { x: event.clientX, y: event.clientY };
    clearTimeout(clickTimer);
    // Selection release wins over a direct left click, regardless of whether its
    // preference is enabled. Dragging/selecting stays useful with click lookup on.
    clickTimer = setTimeout(() => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) scan("click", false);
    }, 0);
  };
  const doubleClick = (event: MouseEvent) => {
    cancelHover();
    if (
      event.button !== 0 ||
      !triggerEnabled(settings, "click") ||
      settings.readerPopupMouseTrigger !== "double" ||
      editableTarget(event.target)
    )
      return;
    if (event.shiftKey && triggerEnabled(settings, "shift")) return;
    pointer = { x: event.clientX, y: event.clientY };
    scan("click", false);
  };
  // A middle press on text scans it before the Reader's autoscroll or popup closing see it;
  // on blank space it still autoscrolls.
  let middleScanned = false;
  const middleDown = (event: PointerEvent) => {
    middleScanned = false;
    if (
      event.button !== 1 ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !triggerEnabled(settings, "click") ||
      settings.readerPopupMouseTrigger !== "middle" ||
      editableTarget(event.target)
    )
      return;
    cancelHover();
    pointer = { x: event.clientX, y: event.clientY };
    if (!scan("click", false)) return;
    middleScanned = true;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const middleClick = (event: MouseEvent) => {
    if (event.button !== 1 || !middleScanned) return;
    middleScanned = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const contextMenu = (event: MouseEvent) => {
    cancelHover();
    if (
      event.button !== 2 ||
      !event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      settings.readerPopupMouseTrigger !== "shift-right" ||
      editableTarget(event.target)
    )
      return;
    pointer = { x: event.clientX, y: event.clientY };
    if (scan("click", false)) event.preventDefault();
  };
  // The focused document can be the app while the pointer rests inside the book.
  const keyboardDocuments = new Set([document, document.defaultView?.frameElement?.ownerDocument]);
  for (const target of keyboardDocuments) {
    target?.addEventListener("keydown", down);
    target?.addEventListener("keyup", up);
  }
  const view = document.defaultView;
  // The window's capture phase runs before every listener on the document.
  view?.addEventListener("pointerdown", middleDown, true);
  view?.addEventListener("auxclick", middleClick, true);
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerdown", pointerDown);
  document.addEventListener("pointerup", pointerUp);
  document.addEventListener("dblclick", doubleClick);
  document.addEventListener("contextmenu", contextMenu);
  document.addEventListener("scroll", cancelPending, true);
  document.addEventListener("pointercancel", cancelPending);
  // pointerleave does not bubble; observe the section root leaving, not its inline children.
  document.addEventListener("pointerleave", onLeave, true);
  document.defaultView?.addEventListener("blur", cancelPending);
  return Object.assign(
    () => {
      cancelPending();
      for (const target of keyboardDocuments) {
        target?.removeEventListener("keydown", down);
        target?.removeEventListener("keyup", up);
      }
      view?.removeEventListener("pointerdown", middleDown, true);
      view?.removeEventListener("auxclick", middleClick, true);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("pointerup", pointerUp);
      document.removeEventListener("dblclick", doubleClick);
      document.removeEventListener("contextmenu", contextMenu);
      document.removeEventListener("scroll", cancelPending, true);
      document.removeEventListener("pointercancel", cancelPending);
      document.removeEventListener("pointerleave", onLeave, true);
      document.defaultView?.removeEventListener("blur", cancelPending);
    },
    {
      cancelPending,
      setSettings: (next: LookupTriggerPreferences) => {
        cancelPending();
        settings = next;
      },
    },
  );
}

/** A caret is the nearest insertion point; either adjacent character may contain the point. */
export function characterAtPoint(document: Document, x: number, y: number): Range | null {
  const pointDocument = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const caret = pointDocument.caretPositionFromPoint?.(x, y);
  const fallback = caret ? null : pointDocument.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode ?? fallback?.startContainer;
  const offset = caret?.offset ?? fallback?.startOffset ?? 0;
  if (!node || node.nodeType !== TEXT_NODE || inRubyAnnotation(node)) return null;
  const data = (node as Text).data;
  // Normalize an insertion point inside a surrogate pair to the code point's start.
  const start = offset > 0 && isLowSurrogate(data.charCodeAt(offset)) ? offset - 1 : offset;
  const previous = start - (start > 1 && isLowSurrogate(data.charCodeAt(start - 1)) ? 2 : 1);
  for (const index of [start, previous]) {
    if (index < 0 || index >= data.length) continue;
    const character = String.fromCodePoint(data.codePointAt(index)!);
    if (!character.trim()) continue;
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + character.length);
    if (
      Array.from(range.getClientRects()).some(
        (box) =>
          box.width > 0 &&
          box.height > 0 &&
          x >= box.left &&
          x < box.right &&
          y >= box.top &&
          y < box.bottom,
      )
    )
      return range;
  }
  return null;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Surrounding sentence in its readable block. Uses detached ranges, never selection. */
export function sentenceAt(range: Range): string {
  const document = range.startContainer.ownerDocument!;
  let block =
    range.startContainer.nodeType === 1
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  while (
    block?.parentElement &&
    !/^(block|flow-root|flex|grid|list-item|table)/.test(
      document.defaultView?.getComputedStyle(block).display ?? "",
    )
  )
    block = block.parentElement;
  if (!block) return "";
  const walker = document.createTreeWalker(block, SHOW_TEXT, {
    acceptNode: (node) =>
      inRubyAnnotation(node) || node.parentElement?.closest("script,style,[hidden]") ? 2 : 1,
  });
  let left = "";
  let right = "";
  let found = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = (node as Text).data;
    if (!found) {
      found =
        node === range.startContainer ||
        (range.startContainer.nodeType === 1 && range.intersectsNode(node));
      if (!found) {
        left = Array.from(left + data.slice(-1024))
          .slice(-512)
          .join("");
        continue;
      }
      const offset = node === range.startContainer ? range.startOffset : 0;
      left = Array.from(left + data.slice(Math.max(0, offset - 1024), offset))
        .slice(-512)
        .join("");
      left = left.slice(
        Math.max(
          left.lastIndexOf("。"),
          left.lastIndexOf("！"),
          left.lastIndexOf("？"),
          left.lastIndexOf("\n"),
        ) + 1,
      );
      right = data.slice(offset, offset + 2048);
    } else right += data.slice(0, 2048);
    const punctuation = right.search(/[。！？\n]/u);
    if (punctuation >= 0) {
      right = right.slice(0, punctuation + 1);
      break;
    }
    if (Array.from(left + right).length >= 1024) break;
  }
  // At most 512 preceding characters and 1024 overall; no unbounded block text copy.
  return (
    left +
    Array.from(right)
      .slice(0, 1024 - Array.from(left).length)
      .join("")
  ).trim();
}

/**
 * Read inline text after the character, stopping at the block, a line break, or the scan length
 * (at most 256 code points).
 */
export function textFromCharacter(range: Range, length = 256): { text: string; ranges: Range[] } {
  const document = range.startContainer.ownerDocument!;
  const view = document.defaultView;
  const isBlock = (element: Element) => {
    const display = view?.getComputedStyle(element).display ?? "";
    return /^(block|flow-root|flex|grid|list-item|table)/.test(display);
  };
  let block = range.startContainer.parentElement!;
  while (block.parentElement && !isBlock(block)) block = block.parentElement;
  const walker = document.createTreeWalker(block, 1 | SHOW_TEXT);
  walker.currentNode = range.startContainer;
  let text = "";
  const ranges: Range[] = [];
  let remaining = Math.max(1, Math.min(256, length));
  for (
    let node: Node | null = range.startContainer;
    node && remaining > 0;
    node = walker.nextNode()
  ) {
    if (node.nodeType === 1) {
      const element = node as Element;
      if (element.tagName.toLowerCase() === "br" || isBlock(element)) break;
      continue;
    }
    if (inRubyAnnotation(node) || node.parentElement?.closest("script, style, [hidden]")) continue;
    const start = node === range.startContainer ? range.startOffset : 0;
    const content = (node as Text).data.slice(start);
    let end = start;
    for (const character of content) {
      text += character;
      end += character.length;
      if (--remaining === 0) break;
    }
    if (end > start) {
      const part = document.createRange();
      part.setStart(node, start);
      part.setEnd(node, end);
      ranges.push(part);
    }
  }
  return { text, ranges };
}

/** The text in a range without ruby annotations (`rt`, `rp`), as the document holds it. */
function selectedText(range: Range): string {
  const document = range.startContainer.ownerDocument ?? (range.startContainer as Document);
  const root = range.commonAncestorContainer;
  const part = (node: Node) => {
    if (node.nodeType !== TEXT_NODE || inRubyAnnotation(node)) return "";
    const data = (node as Text).data;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : data.length;
    return data.slice(start, end);
  };
  if (root.nodeType === TEXT_NODE) return part(root);
  const walker = document.createTreeWalker(root, SHOW_TEXT);
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (range.intersectsNode(node)) text += part(node);
  }
  return text;
}

/**
 * Where a range shows in the top window: the union of its boxes clipped to the reading area,
 * or of all of them when none is within it, such as a selection on a page turned away.
 */
function selectionRect(
  range: Range,
  frame: Element | null | undefined,
  readingArea: HTMLElement | undefined,
): ReaderRect {
  const origin = frame?.getBoundingClientRect();
  const offsetLeft = origin?.left ?? 0;
  const offsetTop = origin?.top ?? 0;
  const area = readingArea?.getBoundingClientRect();
  const boxes = Array.from(range.getClientRects?.() ?? [])
    .filter((box) => box.width > 0 || box.height > 0)
    .map((box) => ({
      left: box.left + offsetLeft,
      top: box.top + offsetTop,
      right: box.right + offsetLeft,
      bottom: box.bottom + offsetTop,
    }));
  const shown = area
    ? boxes.flatMap((box) => {
        const clipped = {
          left: Math.max(box.left, area.left),
          top: Math.max(box.top, area.top),
          right: Math.min(box.right, area.right),
          bottom: Math.min(box.bottom, area.bottom),
        };
        return clipped.left < clipped.right && clipped.top < clipped.bottom ? [clipped] : [];
      })
    : boxes;
  const union = (shown.length ? shown : boxes).reduce<ReaderRect | null>(
    (all, box) =>
      all
        ? {
            left: Math.min(all.left, box.left),
            top: Math.min(all.top, box.top),
            right: Math.max(all.right, box.right),
            bottom: Math.max(all.bottom, box.bottom),
          }
        : box,
    null,
  );
  return union ?? { left: offsetLeft, top: offsetTop, right: offsetLeft, bottom: offsetTop };
}

const TEXT_NODE = 3;
const SHOW_TEXT = 4;

interface RangeBounds {
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
}

function rangeBounds(range: Range): RangeBounds {
  const { startContainer, startOffset, endContainer, endOffset } = range;
  return { startContainer, startOffset, endContainer, endOffset };
}

function sameBounds(a: RangeBounds, b: RangeBounds): boolean {
  return (
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  );
}

function inRubyAnnotation(node: Node): boolean {
  return !!node.parentElement?.closest("rt, rp");
}

function writingModeAt(node: Node): ReaderSelection["writingMode"] {
  const element = node.nodeType === TEXT_NODE ? node.parentElement : (node as Element);
  const view = element?.ownerDocument.defaultView;
  const mode = element && view ? view.getComputedStyle(element).writingMode : "";
  if (mode === "vertical-rl" || mode === "sideways-rl" || mode === "tb-rl" || mode === "tb")
    return "vertical-rl";
  if (mode === "vertical-lr" || mode === "sideways-lr") return "vertical-lr";
  return "horizontal";
}

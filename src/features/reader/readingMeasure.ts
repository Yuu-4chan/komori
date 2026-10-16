import type { ReaderProgressUnit } from "./renderer";

/** A DOM point: a text node and character offset, or an element and child index. */
export interface TextPoint {
  node: Node;
  offset: number;
}

const letterOrNumber = /[\p{L}\p{N}]/gu;
const word = /[\p{L}\p{N}\p{M}]+(?:['’\-‐][\p{L}\p{N}\p{M}]+)*/gu;
const cjkLetter = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/gu;
const letter = /\p{L}/gu;

/**
 * The text a reader reads in a section body, optionally only up to a point: every text
 * node except ruby annotations such as furigana (`rt`) and their fallback parentheses (`rp`).
 */
export function readableText(document: Document, until?: TextPoint): string {
  const body = document.body;
  if (!body) return "";
  let boundary: Range | undefined;
  if (until) {
    if (!body.contains(until.node)) return "";
    boundary = document.createRange();
    boundary.setStart(until.node, until.offset);
  }
  let text = "";
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = (node as Text).data;
    if (boundary) {
      if (node === until?.node) {
        if (!inRubyAnnotation(node)) text += data.slice(0, until.offset);
        break;
      }
      // A text node that starts at or after the point is past it.
      if (boundary.comparePoint(node, 0) >= 0) break;
    }
    if (!inRubyAnnotation(node)) text += data;
  }
  return text;
}

/** A section's readable text, with where each text node starts in it. */
interface ReadableIndex {
  body: HTMLElement;
  text: string;
  /** The body's text nodes in document order. */
  nodes: Text[];
  starts: Map<Node, number>;
  /** Units of the whole text, once counted. */
  total: Partial<Record<ReaderProgressUnit, number>>;
  /** Units counted before points, by node, then unit and offset. */
  counted: Map<Node, Map<string, number>>;
  changed: boolean;
  changes: MutationObserver;
}

const readableIndexes = new WeakMap<Document, ReadableIndex>();

/** The units of a section's readable text, as counted from readableText. */
export function readableUnits(document: Document, unit: ReaderProgressUnit): number {
  const index = currentIndex(document);
  if (!index) return 0;
  return (index.total[unit] ??= countUnits(index.text, unit));
}

/**
 * The units of readable text before a point, as counted from readableText up to it. A
 * displayed section's text is read once and kept until it changes, so counting before
 * each page edge does not walk the whole section again.
 */
export function readableUnitsBefore(
  document: Document,
  point: TextPoint,
  unit: ReaderProgressUnit,
): number {
  const index = document.body?.contains(point.node) && currentIndex(document);
  if (!index) return 0;
  let counted = index.counted.get(point.node);
  if (!counted) index.counted.set(point.node, (counted = new Map()));
  const key = `${unit} ${point.offset}`;
  let units = counted.get(key);
  if (units === undefined) {
    units = countUnits(index.text.slice(0, readableEnd(index, document, point)), unit);
    counted.set(key, units);
  }
  return units;
}

function currentIndex(document: Document): ReadableIndex | undefined {
  const body = document.body;
  if (!body) return undefined;
  let index = readableIndexes.get(document);
  if (!index || index.body !== body || index.changed || index.changes.takeRecords().length) {
    index?.changes.disconnect();
    index = indexReadableText(document, body);
    readableIndexes.set(document, index);
  }
  return index;
}

function indexReadableText(document: Document, body: HTMLElement): ReadableIndex {
  const nodes: Text[] = [];
  const starts = new Map<Node, number>();
  let text = "";
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    starts.set(node, text.length);
    if (!inRubyAnnotation(node)) text += (node as Text).data;
  }
  const index: ReadableIndex = {
    body,
    text,
    nodes,
    starts,
    total: {},
    counted: new Map(),
    changed: false,
    changes: new MutationObserver(() => {
      index.changed = true;
    }),
  };
  index.changes.observe(body, { childList: true, characterData: true, subtree: true });
  return index;
}

/** Where readableText up to a point ends in the indexed text. */
function readableEnd(index: ReadableIndex, document: Document, point: TextPoint): number {
  const start = index.starts.get(point.node);
  if (start !== undefined) {
    const node = point.node as Text;
    return inRubyAnnotation(node) ? start : start + Math.min(point.offset, node.data.length);
  }
  // A point between nodes ends before the first text node at or after it.
  const boundary = document.createRange();
  boundary.setStart(point.node, point.offset);
  let low = 0;
  let high = index.nodes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (boundary.comparePoint(index.nodes[middle], 0) >= 0) high = middle;
    else low = middle + 1;
  }
  return low < index.nodes.length ? (index.starts.get(index.nodes[low]) ?? 0) : index.text.length;
}

function inRubyAnnotation(node: Node): boolean {
  return !!node.parentElement?.closest("rt, rp");
}

/** Letters and numbers (code points) as characters, or words; never whitespace or punctuation. */
export function countUnits(text: string, unit: ReaderProgressUnit): number {
  return text.match(unit === "characters" ? letterOrNumber : word)?.length ?? 0;
}

/** Letters in Chinese, Japanese, or Korean scripts, and all letters. */
export function scriptCounts(text: string): { cjk: number; letters: number } {
  return {
    cjk: text.match(cjkLetter)?.length ?? 0,
    letters: text.match(letter)?.length ?? 0,
  };
}

/** Characters for mostly Chinese, Japanese, or Korean text, otherwise words. */
export function progressUnit(counts: { cjk: number; letters: number }): ReaderProgressUnit {
  return counts.letters > 0 && counts.cjk * 2 >= counts.letters ? "characters" : "words";
}

import type { ReaderSearchMatch } from "./renderer";

export const SEARCH_LIMIT = 100;
export const SEARCH_QUERY_LIMIT = 256;
const SECTION_TEXT_LIMIT = 4_000_000;
const excluded = "rt, rp, script, style, template, noscript, [hidden], [aria-hidden='true']";
const blocks =
  "p, div, section, article, aside, nav, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, pre, figure";

export function searchQuery(value: string): string {
  return value.trim().replace(/\p{Cc}/gu, "");
}

/** Temporary per-section text map. Inline/ruby base text joins; blocks and br separate. */
export function searchText(document: Document) {
  const segments: Array<{ node: Text; start: number }> = [];
  let text = "";
  let previousBlock: Element | null | undefined;
  const body = document.body;
  if (body) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      if (element?.closest(excluded)) continue;
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (element?.localName === "br") text += "\n";
        continue;
      }
      const block = element?.closest(blocks) ?? body;
      if (previousBlock !== undefined && block !== previousBlock) text += "\n";
      previousBlock = block;
      segments.push({ node: node as Text, start: text.length });
      text += (node as Text).data;
      if (text.length > SECTION_TEXT_LIMIT) throw Error("Search text limit");
    }
  }
  return {
    text,
    /** Map an existing text point back to searchable text without a content search. */
    offsetAt(node: Text, offset: number): number | null {
      const segment = segments.find((segment) => segment.node === node);
      return segment ? segment.start + offset : null;
    },
    point(offset: number): Range | null {
      const segment = segments.find(
        ({ node, start }) => offset >= start && offset < start + node.length,
      );
      if (!segment) return null;
      const range = document.createRange();
      range.setStart(segment.node, offset - segment.start);
      range.collapse(true);
      return range;
    },
    /** First searchable character at or after an authored chapter anchor. */
    anchorOffset(id?: string): number {
      const anchor = id ? document.getElementById(id) : null;
      if (!anchor) return 0;
      return (
        segments.find(
          ({ node }) =>
            anchor.contains(node) ||
            !!(anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING),
        )?.start ?? text.length
      );
    },
  };
}

export function literalMatches(text: string, query: string): RegExpStringIterator<RegExpExecArray> {
  return text.matchAll(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"));
}

export function matchExcerpt(
  text: string,
  offset: number,
  length: number,
): Pick<ReaderSearchMatch, "before" | "match" | "after"> {
  const before = Array.from(text.slice(Math.max(0, offset - 100), offset));
  const match = Array.from(text.slice(offset, offset + length));
  const after = Array.from(text.slice(offset + length, offset + length + 100));
  const clean = (value: string) => value.replace(/\s+/gu, " ").replace(/\p{Cc}/gu, "");
  return {
    before: (before.length > 40 ? "…" : "") + clean(before.slice(-40).join("")),
    match: clean(match.slice(0, 76).join("")) + (match.length > 76 ? "…" : ""),
    after: clean(after.slice(0, 40).join("")) + (after.length > 40 ? "…" : ""),
  };
}

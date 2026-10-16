/** Semantic blocks retained in the original DOM, in authored order. */
export interface VnBlock {
  element: Element;
  kind: "paragraph" | "heading" | "media";
}

const structural =
  "p, div, section, article, h1, h2, h3, h4, h5, h6, li, blockquote, pre, table, figure";
const atomic = "p, h1, h2, h3, h4, h5, h6, pre, table, figure, img, svg";
const ignored = "script, style, rt, rp, head, [hidden], [aria-hidden='true']";
export const VN_BLOCK_LIMIT = 20_000;

/**
 * No synthetic text, cloning or source changes. Ruby and inline glyphs stay with their
 * paragraph; tables/figures stay intact. Bare body text and excessive block counts use
 * an honest whole-section fallback rather than losing text.
 */
export function vnBlocks(document: Document): VnBlock[] {
  if (!document.body) return [];
  const blocks: VnBlock[] = [];
  let unsupported = false;
  const visit = (element: Element) => {
    if (unsupported || element.matches(ignored)) return;
    const nested = !!element.querySelector(structural);
    if (element !== document.body && (element.matches(atomic) || !nested)) {
      const text = [...element.childNodes].some((node) => node.textContent?.trim());
      const media = element.matches("img, svg") || !!element.querySelector("img, svg");
      if (!text && !media) return;
      blocks.push({
        element,
        // A figure's caption shows with its image, never with the paragraphs around it.
        kind:
          media && (element.matches("figure") || !element.textContent?.trim())
            ? "media"
            : element.matches("h1, h2, h3, h4, h5, h6")
              ? "heading"
              : "paragraph",
      });
      if (blocks.length > VN_BLOCK_LIMIT) unsupported = true;
      return;
    }
    for (const node of element.childNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) visit(node as Element);
      else if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) unsupported = true;
    }
  };
  visit(document.body);
  return unsupported ? [] : blocks;
}

/**
 * Group starts by block ordinal, restarting at headings and authored chapter anchors. Media
 * always shows alone, so a group holds either text or an image, never both.
 */
export function vnGroupStarts(blocks: VnBlock[], count: number, anchors: Element[]): number[] {
  if (!blocks.length) return [];
  const boundaries = new Set(
    anchors.map((anchor) =>
      blocks.findIndex(({ element }) => element === anchor || element.contains(anchor)),
    ),
  );
  const starts = [0];
  let paragraphs = 0;
  blocks.forEach(({ kind }, index) => {
    const media = kind === "media" || blocks[index - 1]?.kind === "media";
    if (index > 0 && (boundaries.has(index) || kind === "heading" || media)) {
      if (starts.at(-1) !== index) starts.push(index);
      paragraphs = 0;
    }
    if (kind !== "paragraph") return;
    if (paragraphs >= count) {
      starts.push(index);
      paragraphs = 0;
    }
    paragraphs++;
  });
  return starts;
}

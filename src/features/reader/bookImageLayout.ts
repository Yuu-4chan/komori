const namespace = "http://www.w3.org/1999/xhtml";
const TEXT_IMAGE = "data-komori-text-image";
const SPACING = "data-komori-image-spacing";
const PAGE_IMAGE = "data-komori-page-image";
const STYLE = "data-komori-book-images";
const FIT_STYLE = "data-komori-page-image-fit";
const IMAGE_LINE = "data-komori-image-line";
const IMAGE_GAP = "data-komori-image-gap";
const blocks = "p, div, section, figure, h1, h2, h3, h4, h5, h6";
const lineBreaks = `${blocks}, address, article, aside, blockquote, body, center, dd, dl, dt, figcaption, footer, header, li, main, nav, pre, td, th, hr, ol, table, ul`;

/** Whether an element is hidden by its own markup: `hidden` or an inline `display: none`. */
function hiddenByMarkup(element: Element): boolean {
  return (
    element.hasAttribute("hidden") ||
    /(?:^|;)\s*display\s*:\s*none\b/i.test(element.getAttribute("style") ?? "")
  );
}

/**
 * The text a reader sees under `root`, leaving out what its markup hides, such as a
 * cover page's hidden "Cover" label.
 */
export function shownText(root: Element): string {
  let text = "";
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        node.nodeType === Node.ELEMENT_NODE && hiddenByMarkup(node as Element)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    },
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node.nodeType === Node.TEXT_NODE) text += (node as Text).data;
  return text;
}

/** An unwrapped illustration between blocks, with no running text beside it. */
function betweenBlocks(image: Element): boolean {
  return (["previousSibling", "nextSibling"] as const).every((direction) => {
    for (let node = image[direction]; node; node = node[direction]) {
      if (node.nodeType === Node.COMMENT_NODE) continue;
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent?.trim()) return false;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const element = node as Element;
      if (element.localName === "br") continue;
      return element.matches(lineBreaks);
    }
    return true;
  });
}

/** Explicit publisher character semantics, never an illustration's pixel size. */
export function isTextImage(image: Element): boolean {
  if (image.hasAttribute(TEXT_IMAGE) || image.closest("ruby")) return true;
  for (let element: Element | null = image; element; element = element.parentElement) {
    if (element !== image && element.matches(`${blocks}, body`)) break;
    if (
      [...element.classList].some((name) =>
        /^(gaiji(?:[-_].*)?|glyph|inline-character|text-image)$/i.test(name),
      )
    )
      return true;
  }
  return false;
}

/** Mark before serialization; spacing follows the text's block axis. */
export function applyBookImageLayout(document: Document): void {
  const body = document.body;
  if (!body) return;
  const images = [...body.querySelectorAll("img, svg")].filter(
    (image) => !image.parentElement?.closest("svg"),
  );
  for (const image of images) {
    if (isTextImage(image)) {
      image.setAttribute(TEXT_IMAGE, "");
      // Inline important publisher dimensions otherwise outrank the owned layer.
      const style = (image as HTMLElement).style;
      for (const [property, value] of Object.entries({
        width: "1em",
        height: "1em",
        "max-width": "1em",
        "max-height": "1em",
        margin: "0",
        padding: "0",
        display: "inline-block",
        "vertical-align": "middle",
        "object-fit": "contain",
      }))
        style.setProperty(property, value, "important");
      continue;
    }
    let block = image.closest(blocks);
    if (!block || shownText(block).trim()) {
      if (betweenBlocks(image)) {
        image.setAttribute(IMAGE_LINE, "");
        image.setAttribute(IMAGE_GAP, "");
      }
      continue;
    }
    // One gap on the outermost image-only wrapper, rather than at every nesting level.
    const count = block.querySelectorAll("img, svg").length;
    while (
      block.parentElement?.matches(blocks) &&
      !shownText(block.parentElement).trim() &&
      block.parentElement.querySelectorAll("img, svg").length === count
    )
      block = block.parentElement;
    block.setAttribute(SPACING, "");
    image.setAttribute(IMAGE_LINE, "");
  }
  for (const block of body.querySelectorAll(`[${SPACING}]`)) {
    const lines = [...block.querySelectorAll(`[${IMAGE_LINE}]`)];
    lines.forEach((line, index) => line.toggleAttribute(IMAGE_GAP, index < lines.length - 1));
  }
  if (images.length === 1 && !shownText(body).trim() && !isTextImage(images[0]))
    images[0].setAttribute(PAGE_IMAGE, "");
  if (!images.length || document.querySelector(`style[${STYLE}]`)) return;
  const style = document.createElementNS(namespace, "style");
  style.setAttribute(STYLE, "");
  style.textContent = `@layer komori-book-images {
:root body [${SPACING}] { margin-block: 0 !important; padding-block: 0 1.5em !important; line-height: 0 !important; }
:root body [${SPACING}] :is(${blocks}) { margin-block: 0 !important; padding-block: 0 !important; line-height: 0 !important; }
:root body [${IMAGE_LINE}] { display: block !important; margin-block: 0 !important; margin-inline: auto !important; vertical-align: middle !important; }
:root body [${IMAGE_GAP}] { margin-block-end: 1.5em !important; }
}`;
  (document.head ?? document.documentElement).prepend(style);
}

/**
 * Fit image-only pages, including SVG covers, without a squeezed SVG box. A paginated or
 * vertical page's width is the whole page, its side padding included; a continuous
 * horizontal one's is the width inside the padding.
 */
export function fitBookImagePage(
  document: Document,
  width?: number,
  height?: number,
  paginated = false,
): void {
  let style = document.querySelector(`style[${FIT_STYLE}]`);
  if (!width || !height || !document.querySelector(`[${PAGE_IMAGE}]`)) {
    style?.remove();
    return;
  }
  const bodyStyle = document.defaultView?.getComputedStyle(document.body);
  const vertical = document.documentElement.style.writingMode.startsWith("vertical");
  const pageHeight = height;
  const horizontalPadding =
    (parseFloat(bodyStyle?.paddingLeft ?? "") || 0) +
    (parseFloat(bodyStyle?.paddingRight ?? "") || 0);
  const wholePage = vertical || paginated;
  const pageWidth = wholePage ? width : width + horizontalPadding;
  if (wholePage) width = Math.max(1, width - horizontalPadding);
  // EPUB.js adds physical top/bottom padding inside the reading area. Leave room for
  // that and the common image gap so a fitted cover cannot spill onto a second page.
  const fontSize = parseFloat(document.documentElement.style.fontSize) || 16;
  height -=
    (parseFloat(bodyStyle?.paddingTop ?? "") || 0) +
    (parseFloat(bodyStyle?.paddingBottom ?? "") || 0) +
    (paginated ? 0 : 1.5 * fontSize);
  height = Math.max(1, height);
  let rule = `:root body [${PAGE_IMAGE}] { width: auto !important; height: auto !important; max-width: ${width}px !important; max-height: ${height}px !important; object-fit: contain !important; }`;
  const svg = document.querySelector(`svg[${PAGE_IMAGE}]`);
  const box = svg
    ?.getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    const ratio = box[2] / box[3];
    const fittedWidth = Math.min(width, height * ratio);
    rule += ` :root body svg[${PAGE_IMAGE}] { width: ${fittedWidth}px !important; height: ${fittedWidth / ratio}px !important; }`;
  }
  if (paginated) {
    // A text-free section occupies one page (one column in a horizontal spread).
    // Flex centers its original wrappers, and the image inside one a publisher sizes to the
    // whole page, without inserting nodes or changing CFIs.
    rule += ` @layer komori-book-images {
:root body { display: flex !important; align-items: center !important; justify-content: center !important; width: ${pageWidth}px !important; height: ${pageHeight}px !important; }
:root body :is(${blocks}) { margin: 0 !important; padding: 0 !important; line-height: 0 !important; }
:root body :is(${blocks}):has([${PAGE_IMAGE}]) { display: flex !important; align-items: center !important; justify-content: center !important; max-width: 100% !important; max-height: 100% !important; }
:root body [${SPACING}] { padding-block: 0 !important; }
:root body [${PAGE_IMAGE}] { margin: 0 !important; }
}`;
  }
  if (!style) {
    style = document.createElementNS(namespace, "style");
    style.setAttribute(FIT_STYLE, "");
    (document.head ?? document.documentElement).append(style);
  }
  if (style.textContent !== rule) style.textContent = rule;
}

/** SVG content documents in the spine, shown as XHTML pages that hold their drawing. */
const XHTML = "http://www.w3.org/1999/xhtml";
const SVG = "http://www.w3.org/2000/svg";
const SVG_PAGE = "data-komori-svg-page";
const FILL_STYLE = "data-komori-svg-page-fill";
/** Elements SVG never draws, whose text is not page text. */
const UNDRAWN = ["title", "desc", "metadata", "script"];

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** The pseudo-attributes of an `xml-stylesheet` processing instruction. */
function pseudoAttributes(data: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [, name, , value] of data.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs))
    attributes.set(
      name,
      value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => entities[entity]),
    );
  return attributes;
}

/** The size an SVG document declares for its drawing: its viewBox, else its pixel size. */
function declaredSize(svg: Element): { width: number; height: number } | undefined {
  const box = svg
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0)
    return { width: box[2], height: box[3] };
  const pixels = (name: string) =>
    Number(/^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/.exec(svg.getAttribute(name) ?? "")?.[1] ?? NaN);
  const width = pixels("width");
  const height = pixels("height");
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * The XHTML page that shows an SVG content document: its drawing alone in the body, and
 * in the head its first title, a viewport of its declared size, which a fixed-layout page
 * takes as its own, then the stylesheets its `xml-stylesheet` instructions name and its
 * own style elements, in the order they apply. Undrawn titles, descriptions, metadata and scripts
 * are left out, so they are neither shown, nor counted, nor found as page text. The page
 * keeps the document's address, so its references resolve as they did.
 */
export function svgPageDocument(svg: Document): Document {
  const page = new DOMParser().parseFromString(
    `<html xmlns="${XHTML}" ${SVG_PAGE}=""><head><title></title></head><body></body></html>`,
    "application/xhtml+xml",
  );
  const head = page.head!;
  const drawing = page.importNode(svg.documentElement, true);
  const title = [...drawing.children].find(
    (child) => child.namespaceURI === SVG && child.localName === "title",
  );
  head.querySelector("title")!.textContent = title?.textContent?.trim() ?? "";
  const size = declaredSize(drawing);
  if (size) {
    const viewport = page.createElementNS(XHTML, "meta");
    viewport.setAttribute("name", "viewport");
    viewport.setAttribute("content", `width=${size.width}, height=${size.height}`);
    head.append(viewport);
  }
  for (const node of svg.childNodes) {
    if (node.nodeType !== Node.PROCESSING_INSTRUCTION_NODE) continue;
    const instruction = node as ProcessingInstruction;
    if (instruction.target !== "xml-stylesheet") continue;
    const attributes = pseudoAttributes(instruction.data);
    const href = attributes.get("href");
    const type = attributes.get("type")?.trim().toLowerCase();
    if (!href || attributes.get("alternate") === "yes" || (type && type !== "text/css")) continue;
    const link = page.createElementNS(XHTML, "link");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("type", "text/css");
    link.setAttribute("href", href);
    const media = attributes.get("media");
    if (media) link.setAttribute("media", media);
    head.append(link);
  }
  // Element collections are live, so each is copied before its elements are removed.
  for (const authored of Array.from(drawing.getElementsByTagNameNS(SVG, "style"))) {
    const type = authored.getAttribute("type")?.trim().toLowerCase();
    if (!type || type === "text/css") {
      const style = page.createElementNS(XHTML, "style");
      style.textContent = authored.textContent;
      const media = authored.getAttribute("media");
      if (media) style.setAttribute("media", media);
      head.append(style);
    }
    authored.remove();
  }
  for (const name of UNDRAWN)
    for (const element of Array.from(drawing.getElementsByTagNameNS(SVG, name))) element.remove();
  page.body!.append(drawing);
  return page;
}

/** Whether a section document is the page of an SVG content document. */
export function isSvgPage(document: Document): boolean {
  return !!document.documentElement?.hasAttribute(SVG_PAGE);
}

/**
 * A fixed-layout SVG page fills the viewport its declared size gives it, as the SVG
 * document fills its own window. The book's own styles still apply over this.
 */
export function fillFixedSvgPage(document: Document): void {
  if (!isSvgPage(document) || document.querySelector(`style[${FILL_STYLE}]`)) return;
  const style = document.createElementNS(XHTML, "style");
  style.setAttribute(FILL_STYLE, "");
  style.textContent = `@layer komori-svg-page {
:root body { margin: 0; padding: 0; width: 100%; height: 100%; }
:root body > svg { display: block; width: 100%; height: 100%; }
}`;
  (document.head ?? document.documentElement).prepend(style);
}

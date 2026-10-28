/** Bounds apply before archive decompression, before drawing and to the output. */
export const IMAGE_LIMIT = 500;
export const IMAGE_BYTES = 16 * 1024 * 1024;
export const IMAGE_DOCUMENT_BYTES = 2 * 1024 * 1024;
const SVG_NS = "http://www.w3.org/2000/svg";

export function imageElements(document: Document): Element[] {
  return Array.from(document.querySelectorAll("img, svg")).filter(
    (element) => !element.parentElement?.closest("svg"),
  );
}

export function imageAlt(element: Element): string {
  return [
    ...(element.getAttribute("alt") ?? element.querySelector("title")?.textContent ?? "")
      .replace(/\p{Cc}/gu, " ")
      .trim(),
  ]
    .slice(0, 160)
    .join("");
}

/** Never accept external, data, blob, protocol-relative or traversal destinations. */
export function imageArchivePath(href: string, base: string): string | undefined {
  if (!href || /^[a-z][\w+.-]*:|^\/\//i.test(href) || href.includes("\\")) return undefined;
  try {
    const decoded = decodeURIComponent(href.split(/[?#]/)[0]);
    if (
      decoded.includes("\\") ||
      /^[a-z][\w+.-]*:|^\/\//i.test(decoded) ||
      // eslint-disable-next-line no-control-regex -- Control characters are refused on purpose.
      /[\u0000-\u001f\u007f]/.test(decoded)
    )
      return undefined;
    const parts = decoded.startsWith("/") ? [""] : base.split("/").slice(0, -1);
    for (const part of decoded.split("/")) {
      if (part === "..") {
        if (parts.length <= 1) return undefined;
        parts.pop();
      } else if (part && part !== ".") parts.push(part);
    }
    return new URL(parts.join("/"), "https://komori-book.invalid/").pathname;
  } catch {
    return undefined;
  }
}

export function rasterType(bytes: Uint8Array): string | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes[0] === 137 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 2) === "BM") return "image/bmp";
  if (ascii(4, 8) === "ftyp" && /avif|avis/.test(ascii(8, 32))) return "image/avif";
  return undefined;
}

/** A raster file no larger than this is read while listing, to tell a spacer by its size. */
export const SPACER_BYTES = 4096;

/** A raster's pixel size from its header, for the formats `rasterType` knows but AVIF. */
export function rasterDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : undefined;
  try {
    switch (rasterType(bytes)) {
      case "image/png":
        return size(view.getUint32(16), view.getUint32(20));
      case "image/gif":
        return size(view.getUint16(6, true), view.getUint16(8, true));
      case "image/bmp":
        return size(Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true)));
      case "image/webp": {
        const chunk = String.fromCharCode(...bytes.slice(12, 16));
        if (chunk === "VP8X")
          return size(
            (view.getUint32(24, true) & 0xffffff) + 1,
            (view.getUint32(27, true) & 0xffffff) + 1,
          );
        if (chunk === "VP8L") {
          const bits = view.getUint32(21, true);
          return size((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
        }
        if (chunk === "VP8 ")
          return size(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
        return undefined;
      }
      case "image/jpeg":
        // The first start-of-frame marker holds the size; other segments are skipped.
        for (let offset = 2; offset + 9 < bytes.length;) {
          if (bytes[offset] !== 0xff) return undefined;
          const marker = bytes[offset + 1];
          if (marker === 0xff) {
            offset += 1;
            continue;
          }
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
            return size(view.getUint16(offset + 7), view.getUint16(offset + 5));
          offset += 2 + view.getUint16(offset + 2);
        }
        return undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** A picture of a few pixels, as books hold space or draw a line with, is no illustration. */
export function isSpacerRaster(bytes: Uint8Array): boolean {
  const size = rasterDimensions(bytes);
  return !!size && Math.min(size.width, size.height) <= 4;
}

/** Rebuild a drawing from an inert SVG subset. No authored CSS or active content survives. */
export async function inertSvg(
  source: Element,
  readRaster: (href: string) => Promise<string>,
): Promise<Blob> {
  const tags = new Set([
    "svg",
    "g",
    "defs",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "title",
    "desc",
    "image",
    "use",
    "symbol",
    "clipPath",
    "mask",
    "linearGradient",
    "radialGradient",
    "stop",
  ]);
  const attributes = new Set([
    "id",
    "viewBox",
    "width",
    "height",
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "d",
    "points",
    "transform",
    "preserveAspectRatio",
    "fill",
    "fill-rule",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-linecap",
    "stroke-linejoin",
    "opacity",
    "clip-path",
    "mask",
    "offset",
    "stop-color",
    "stop-opacity",
    "gradientUnits",
    "gradientTransform",
    "font-size",
    "font-family",
    "font-weight",
    "text-anchor",
    "dx",
    "dy",
  ]);
  const document = window.document.implementation.createDocument(SVG_NS, "svg");
  let nodes = 0;
  let resources = 0;
  const copy = async (element: Element, depth: number): Promise<Element | null> => {
    if (++nodes > 10000 || depth > 64) throw Error("Drawing limit");
    if (!tags.has(element.localName)) return null;
    const result = document.createElementNS(SVG_NS, element.localName);
    for (const attr of Array.from(element.attributes)) {
      if (!attributes.has(attr.name) || attr.value.length > 100000) continue;
      if (/url\s*\(/i.test(attr.value) && !/^url\(#[\w.-]+\)$/.test(attr.value)) continue;
      result.setAttribute(attr.name, attr.value);
    }
    const href = element.getAttribute("href") ?? element.getAttribute("xlink:href");
    if (element.localName === "image") {
      if (!href || ++resources > 8) throw Error("Drawing resource unavailable");
      result.setAttribute("href", await readRaster(href));
    } else if (element.localName === "use") {
      if (!href || !/^#[\w.-]+$/.test(href)) return null;
      result.setAttribute("href", href);
    }
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE)
        result.append(document.createTextNode(child.textContent ?? ""));
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const safe = await copy(child as Element, depth + 1);
        if (safe) result.append(safe);
      }
    }
    return result;
  };
  const root = await copy(source, 0);
  if (!root || root.localName !== "svg") throw Error("Drawing unavailable");
  root.setAttribute("xmlns", SVG_NS);
  // Out of its page, a drawing sized in percentages (as Calibre's cover pages are) has no
  // size of its own and draws at the browser's 300 × 150, stretched by
  // preserveAspectRatio="none": size it by its viewBox.
  const box = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const relative = (name: string) => !/^\s*[\d.]+[a-z]*\s*$/i.test(root.getAttribute(name) ?? "");
  if (box.length === 4 && box[2] > 0 && box[3] > 0 && (relative("width") || relative("height"))) {
    root.setAttribute("width", String(box[2]));
    root.setAttribute("height", String(box[3]));
  }
  return new Blob([new XMLSerializer().serializeToString(root)], { type: "image/svg+xml" });
}

export function imageSize(
  width: number,
  height: number,
  size: "thumbnail" | "viewer",
  vector = false,
) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > 40_000_000 ||
    Math.max(width, height) > 20000
  )
    throw Error("Image dimensions unavailable");
  const scale =
    size === "thumbnail" ? Math.min(vector ? Infinity : 1, 1024 / width, 768 / height) : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Inputs are sniffed rasters or adapter-rebuilt inert SVGs, never authored SVGs.
 * Keep their detail in the viewer; only thumbnails need rasterization/resizing.
 * Every input is decoded and dimension-checked before crossing the UI boundary. */
export async function renderBookImage(
  blob: Blob,
  size: "thumbnail" | "viewer",
  signal: AbortSignal,
) {
  if (signal.aborted) throw Error("Image cancelled");
  const image = new Image();
  const url = URL.createObjectURL(blob);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    image.src = url;
    await Promise.race([
      image.decode(),
      new Promise<never>((_, reject) => {
        abort = () => {
          image.src = "";
          reject(Error("Image cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(Error("Image decode unavailable")), 10000);
      }),
    ]);
    if (signal.aborted) throw Error("Image cancelled");
    const dimensions = imageSize(
      image.naturalWidth,
      image.naturalHeight,
      size,
      blob.type === "image/svg+xml",
    );
    if (size === "viewer") return { blob, ...dimensions };
    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d");
    if (!context) throw Error("Image unavailable");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const output = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!output || signal.aborted) throw Error("Image unavailable");
    return { blob: output, ...dimensions };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    image.src = "";
    URL.revokeObjectURL(url);
  }
}

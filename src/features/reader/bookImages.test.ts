import { Blob as NativeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  imageArchivePath,
  imageElements,
  imageAlt,
  imageSize,
  inertSvg,
  isSpacerRaster,
  rasterDimensions,
  rasterType,
  renderBookImage,
} from "./bookImages";

describe("book image safety and bounds", () => {
  beforeEach(() => vi.stubGlobal("Blob", NativeBlob));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("resolves only archive resources and refuses escaped/external destinations", () => {
    expect(imageArchivePath("../Images/a%20b.png", "/Text/chapter.xhtml")).toBe(
      "/Images/a%20b.png",
    );
    expect(imageArchivePath("/Images/book.png", "/Text/chapter.xhtml")).toBe("/Images/book.png");
    for (const href of [
      "https://evil/image",
      "//evil/image",
      "data:image/png,a",
      "blob:other",
      "file:/private",
      "../../escape",
      "%2e%2e/%2e%2e/escape",
      "..\\escape",
      "..%5C..%5Cescape",
      "%2f%2fevil/image",
      "https%3a%2f%2fevil/image",
      "image%00.png",
      "%ZZ",
    ])
      expect(imageArchivePath(href, "/Text/chapter.xhtml")).toBeUndefined();
  });
  it("finds image occurrences without duplicating nested SVG and bounds plain alt text", () => {
    const document = window.document.implementation.createHTMLDocument();
    document.body.innerHTML =
      '<img alt="Real cover"><svg><title>Illustration</title><svg><image href="book.png"/></svg></svg><img alt="last">';
    expect(imageElements(document).map(imageAlt)).toEqual(["Real cover", "Illustration", "last"]);
    document.querySelector("img")!.setAttribute("alt", "𠮷".repeat(170) + "\n");
    expect([...imageAlt(document.querySelector("img")!)]).toHaveLength(160);
  });
  it("sniffs raster bytes and bounds decoded/output dimensions", () => {
    expect(rasterType(new Uint8Array([137, 80, 78, 71]))).toBe("image/png");
    expect(rasterType(new TextEncoder().encode("<svg/>"))).toBeUndefined();
    expect(imageSize(6000, 4000, "thumbnail")).toEqual({ width: 1024, height: 683 });
    expect(imageSize(6000, 4000, "viewer")).toEqual({ width: 6000, height: 4000 });
    expect(imageSize(100, 150, "thumbnail", true)).toEqual({ width: 512, height: 768 });
    expect(imageSize(100, 150, "thumbnail")).toEqual({ width: 100, height: 150 });
    expect(imageSize(1500, 6000, "viewer")).toEqual({ width: 1500, height: 6000 });
    for (const [w, h] of [
      [0, 20],
      [10000, 10000],
      [20001, 1],
      [-10, -10],
      [Infinity, 20],
      [NaN, 20],
      [1.5, 20],
    ])
      expect(() => imageSize(w, h, "viewer")).toThrow();
  });
  it("reads raster sizes from their headers and tells spacers from pictures", () => {
    const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());
    const be32 = (value: number) => [
      value >>> 24,
      (value >> 16) & 255,
      (value >> 8) & 255,
      value & 255,
    ];
    const le16 = (value: number) => [value & 255, value >> 8];
    const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));
    const png = (width: number, height: number) =>
      bytes(
        [137, ...ascii("PNG"), 13, 10, 26, 10, 0, 0, 0, 13],
        ascii("IHDR"),
        be32(width),
        be32(height),
      );
    const gif = (width: number, height: number) =>
      bytes(ascii("GIF89a"), le16(width), le16(height));
    // A JPEG with an APP0 segment before its baseline start-of-frame.
    const jpeg = (width: number, height: number) =>
      bytes(
        [255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 11, 8],
        [height >> 8, height & 255],
        [width >> 8, width & 255],
        [1, 1, 17, 0],
      );
    expect(rasterDimensions(png(961, 1356))).toEqual({ width: 961, height: 1356 });
    expect(rasterDimensions(gif(16, 24))).toEqual({ width: 16, height: 24 });
    expect(rasterDimensions(jpeg(831, 1173))).toEqual({ width: 831, height: 1173 });
    expect(rasterDimensions(new TextEncoder().encode("<svg/>"))).toBeUndefined();
    expect(rasterDimensions(bytes([255, 216, 255]))).toBeUndefined();
    expect(isSpacerRaster(jpeg(1, 1))).toBe(true);
    expect(isSpacerRaster(gif(600, 2))).toBe(true);
    expect(isSpacerRaster(png(16, 16))).toBe(false);
    expect(isSpacerRaster(new Uint8Array(4))).toBe(false);
  });
  it("sizes a drawing set in percentages by its viewBox, keeping absolute sizes", async () => {
    const rebuilt = async (attributes: string) => {
      const source = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg" ${attributes} preserveAspectRatio="none"><image width="831" height="1173" href="cover.jpeg"/></svg>`,
        "image/svg+xml",
      ).documentElement;
      const text = await (await inertSvg(source, async () => "data:image/jpeg;base64,aA==")).text();
      const root = text.slice(0, text.indexOf(">"));
      return ["width", "height"].map((name) => root.match(` ${name}="([^"]*)"`)?.[1] ?? null);
    };
    // Calibre's cover page.
    expect(await rebuilt('width="100%" height="100%" viewBox="0 0 831 1173"')).toEqual([
      "831",
      "1173",
    ]);
    expect(await rebuilt('viewBox="0,0,600,800"')).toEqual(["600", "800"]);
    expect(await rebuilt('width="300px" height="400px" viewBox="0 0 831 1173"')).toEqual([
      "300px",
      "400px",
    ]);
    expect(await rebuilt('width="100%" height="100%"')).toEqual(["100%", "100%"]);
  });
  it("rebuilds SVG drawings without scripts, remote uses, CSS or active attributes", async () => {
    const source = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="evil()"><script>evil()</script><foreignObject>bad</foreignObject><style>@import "https://evil"</style><rect fill="url(https://evil)" width="100"/><use href="https://evil"/><image href="local.png"/><text style="background:url(https://evil)">Real text</text></svg>',
      "image/svg+xml",
    ).documentElement;
    const read = vi.fn(async () => "data:image/png;base64,aA==");
    const blob = await inertSvg(source, read);
    const text = await blob.text();
    expect(text).toContain('href="data:image/png;base64,aA=="');
    expect(text).toContain("Real text");
    expect(text).not.toMatch(/evil|script|foreignObject|style|<use/);
    expect(read).toHaveBeenCalledOnce();
  });
  it("draws only bounded output and releases the input URL after decoding", async () => {
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = vi.fn(() => "blob:input");
        static revokeObjectURL = vi.fn();
      },
    );
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        naturalWidth = 6000;
        naturalHeight = 4000;
        decode = async () => {};
      },
    );
    const canvas = document.createElement("canvas");
    const drawImage = vi.fn();
    vi.spyOn(canvas, "getContext").mockReturnValue({ drawImage } as never);
    vi.spyOn(canvas, "toBlob").mockImplementation((callback) => callback(new Blob(["png"])));
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag) =>
      tag === "canvas" ? canvas : original(tag),
    );
    const result = await renderBookImage(
      new Blob(["source"]),
      "thumbnail",
      new AbortController().signal,
    );
    expect(result.width).toBe(1024);
    expect(result.height).toBe(683);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1024, 683);
    expect(canvas.getContext("2d")!.imageSmoothingQuality).toBe("high");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:input");
  });
  it.each(["image/jpeg", "image/svg+xml"])(
    "keeps validated %s viewer detail without a canvas re-encode",
    async (type) => {
      vi.stubGlobal(
        "URL",
        class extends URL {
          static createObjectURL = vi.fn(() => "blob:source");
          static revokeObjectURL = vi.fn();
        },
      );
      vi.stubGlobal(
        "Image",
        class {
          src = "";
          naturalWidth = 6000;
          naturalHeight = 4000;
          decode = async () => {};
        },
      );
      const create = vi.spyOn(document, "createElement");
      const source = new Blob(["validated source detail"], { type });
      const result = await renderBookImage(source, "viewer", new AbortController().signal);
      expect(result).toEqual({ blob: source, width: 6000, height: 4000 });
      expect(create).not.toHaveBeenCalled();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:source");
    },
  );
  it("aborts a pending decode and revokes its URL without drawing late content", async () => {
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = vi.fn(() => "blob:cancel");
        static revokeObjectURL = vi.fn();
      },
    );
    let resolve!: () => void;
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        decode = () =>
          new Promise<void>((done) => {
            resolve = done;
          });
      },
    );
    const controller = new AbortController();
    const rendered = renderBookImage(new Blob(["source"]), "viewer", controller.signal);
    controller.abort();
    await expect(rendered).rejects.toThrow("Image cancelled");
    resolve();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:cancel");
  });
});

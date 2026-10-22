import ePub from "epubjs";
// @ts-expect-error EPUB.js declares no module for its Archive source; the tests only need its JSZip.
import EpubArchive from "epubjs/src/archive";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installEpubTolerance,
  InvalidEpubDocument,
  EpubResourceLimit,
  parseEpubXml,
  validateEpubSpine,
} from "./epubTolerance";

const missingDc =
  '<package version="3"><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Title</dc:title><dc:language>ja</dc:language></metadata><manifest/><spine/></package>';
const malformedNcx =
  '<ncx><navMap><navPoint><navLabel><text>Chapter</text></navLabel><content src="Text/chapter.xhtml"#toc-001 /></navPoint></navMap></ncx>';

describe("diagnosed EPUB XML tolerance", () => {
  it("recovers the known dc namespace and retains metadata", () => {
    const document = parseEpubXml(missingDc, "opf");
    expect(document.querySelector("metadata")?.textContent).toBe("Titleja");
    expect(
      document.getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", "language")[0]
        ?.textContent,
    ).toBe("ja");
  });

  it("recovers only an NCX fragment outside its quotes", () => {
    expect(parseEpubXml(malformedNcx, "ncx").querySelector("content")?.getAttribute("src")).toBe(
      "Text/chapter.xhtml#toc-001",
    );
    const working = malformedNcx.replace('"#toc-001', '#toc-001"');
    expect(new XMLSerializer().serializeToString(parseEpubXml(working, "ncx"))).toBe(
      new XMLSerializer().serializeToString(new DOMParser().parseFromString(working, "text/xml")),
    );
    for (const refused of [
      malformedNcx.replace("</ncx>", ""),
      malformedNcx.replace("#toc-001", "#bad<id"),
      missingDc.replace("dc:language", "other:language"),
    ]) {
      expect(() => parseEpubXml(refused, refused.startsWith("<ncx") ? "ncx" : "opf")).toThrow(
        InvalidEpubDocument,
      );
    }
    expect(() => parseEpubXml("a".repeat(2 * 1024 * 1024 + 1), "ncx")).toThrow(EpubResourceLimit);
  });

  it("installs before loading and keeps other archive requests unchanged", async () => {
    const archive = {
      request: vi.fn(async (_url: string, _type?: string) => "original"),
      getText: vi.fn(async (url: string) => (url.endsWith("opf") ? missingDc : malformedNcx)),
      zip: { file: vi.fn(() => ({ _data: { uncompressedSize: 1024 } })) },
    };
    const book = {
      archive,
      unarchive: vi.fn(async () => undefined),
      loadNavigation: vi.fn(async (packaging: Record<string, unknown>) => {
        if (packaging.ncxPath) throw new Error("missing optional navigation");
        return { toc: [] };
      }),
    };
    installEpubTolerance(book);
    await book.unarchive();
    expect((await archive.request("/book.opf")) as unknown).toBeInstanceOf(Document);
    expect((await archive.request("/book.opf", "xml")) as unknown).toBeInstanceOf(Document);
    expect(
      ((await archive.request("/toc.ncx")) as unknown as Document)
        .querySelector("content")
        ?.getAttribute("src"),
    ).toContain("#toc-001");
    expect(await archive.request("/image.png")).toBe("original");
    expect(await book.loadNavigation({ ncxPath: "missing.ncx" })).toEqual({ toc: [] });
    archive.zip.file.mockReturnValue({ _data: { uncompressedSize: 3 * 1024 * 1024 } });
    archive.getText.mockClear();
    await expect(archive.request("/book.opf")).rejects.toThrow(EpubResourceLimit);
    expect(archive.getText).not.toHaveBeenCalled();
  });

  it("recovers complete padded XHTML and identical root namespace duplicates only", () => {
    const working =
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><p id="chapter">Text<ruby>字<rt>じ</rt></ruby></p><img src="image.jpg"/></body></html>';
    const duplicated = working.replace(
      "<html xmlns=",
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns=',
    );
    const canonical = new XMLSerializer().serializeToString(parseEpubXml(working, "xhtml"));
    for (const recoverable of [
      working + "\x10".repeat(16),
      duplicated,
      duplicated + "\x10".repeat(16),
    ]) {
      expect(new XMLSerializer().serializeToString(parseEpubXml(recoverable, "xhtml"))).toBe(
        canonical,
      );
    }
    for (const refused of [
      duplicated.slice(0, -7),
      working + "\x10".repeat(15),
      working.replace('id="chapter"', 'id="chapter" id="other"'),
      working.replace("</p>", "\x10</p>"),
    ]) {
      expect(() => parseEpubXml(refused, "xhtml")).toThrow(InvalidEpubDocument);
    }
  });

  it("preflights linear spine documents with cancellation and total limits", async () => {
    const book = {
      spine: {
        each: (cb: (section: { url: string; linear: boolean }) => void) =>
          [
            { url: "/cover.xhtml", linear: true },
            { url: "/text.xhtml", linear: true },
            { url: "/unused.xhtml", linear: false },
          ].forEach(cb),
      },
      archive: {
        zip: { file: vi.fn(() => ({ _data: { uncompressedSize: 1024 } })) },
        request: vi.fn(async (_url: string) =>
          parseEpubXml(
            '<html xmlns="http://www.w3.org/1999/xhtml"><body>Text</body></html>',
            "xhtml",
          ),
        ),
        getText: vi.fn(),
      },
    };
    await validateEpubSpine(book, new AbortController().signal);
    expect(book.archive.request.mock.calls.map((c) => c[0])).toEqual([
      "/cover.xhtml",
      "/text.xhtml",
    ]);
    book.archive.request.mockClear();
    const aborted = new AbortController();
    aborted.abort();
    await validateEpubSpine(book, aborted.signal);
    expect(book.archive.request).not.toHaveBeenCalled();
    book.archive.zip.file.mockReturnValue({ _data: { uncompressedSize: 65 * 1024 * 1024 } });
    await expect(validateEpubSpine(book, new AbortController().signal)).rejects.toThrow(
      EpubResourceLimit,
    );
    expect(book.archive.request).not.toHaveBeenCalled();
    book.archive.zip.file.mockReturnValue({ _data: { uncompressedSize: 1024 } });
    book.archive.request.mockResolvedValue(
      new DOMParser().parseFromString("<html><body>", "application/xhtml+xml"),
    );
    await expect(validateEpubSpine(book, new AbortController().signal)).rejects.toThrow(
      InvalidEpubDocument,
    );
  });
});

describe("archive reads with the pinned EPUB.js engine", () => {
  const limits = { entryBytes: 64 * 1024, totalBytes: 256 * 1024 };
  const chapter =
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><p>Text</p></body></html>';

  /** A synthetic book with one linear chapter and the given manifest assets; `missing`
   * assets are declared in the manifest but absent from the archive. */
  async function epub(
    assets: Record<string, string>,
    { body = chapter, missing = [] as string[] } = {},
  ) {
    const { zip } = new EpubArchive();
    zip.file(
      "META-INF/container.xml",
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    );
    const items = [...missing, ...Object.keys(assets)].map(
      (name, index) =>
        `<item id="a${index}" href="${name}" media-type="${name.endsWith(".css") ? "text/css" : "application/octet-stream"}"/>`,
    );
    zip.file(
      "OPS/book.opf",
      `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">synthetic</dc:identifier><dc:title>Synthetic</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/>${items.join("")}</manifest><spine><itemref idref="c"/></spine></package>`,
    );
    zip.file("OPS/chapter.xhtml", body);
    for (const [name, text] of Object.entries(assets)) zip.file(`OPS/${name}`, text);
    return (await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })) as Uint8Array;
  }

  /** The serialized chapter as a rendition would show it, with its asset URLs. */
  async function shown(book: Awaited<ReturnType<typeof open>>) {
    const section = book.spine.get(0)!;
    return (await section.render(book.load.bind(book))) as string;
  }

  /** A blob's text. jsdom's Blob has no text(). */
  const read = (blob: Blob) =>
    new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(blob);
    });
  /** The text of the blob behind a `blob:synthetic-N` URL. */
  const blobText = (url: string) => read(urls[Number(url.split("-").at(-1)) - 1]!);

  /** The local data offset and central size field of one entry. */
  function locate(bytes: Uint8Array, name: string) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const named = (at: number) =>
      new TextDecoder().decode(bytes.subarray(at, at + name.length)) === name;
    let data = -1;
    let size = -1;
    for (let at = 0; at < bytes.length - 46; at++) {
      const signature = view.getUint32(at, true);
      if (signature === 0x04034b50 && named(at + 30))
        data = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
      if (signature === 0x02014b50 && named(at + 46)) size = at + 24;
    }
    return { view, data, size };
  }

  async function open(bytes: Uint8Array, bounds = limits) {
    const book = ePub({ replacements: "blobUrl" });
    installEpubTolerance(book as unknown as Parameters<typeof installEpubTolerance>[0], bounds);
    const opened = (async () => {
      await book.open(bytes.buffer as ArrayBuffer, "binary");
      await book.opened;
      await validateEpubSpine(
        book as unknown as Parameters<typeof validateEpubSpine>[0],
        new AbortController().signal,
      );
      return book;
    })();
    // EPUB.js leaves opening pending on an unforwarded archive rejection.
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      opened,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("opening is still pending")), 3000);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  const urls: Blob[] = [];
  beforeEach(() => {
    urls.length = 0;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      urls.push(blob);
      return `blob:synthetic-${urls.length}`;
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("opens small books and drops an oversized unused asset without inflating it", async () => {
    const book = await open(
      await epub({ "style.css": "p { color: red }", "unused.dat": "x".repeat(65 * 1024) }),
    );
    expect(urls.some((blob) => blob.size > 64 * 1024)).toBe(false);
    expect(urls.some((blob) => blob.size === 16)).toBe(true);
    const archive = book.archive;
    await expect(archive.getText("/OPS/unused.dat")).rejects.toThrow(EpubResourceLimit);
    await expect(archive.request("/OPS/unused.dat", "blob")).rejects.toThrow(EpubResourceLimit);
    expect(await archive.request("/OPS/style.css", "text")).toBe("p { color: red }");
  });

  it("creates a section's asset URLs as it is shown, each at its own asset's index", async () => {
    const book = await open(
      await epub(
        { "seen.png": "seen", "later.png": "later", "unused.png": "unused" },
        {
          body: chapter.replace(
            "<p>Text</p>",
            '<p>Text</p><img src="seen.png" alt=""/><img src="later.png" alt=""/>',
          ),
          // Listed first, so EPUB.js's eager list gave "seen.png" the URL of "later.png".
          missing: ["gone.png"],
        },
      ),
    );
    expect(urls).toEqual([]);
    const output = await shown(book);
    const sources = [...output.matchAll(/src="([^"]+)"/g)].map((match) => match[1]!);
    expect(sources).toHaveLength(2);
    expect(await Promise.all(sources.map(blobText))).toEqual(["seen", "later"]);
    // Only the shown section's assets were read.
    expect(urls).toHaveLength(2);
    // Showing it again reuses its URLs.
    await shown(book);
    expect(urls).toHaveLength(2);
  });

  it("prepares the assets a stylesheet names as the book opens", async () => {
    const book = await open(
      await epub(
        {
          "style.css": '@font-face { font-family: Book; src: url("font.woff") }',
          "font.woff": "font",
          "picture.png": "picture",
        },
        {
          body: chapter.replace(
            "<title>One</title>",
            '<title>One</title><link rel="stylesheet" href="style.css"/>',
          ),
        },
      ),
    );
    const texts = await Promise.all(urls.map(read));
    expect(texts).toContain("font");
    expect(texts).not.toContain("picture");
    const css = texts.find((text) => text.startsWith("@font-face"))!;
    const font = css.match(/url\("([^"]+)"\)/)![1]!;
    expect(await blobText(font)).toBe("font");
    const output = await shown(book);
    const stylesheet = output.match(/href="(blob:[^"]+)"/)![1]!;
    expect(await blobText(stylesheet)).toBe(css);
  });

  it("resolves asset references spelled other than their relative paths", async () => {
    const book = await open(
      await epub(
        {
          "images/a.png": "a",
          "images/b.png": "b",
          "images/c.png": "c",
          // As converters write them: from the package's own directory.
          "style.css": "@font-face { font-family: Book; src: url(../OPS/fonts/f.woff?#iefix) }",
          "fonts/f.woff": "f",
        },
        {
          body: chapter
            .replace(
              "<title>One</title>",
              '<title>One</title><link rel="stylesheet" href="./style.css"/>',
            )
            .replace(
              "<p>Text</p>",
              '<p><a href="#note">Text</a></p><img src="../OPS/images/a.png" alt=""/>' +
                '<img src="images/b.png?v=2" srcset="./images/b.png 1x, images/../images/c.png 2x" alt=""/>',
            ),
        },
      ),
    );
    const output = await shown(book);
    const sources = [...output.matchAll(/ src="([^"]+)"/g)].map((match) => match[1]!);
    expect(await Promise.all(sources.map(blobText))).toEqual(["a", "b"]);
    const [one, two] = output.match(/srcset="([^"]+)"/)![1]!.split(", ");
    expect(one).toMatch(/ 1x$/);
    expect(two).toMatch(/ 2x$/);
    expect(await blobText(one!.split(" ")[0]!)).toBe("b");
    expect(await blobText(two!.split(" ")[0]!)).toBe("c");
    expect(output).toContain('href="#note"');
    const css = await blobText(output.match(/href="(blob:[^"]+)"/)![1]!);
    const [, font, fragment] = css.match(/url\((blob:[^#)]+)(#[^)]*)\)/)!;
    expect(fragment).toBe("#iefix");
    expect(await blobText(font!)).toBe("f");
  });

  it("refuses the book once its assets exceed the running total", async () => {
    const assets = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`part${index}.dat`, "y".repeat(60 * 1024)]),
    );
    await expect(open(await epub(assets))).rejects.toThrow(EpubResourceLimit);
    expect(urls.reduce((total, blob) => total + blob.size, 0)).toBeLessThanOrEqual(256 * 1024);
  });

  it("stops inflating an entry that exceeds its declared size", async () => {
    const bytes = await epub({ "false.dat": "z".repeat(60 * 1024) });
    const { view, size } = locate(bytes, "OPS/false.dat");
    view.setUint32(size, 1024, true);
    const book = await open(bytes);
    await expect(book.archive.getBlob("/OPS/false.dat")).rejects.toThrow(EpubResourceLimit);
    expect(urls.some((blob) => blob.size > 1024)).toBe(false);
  });

  it("settles opening when a compressed entry is damaged", async () => {
    const asset = await epub({ "style.css": `p { margin: 0 }${" ".repeat(4096)}` });
    const damaged = locate(asset, "OPS/style.css");
    asset[damaged.data] = 7;
    const book = await open(asset);
    await expect(book.archive.createUrl("/OPS/style.css", { base64: false })).rejects.toThrow(
      InvalidEpubDocument,
    );

    const document = await epub({});
    const text = locate(document, "OPS/chapter.xhtml");
    document[text.data] = 7;
    await expect(open(document)).rejects.toThrow(InvalidEpubDocument);
  });
});

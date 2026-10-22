/** Bounded repairs for format defects reproduced in the read-only real corpus. */
const XML_BYTES = 2 * 1024 * 1024;
const DC = "http://purl.org/dc/elements/1.1/";

export class InvalidEpubDocument extends Error {}
export class EpubResourceLimit extends Error {}

function valid(document: Document) {
  return !document.getElementsByTagName("parsererror").length;
}

function recoverXhtml(text: string) {
  if (text.endsWith("\u0010".repeat(16))) text = text.slice(0, -16);
  return text.replace(/<html\s[^>]*>/, (root) =>
    root.replace(/(xmlns="http:\/\/www\.w3\.org\/1999\/xhtml")\s+\1/, "$1"),
  );
}

export function parseEpubXml(text: string, type: "opf" | "ncx" | "xhtml"): Document {
  if (new TextEncoder().encode(text).length > XML_BYTES) throw new EpubResourceLimit();
  const parser = new DOMParser();
  const mime = type === "xhtml" ? "application/xhtml+xml" : "text/xml";
  let document = parser.parseFromString(text, mime);
  if (valid(document)) return document;
  const repaired =
    type === "opf"
      ? text.replace(/<package(?=[\s>])/, `<package xmlns:dc="${DC}"`)
      : type === "ncx"
        ? text.replace(/(<content\s+src="[^"<>#]+)"#([\w.:-]+)(\s*\/\s*>)/g, '$1#$2"$3')
        : recoverXhtml(text);
  document = parser.parseFromString(repaired, mime);
  if (
    !valid(document) ||
    document.documentElement.localName !==
      (type === "opf" ? "package" : type === "ncx" ? "ncx" : "html")
  ) {
    throw new InvalidEpubDocument();
  }
  return document;
}

interface ZipStream {
  on(event: "data", listener: (chunk: Uint8Array) => void): ZipStream;
  on(event: "error", listener: (error: unknown) => void): ZipStream;
  on(event: "end", listener: () => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
}

interface ZipEntry {
  _data?: { uncompressedSize?: number };
  async?(type: string): Promise<unknown>;
  internalStream?(type: "uint8array"): ZipStream;
}

interface Archive {
  request(url: string, type?: string): Promise<unknown>;
  getText(url: string): Promise<string> | undefined;
  getBlob?(url: string): Promise<Blob> | undefined;
  createUrl?(url: string, options?: { base64?: boolean }): Promise<string>;
  getBase64?(url: string): Promise<string> | undefined;
  handleResponse?(response: unknown, type?: string): unknown;
  urlCache?: Record<string, string>;
  zip?: { file(name: string): ZipEntry | null };
}

interface Resources {
  urls?: string[];
  cssUrls?: string[];
  replacementUrls?: string[];
  settings?: { resolver(href: string): string };
  createUrl(url: string): Promise<string>;
  relativeTo(absolute: string): string[];
  substitute(content: string, url?: string): string;
}

interface RecoverableBook {
  archive?: Archive;
  resources?: Resources;
  spine?: {
    hooks: {
      serialize: {
        register(
          hook: (output: string, section: { url: string; output?: string }) => unknown,
        ): void;
      };
    };
  };
  replacements?(): Promise<unknown>;
  unarchive(input: unknown, encoding?: unknown): Promise<unknown>;
  loadNavigation(packaging: Record<string, unknown>): Promise<unknown>;
}

/** Inflation budgets. The read-only corpus (5,091 books) peaks at a 5.7 MiB image,
 * 1.5 MiB font, 1.2 MiB stylesheet and 153 MiB of assets in one book. */
export interface EpubArchiveLimits {
  entryBytes: number;
  totalBytes: number;
}

const ARCHIVE_LIMITS: EpubArchiveLimits = {
  entryBytes: 32 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
};

/** Inflate one entry after its declared size fits, stopping as soon as the actual
 * bytes exceed it. Damaged data rejects with a typed error. */
function inflate(entry: ZipEntry & { internalStream(type: "uint8array"): ZipStream }) {
  const declared = entry._data?.uncompressedSize ?? 0;
  return new Promise<Uint8Array>((resolve, reject) => {
    const stream = entry.internalStream("uint8array");
    const chunks: Uint8Array[] = [];
    let length = 0;
    stream
      .on("data", (chunk) => {
        length += chunk.length;
        if (length <= declared) chunks.push(chunk);
        else {
          stream.pause();
          reject(new EpubResourceLimit());
        }
      })
      .on("error", () => reject(new InvalidEpubDocument()))
      .on("end", () => {
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        resolve(bytes);
      })
      .resume();
  });
}

/** EPUB.js only forwards successful archive reads, so a damaged entry would leave
 * opening pending. Its getBlob/getText/getBase64 now inflate within the per-entry and
 * running-total budgets, and its URL and request reads settle when an entry is refused.
 */
function limitArchiveReads(archive: Archive, limits: EpubArchiveLimits) {
  const zip = archive.zip!;
  const file = zip.file.bind(zip);
  const counted = new Set<string>();
  let total = 0;
  let exhausted = false;
  /** Counts an entry's declared size against the running total; false once it is refused. */
  const count = (name: string, declared: number) => {
    if (exhausted || declared > limits.entryBytes) return false;
    if (!counted.has(name)) {
      if (total + declared > limits.totalBytes) {
        exhausted = true;
        return false;
      }
      counted.add(name);
      total += declared;
    }
    return true;
  };
  const read = (name: string, entry: Parameters<typeof inflate>[0]) =>
    count(name, entry._data?.uncompressedSize ?? 0)
      ? inflate(entry)
      : Promise.reject(new EpubResourceLimit());
  zip.file = (name) => {
    const entry = file(name);
    if (!entry?.internalStream) return entry;
    const stream = entry as Parameters<typeof inflate>[0];
    return Object.create(entry, {
      async: {
        value: (type: string) =>
          read(name, stream).then((bytes) => {
            if (type === "uint8array") return bytes;
            // JSZip keeps a byte order mark in its text output.
            if (type === "string")
              return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
            let binary = "";
            for (let offset = 0; offset < bytes.length; offset += 0x8000)
              binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
            return btoa(binary);
          }),
      },
    }) as ZipEntry;
  };

  const createUrl = archive.createUrl!.bind(archive);
  archive.createUrl = async (url, options) => {
    const cache = (archive.urlCache ??= {});
    if (url in cache) return cache[url];
    const response = options?.base64 ? archive.getBase64!(url) : archive.getBlob!(url);
    // A missing entry keeps EPUB.js's own rejection.
    if (!response) return createUrl(url, options);
    const value = await response;
    const created = typeof value === "string" ? value : URL.createObjectURL(value);
    cache[url] = created;
    return created;
  };
  return {
    request: (url: string, type: string | undefined) => {
      const response = type === "blob" ? archive.getBlob!(url) : archive.getText(url);
      return response?.then((value) => archive.handleResponse!(value, type));
    },
    /** Counts an asset as if it were read now, without inflating it. */
    reserve: (url: string) => {
      const name = decodeURIComponent(url.replace(/^\//, ""));
      count(name, file(name)?._data?.uncompressedSize ?? 0);
    },
  };
}

const ARCHIVE_ORIGIN = "https://komori-book.invalid";

/** The decoded archive path a relative reference names from a base path. A reference
 * with a scheme, a network path or only a fragment names no archive entry. */
function referencedPath(reference: string, base: string): string | undefined {
  if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) return undefined;
  try {
    const url = new URL(reference, new URL(base, `${ARCHIVE_ORIGIN}/`));
    return url.origin === ARCHIVE_ORIGIN ? decodeURIComponent(url.pathname) : undefined;
  } catch {
    return undefined;
  }
}

/** URL-bearing attribute values, and CSS url() values, in markup or stylesheet text. */
const ATTRIBUTE_REFERENCE = /(\s(?:[\w-]+:)?(srcset|src|href|poster|data)\s*=\s*)(["'])(.*?)\3/gis;
const CSS_REFERENCE = /(url\(\s*)(["']|&quot;|&apos;)?(.*?)\2(\s*\))/gis;

/**
 * A text with each reference a function finds a URL for replaced by that URL, keeping
 * the reference's fragment. Serialized markup escapes its ampersands; stylesheet text
 * does not. Every other character of the text stays as it was.
 */
function rewriteReferences(
  text: string,
  markup: boolean,
  replace: (reference: string) => string | undefined,
): string {
  const each = (value: string) => {
    const url = replace((markup ? value.replaceAll("&amp;", "&") : value).trim());
    if (url === undefined) return value;
    const fragment = value.indexOf("#");
    return fragment < 0 ? url : url + value.slice(fragment).trim();
  };
  const rewritten = markup
    ? text.replace(
        ATTRIBUTE_REFERENCE,
        (_, start: string, name: string, quote: string, value: string) =>
          start +
          quote +
          // Each srcset candidate starts with its URL; descriptors follow a space.
          (name.toLowerCase() === "srcset"
            ? value.replace(
                /(^|,)(\s*)([^\s,]+)/g,
                (__, comma: string, space: string, url: string) => comma + space + each(url),
              )
            : each(value)) +
          quote,
      )
    : text;
  return rewritten.replace(
    CSS_REFERENCE,
    (_, start: string, quote = "", value: string, end: string) =>
      start + quote + each(value) + quote + end,
  );
}

/** EPUB.js inflates every manifest asset into a blob URL before a book opens (about
 * 8 ms a megabyte: over a second for a large illustrated book) and drops the assets it
 * cannot read from its URL list, so every later asset takes the URL of the one after
 * it. Here each asset's URL is created at its own index when a section that names it
 * is shown, or as the book opens for an asset a stylesheet names. Assets still count
 * against the running total in manifest order as the book opens, so a book whose
 * assets exceed it is refused as before.
 *
 * EPUB.js also swaps only the text of each asset's canonical relative path, so a
 * reference spelled another way, such as `../OEBPS/images/a.jpg` from `OEBPS/`, a
 * differently encoded name or a query, kept naming a file the page cannot load. Each
 * reference is now resolved against its document or stylesheet first; EPUB.js's own
 * swap still follows for text the references here do not cover.
 */
function replaceAssetsOnDemand(book: RecoverableBook, reserve: (url: string) => void) {
  const resources = book.resources;
  const resolve = resources?.settings?.resolver;
  if (!resources?.urls || !resolve || !book.spine) return Promise.resolve();
  const urls = resources.urls;
  const indexes = new Map<string, number>();
  urls.forEach((url, index) => {
    reserve(resolve(url));
    const path = referencedPath(resolve(url), "/");
    if (path && !indexes.has(path)) indexes.set(path, index);
  });
  resources.replacementUrls = [];
  const pending = new Map<number, Promise<void>>();
  const create = (index: number) => {
    // A stylesheet keeps the rewritten copy made as the book opened.
    if (resources.replacementUrls?.[index]) return;
    let created = pending.get(index);
    if (!created) {
      created = resources.createUrl(resolve(urls[index]!)).then(
        (url) => {
          // A URL created after the book closed is released at once.
          if (resources.replacementUrls) resources.replacementUrls[index] = url;
          else if (url.startsWith("blob:")) URL.revokeObjectURL(url);
        },
        // A refused or damaged asset is left out: its reference stays unresolved.
        () => undefined,
      );
      pending.set(index, created);
    }
    return created;
  };
  /** The manifest index of the asset a reference names from a path, if any. */
  const asset = (reference: string, path: string) => {
    const named = referencedPath(reference, path);
    return named === undefined ? undefined : indexes.get(named);
  };
  /** Creates the URLs of the assets a text references, or names by EPUB.js's canonical
   * relative path, from its own path. */
  const prepare = (text: string, markup: boolean, path: string) => {
    const wanted = new Set<number>();
    rewriteReferences(text, markup, (reference) => {
      const index = asset(reference, path);
      if (index !== undefined) wanted.add(index);
      return undefined;
    });
    resources.relativeTo(path).forEach((relative, index) => {
      if (relative && text.includes(relative)) wanted.add(index);
    });
    return Promise.all([...wanted].map(create));
  };
  /** A text with its assets' URLs in place of their references. */
  const substitute = (text: string, markup: boolean, path: string) =>
    resources.substitute(
      rewriteReferences(text, markup, (reference) => {
        const index = asset(reference, path);
        return index === undefined ? undefined : resources.replacementUrls?.[index] || undefined;
      }),
      path,
    );
  book.spine.hooks.serialize.register(async (output, section) => {
    // A book closed while a section renders has no resources left to substitute.
    if (!resources.urls) return;
    await prepare(output, true, section.url);
    if (resources.urls) section.output = substitute(output, true, section.url);
  });
  return (async () => {
    for (const href of resources.cssUrls ?? []) {
      const index = urls.indexOf(href);
      const path = resolve(href);
      const text = await book.archive?.getText(path)?.catch(() => undefined);
      if (text === undefined || index < 0 || !resources.urls) continue;
      await prepare(text, false, path);
      if (!resources.replacementUrls) return;
      const css = new Blob([substitute(text, false, path)], { type: "text/css" });
      resources.replacementUrls[index] = URL.createObjectURL(css);
    }
  })();
}

/** Install before open: EPUB.js loads its package/navigation during unarchive/unpack. */
export function installEpubTolerance(book: RecoverableBook, limits = ARCHIVE_LIMITS) {
  const unarchive = book.unarchive.bind(book);
  book.unarchive = async (...args) => {
    const result = await unarchive(...args);
    const archive = book.archive;
    if (!archive) return result;
    const request = archive.request.bind(archive);
    // Only EPUB.js's own archive creates replacement URLs from JSZip entries.
    const limited = archive.createUrl ? limitArchiveReads(archive, limits) : undefined;
    // EPUB.js prepares asset URLs as it unpacks the package, after unarchiving.
    if (limited && book.replacements)
      book.replacements = () => replaceAssetsOnDemand(book, limited.reserve);
    archive.request = async (url, type) => {
      const extension = url.split(".").at(-1);
      const kind = type === "xml" ? extension : (type ?? extension);
      if (kind !== "opf" && kind !== "ncx" && kind !== "xhtml")
        return limited?.request(url, type ?? extension) ?? request(url, type);
      // Check JSZip's declared size before inflation, then the actual UTF-8 bytes.
      const entry = archive.zip?.file(decodeURIComponent(url.replace(/^\//, "")));
      if ((entry?._data?.uncompressedSize ?? 0) > XML_BYTES) throw new EpubResourceLimit();
      const text = await archive.getText(url);
      if (text === undefined) throw new InvalidEpubDocument();
      return parseEpubXml(text, kind);
    };
    return result;
  };
  const navigation = book.loadNavigation.bind(book);
  // Navigation is optional. EPUB.js otherwise leaves loaded.navigation pending when
  // a declared file is missing or unreadable. Its own empty parser keeps that honest.
  book.loadNavigation = async (packaging) => {
    try {
      return await navigation(packaging);
    } catch {
      return navigation({ ...packaging, navPath: "", ncxPath: "" });
    }
  };
}

/** Check linear documents before rendering, so a parser error cannot become a page
 * or overwrite a saved position. Documents remain session-local, read-only reads.
 */
export async function validateEpubSpine(
  book: {
    archive?: Archive;
    spine: { each(callback: (section: { linear?: boolean; url: string }) => void): void };
  },
  signal: AbortSignal,
) {
  if (!book.archive?.zip) throw new InvalidEpubDocument();
  const sections: string[] = [];
  book.spine.each((section) => {
    if (section.linear) sections.push(section.url);
  });
  if (sections.length > 10_000) throw new EpubResourceLimit();
  let bytes = 0;
  for (const url of sections) {
    if (signal.aborted) return;
    const entry = book.archive?.zip?.file(decodeURIComponent(url.replace(/^\//, "")));
    bytes += entry?._data?.uncompressedSize ?? 0;
    if (bytes > 64 * 1024 * 1024) throw new EpubResourceLimit();
    const document = (await book.archive.request(url)) as Document;
    if (!document?.documentElement || !valid(document)) throw new InvalidEpubDocument();
  }
}

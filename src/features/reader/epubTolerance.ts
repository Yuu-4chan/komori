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

interface RecoverableBook {
  archive?: Archive;
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

/** EPUB.js inflates every manifest asset before Komori's spine preflight, and only
 * forwards successful reads, so a damaged entry would leave opening pending. Its
 * getBlob/getText/getBase64 now inflate within the per-entry and running-total
 * budgets, and its URL and request reads settle when an entry is refused.
 */
function limitArchiveReads(archive: Archive, limits: EpubArchiveLimits) {
  const zip = archive.zip!;
  const file = zip.file.bind(zip);
  const counted = new Set<string>();
  let total = 0;
  let exhausted = false;
  const read = (name: string, entry: Parameters<typeof inflate>[0]) => {
    const declared = entry._data?.uncompressedSize ?? 0;
    if (exhausted || declared > limits.entryBytes) return Promise.reject(new EpubResourceLimit());
    if (!counted.has(name)) {
      if (total + declared > limits.totalBytes) {
        exhausted = true;
        return Promise.reject(new EpubResourceLimit());
      }
      counted.add(name);
      total += declared;
    }
    return inflate(entry);
  };
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
  return (url: string, type: string | undefined) => {
    const response = type === "blob" ? archive.getBlob!(url) : archive.getText(url);
    return response?.then((value) => archive.handleResponse!(value, type));
  };
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
    archive.request = async (url, type) => {
      const extension = url.split(".").at(-1);
      const kind = type === "xml" ? extension : (type ?? extension);
      if (kind !== "opf" && kind !== "ncx" && kind !== "xhtml")
        return limited?.(url, type ?? extension) ?? request(url, type);
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

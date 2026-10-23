/**
 * A JSZip-shaped EPUB archive whose entries the native side lists and reads (see Reader
 * content access). EPUB.js reads it in place of JSZip, so opening a book transfers the
 * entries it reads rather than its whole archive.
 */
import { EpubResourceLimit, InvalidEpubDocument } from "./epubTolerance";

/** Bundle frames the native side writes for an entry over its entry limit and for damage. */
const TOO_LARGE_FRAME = 0xffff_ffff;
const DAMAGED_FRAME = 0xffff_fffe;
/** The native entry limit. A larger entry is refused natively, so it is never fetched ahead. */
const ENTRY_BYTES = 32 * 1024 * 1024;
/** Declared bytes and entries per bundle request, within the native bundle bounds. */
const BUNDLE_BYTES = 8 * 1024 * 1024;
const BUNDLE_ENTRIES = 1_000;
/** Bytes of text entries read one at a time that a book's session keeps. */
const KEPT_TEXT_BYTES = 16 * 1024 * 1024;
/** An empty ZIP: its end-of-central-directory record alone. */
const EMPTY_ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);

export interface NativeEntry {
  readonly name: string;
  readonly dir: false;
  /** JSZip's declared size, which the adapter's archive budgets read. */
  readonly _data: { readonly uncompressedSize: number };
  async(type: string): Promise<unknown>;
}

function failure(status: number) {
  if (status === 413) return new EpubResourceLimit();
  if (status === 422) return new InvalidEpubDocument();
  return new Error("EPUB content unavailable");
}

function unavailable(): never {
  throw new Error("EPUB content unavailable");
}

export class NativeZip {
  private readonly entries = new Map<string, { number: number; size: number }>();
  /** Entries fetched ahead in bundles, and text entries read alone, kept for the book's
   * session. */
  private readonly prefetched = new Map<number, Promise<Uint8Array>>();
  private keptText = 0;

  constructor(
    private readonly url: string,
    private readonly signal: AbortSignal,
    listing: unknown,
  ) {
    if (!Array.isArray(listing)) unavailable();
    listing.forEach((entry: unknown, number) => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        !Number.isSafeInteger(entry[1]) ||
        entry[1] < 0
      )
        unavailable();
      this.entries.set(entry[0], { number, size: entry[1] as number });
    });
  }

  /** The named file, as JSZip's `file()` returns it, or null. */
  file(name: string): NativeEntry | null {
    const entry = this.entries.get(name);
    if (!entry) return null;
    return {
      name,
      dir: false,
      _data: { uncompressedSize: entry.size },
      async: async (type) => {
        const bytes = await (type === "string" ? this.readText(entry) : this.read(entry.number));
        if (type === "uint8array") return bytes;
        // JSZip keeps a byte order mark in its text output.
        if (type === "string") return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
        if (type !== "base64") throw new Error(`Unsupported entry type ${type}`);
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        return btoa(binary);
      },
    };
  }

  /** Fetches the named entries ahead, a few bundle requests for many small documents, and
   * keeps them for later reads. Each read still counts against the adapter's budgets. */
  prefetch(names: Iterable<string>) {
    let batch: number[] = [];
    let bytes = 0;
    const send = () => {
      if (!batch.length) return;
      const numbers = batch;
      const frames = this.bundle(numbers);
      numbers.forEach((number, index) => {
        const read = frames.then((frames) => {
          const frame = frames[index]!;
          if (frame instanceof Error) throw frame;
          return frame;
        });
        // A read that fails is reported to whoever reads that entry, if anyone does.
        read.catch(() => undefined);
        this.prefetched.set(number, read);
      });
      batch = [];
      bytes = 0;
    };
    for (const name of names) {
      const entry = this.entries.get(name);
      if (!entry || entry.size > ENTRY_BYTES || this.prefetched.has(entry.number)) continue;
      if (batch.length && (bytes + entry.size > BUNDLE_BYTES || batch.length === BUNDLE_ENTRIES))
        send();
      batch.push(entry.number);
      bytes += entry.size;
    }
    send();
  }

  private async fetch(url: string, init?: RequestInit) {
    const response = await fetch(url, { ...init, signal: this.signal, cache: "no-store" });
    if (!response.ok) throw failure(response.status);
    return new Uint8Array(await response.arrayBuffer());
  }

  private read(number: number) {
    return this.prefetched.get(number) ?? this.fetch(`${this.url}/${number}`);
  }

  /** EPUB.js and the adapter each read the package document and stylesheets again as a
   * book opens; a text entry is read once, within a budget. */
  private readText(entry: { number: number; size: number }) {
    const read = this.read(entry.number);
    if (!this.prefetched.has(entry.number) && this.keptText + entry.size <= KEPT_TEXT_BYTES) {
      this.keptText += entry.size;
      this.prefetched.set(entry.number, read);
      // A read that fails is reported to whoever reads that entry.
      read.catch(() => undefined);
    }
    return read;
  }

  /** One bundle: the entries' little-endian u32 numbers in, length-framed entries out. */
  private async bundle(numbers: number[]) {
    const request = new DataView(new ArrayBuffer(numbers.length * 4));
    numbers.forEach((number, index) => request.setUint32(index * 4, number, true));
    // A body without a content type keeps this a simple request, with no CORS preflight.
    const bytes = await this.fetch(this.url, { method: "POST", body: request.buffer });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frames: (Uint8Array | Error)[] = [];
    let at = 0;
    for (let index = 0; index < numbers.length; index++) {
      if (at + 4 > bytes.length) unavailable();
      const length = view.getUint32(at, true);
      at += 4;
      if (length === TOO_LARGE_FRAME) frames.push(new EpubResourceLimit());
      else if (length === DAMAGED_FRAME) frames.push(new InvalidEpubDocument());
      else {
        if (at + length > bytes.length) unavailable();
        frames.push(bytes.subarray(at, at + length));
        at += length;
      }
    }
    if (at !== bytes.length) unavailable();
    return frames;
  }
}

/** Fetches the entry list of a prepared content URL. */
export async function openNativeArchive(url: string, signal: AbortSignal): Promise<NativeZip> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw failure(response.status);
  return new NativeZip(url, signal, await response.json());
}

/**
 * EPUB.js builds its archive only as it unarchives what its request method returned. It
 * gets an empty ZIP to build its archive around, and the native archive takes the place of
 * its JSZip before anything reads it. Install before the adapter's tolerance, which reads
 * the archive EPUB.js built.
 */
export function installNativeArchive(book: {
  archive?: { zip?: unknown };
  unarchive(input: unknown, encoding?: unknown): Promise<unknown>;
}) {
  const unarchive = book.unarchive.bind(book);
  book.unarchive = async (input, encoding) => {
    if (!(input instanceof NativeZip)) throw new InvalidEpubDocument();
    const opened = unarchive(EMPTY_ZIP, encoding);
    book.archive!.zip = input;
    await opened;
    return input;
  };
}

import { afterEach, describe, expect, it, vi } from "vitest";

import { EpubResourceLimit, InvalidEpubDocument } from "./epubTolerance";
import { installNativeArchive, NativeZip, openNativeArchive } from "./nativeArchive";

const url = "http://komori-book.localhost/11111111-1111-4111-8111-111111111111/0123456789abcdef";
const MiB = 1024 * 1024;

function reply(body: Uint8Array | string | unknown, status = 200) {
  return {
    ok: status === 200,
    status,
    json: async () => body,
    arrayBuffer: async () =>
      (typeof body === "string" ? new TextEncoder().encode(body) : (body as Uint8Array)).slice()
        .buffer,
  };
}

/** A bundle response: each entry framed by its little-endian u32 length, or a bare frame. */
function bundle(...entries: (string | number)[]) {
  const bytes: number[] = [];
  for (const entry of entries) {
    const data = typeof entry === "string" ? new TextEncoder().encode(entry) : undefined;
    const frame = new DataView(new ArrayBuffer(4));
    frame.setUint32(0, data?.length ?? (entry as number), true);
    bytes.push(...new Uint8Array(frame.buffer), ...(data ?? []));
  }
  return new Uint8Array(bytes);
}

type Fetch = (url: string, init?: RequestInit) => Promise<ReturnType<typeof reply>>;

/** The entry numbers a bundle request names. */
function numbers(init: RequestInit | undefined) {
  const view = new DataView(init!.body as ArrayBuffer);
  return Array.from({ length: view.byteLength / 4 }, (_, index) => view.getUint32(index * 4, true));
}

describe("native EPUB archive", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads entries as JSZip returns them", async () => {
    const fetch = vi.fn<Fetch>(async () => reply("\uFEFFé"));
    vi.stubGlobal("fetch", fetch);
    const zip = new NativeZip(url, new AbortController().signal, [
      ["a.xhtml", 5],
      ["b.png", 3],
    ]);
    expect(zip.file("missing")).toBeNull();
    const entry = zip.file("a.xhtml")!;
    expect(entry).toMatchObject({ name: "a.xhtml", dir: false, _data: { uncompressedSize: 5 } });
    // JSZip keeps a byte order mark in its text output.
    expect(await entry.async("string")).toBe("\uFEFFé");
    expect([...((await entry.async("uint8array")) as Uint8Array)]).toEqual([
      0xef, 0xbb, 0xbf, 0xc3, 0xa9,
    ]);
    expect(await entry.async("base64")).toBe(btoa("\xef\xbb\xbf\xc3\xa9"));
    await expect(entry.async("nodebuffer")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledWith(`${url}/0`, expect.objectContaining({ cache: "no-store" }));
    await zip.file("b.png")!.async("uint8array");
    expect(fetch).toHaveBeenLastCalledWith(`${url}/1`, expect.anything());
  });

  it("types native refusals", async () => {
    const zip = new NativeZip(url, new AbortController().signal, [["a", 1]]);
    for (const [status, error] of [
      [413, EpubResourceLimit],
      [422, InvalidEpubDocument],
      [404, Error],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => reply("", status)),
      );
      await expect(zip.file("a")!.async("uint8array")).rejects.toThrow(error);
      await expect(openNativeArchive(url, new AbortController().signal)).rejects.toThrow(error);
    }
  });

  it("accepts only a list of names and sizes", async () => {
    for (const listing of [{}, [["a"]], [["a", -1]], [["a", 1.5]], [[1, 1]], [["a", 1, 2]]]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => reply(listing)),
      );
      await expect(openNativeArchive(url, new AbortController().signal)).rejects.toThrow(
        "EPUB content unavailable",
      );
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply([["a", 1]])),
    );
    const zip = await openNativeArchive(url, new AbortController().signal);
    expect(zip.file("a")?._data.uncompressedSize).toBe(1);
  });

  it("reads a text entry once within a budget, and other reads each time", async () => {
    const fetch = vi.fn<Fetch>(async () => reply("text"));
    vi.stubGlobal("fetch", fetch);
    const zip = new NativeZip(url, new AbortController().signal, [
      ["book.opf", 4],
      ["a.png", 4],
      ["long.xhtml", 16 * MiB],
    ]);
    for (let pass = 0; pass < 2; pass++) {
      expect(await zip.file("book.opf")!.async("string")).toBe("text");
      await zip.file("a.png")!.async("uint8array");
      // Past the budget, a text entry is read each time too.
      await zip.file("long.xhtml")!.async("string");
    }
    expect(fetch.mock.calls.map(([called]) => called)).toEqual([
      `${url}/0`,
      `${url}/1`,
      `${url}/2`,
      `${url}/1`,
      `${url}/2`,
    ]);
  });

  it("reads ahead in bounded bundles and keeps what it read", async () => {
    const signal = new AbortController().signal;
    const fetch = vi.fn(async (_: string, init?: RequestInit) =>
      reply(bundle(...numbers(init).map((number) => `entry ${number}`))),
    );
    vi.stubGlobal("fetch", fetch);
    const sizes: [string, number][] = [
      ["one", 5 * MiB],
      ["two", 3 * MiB],
      ["three", 1 * MiB],
      ["huge", 33 * MiB],
      ...Array.from({ length: 1_001 }, (_, index): [string, number] => [`small${index}`, 1]),
    ];
    const zip = new NativeZip(url, signal, sizes);
    zip.prefetch(["one", "two", "three", "huge", "missing", "one"]);
    // 8 MiB of declared bytes at most in one bundle; an entry over the limit is not asked for.
    expect(fetch.mock.calls.map(([, init]) => numbers(init))).toEqual([[0, 1], [2]]);
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: "POST", signal }));
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).has("content-type")).toBe(false);
    expect(await zip.file("two")!.async("string")).toBe("entry 1");
    expect(await zip.file("three")!.async("string")).toBe("entry 2");
    expect(await zip.file("one")!.async("string")).toBe("entry 0");
    // Read ahead once, they are not fetched again.
    zip.prefetch(["one", "two"]);
    expect(fetch).toHaveBeenCalledTimes(2);

    fetch.mockClear();
    zip.prefetch(sizes.slice(4).map(([name]) => name));
    expect(fetch.mock.calls.map(([, init]) => numbers(init).length)).toEqual([1_000, 1]);
  });

  it("reports a refused bundle entry to its reader alone", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(bundle("fine", 0xffff_ffff, 0xffff_fffe))),
    );
    const zip = new NativeZip(url, new AbortController().signal, [
      ["fine", 4],
      ["long", 1],
      ["damaged", 1],
      ["unread", 1],
    ]);
    zip.prefetch(["fine", "long", "damaged"]);
    expect(await zip.file("fine")!.async("string")).toBe("fine");
    await expect(zip.file("long")!.async("string")).rejects.toThrow(EpubResourceLimit);
    await expect(zip.file("damaged")!.async("string")).rejects.toThrow(InvalidEpubDocument);

    // A malformed bundle fails each of its entries; an entry nobody reads fails quietly.
    for (const malformed of [
      bundle("fine"),
      bundle("fine", "long", "damaged", "extra"),
      bundle(),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => reply(malformed)),
      );
      const fresh = new NativeZip(url, new AbortController().signal, [
        ["fine", 4],
        ["long", 4],
        ["damaged", 4],
      ]);
      fresh.prefetch(["fine", "long", "damaged"]);
      await expect(fresh.file("fine")!.async("string")).rejects.toThrow("EPUB content unavailable");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("takes the place of the JSZip EPUB.js builds as it unarchives", async () => {
    const jszip = {
      loadAsync: vi.fn<(data: unknown) => Promise<undefined>>(async () => undefined),
    };
    const book = {
      archive: undefined as { zip?: unknown } | undefined,
      unarchive(input: unknown) {
        this.archive = { zip: jszip };
        return jszip.loadAsync(input);
      },
    };
    installNativeArchive(book);
    const zip = new NativeZip(url, new AbortController().signal, []);
    await expect(book.unarchive(zip)).resolves.toBe(zip);
    expect(book.archive!.zip).toBe(zip);
    // EPUB.js's own JSZip only ever saw an empty archive.
    expect([...(jszip.loadAsync.mock.calls[0]![0] as Uint8Array)]).toEqual([
      0x50,
      0x4b,
      0x05,
      0x06,
      ...new Uint8Array(18),
    ]);
    await expect(book.unarchive(new ArrayBuffer(8))).rejects.toThrow(InvalidEpubDocument);
  });
});

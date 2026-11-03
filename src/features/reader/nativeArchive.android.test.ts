import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/platform", () => ({ isAndroid: true }));

const { NativeZip } = await import("./nativeArchive");

const url = "http://komori-book.localhost/11111111-1111-4111-8111-111111111111/0123456789abcdef";

describe("native EPUB archive on Android", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists a bundle's entry numbers in its path, as the WebView passes no bodies", async () => {
    const signal = new AbortController().signal;
    const frames = new Uint8Array([1, 0, 0, 0, 0x61, 1, 0, 0, 0, 0x62]);
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => frames.slice().buffer,
    }));
    vi.stubGlobal("fetch", fetch);
    const zip = new NativeZip(url, signal, [
      ["a.xhtml", 1],
      ["b.xhtml", 1],
    ]);
    zip.prefetch(["b.xhtml", "a.xhtml"]);
    expect(await zip.file("b.xhtml")!.async("string")).toBe("a");
    expect(await zip.file("a.xhtml")!.async("string")).toBe("b");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(`${url}/bundle/1,0`);
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty("method");
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty("body");
  });
});

import { describe, expect, it, vi } from "vitest";

import { getWikipediaSummary } from "./wikipedia";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => true }));

const found = (url: string) => ({
  status: "found",
  title: "香港",
  description: null,
  extract: "…",
  url,
});

describe("Wikipedia summaries", () => {
  it("accepts a page only on a Wikipedia, including one named after another code", async () => {
    for (const url of [
      "https://ja.wikipedia.org/wiki/%E6%9D%B1%E4%BA%AC",
      "https://no.wikipedia.org/wiki/Oslo",
      "https://zh-yue.wikipedia.org/wiki/%E9%A6%99%E6%B8%AF",
      "https://zh-min-nan.wikipedia.org/wiki/Tai-oan",
    ]) {
      invoke.mockResolvedValueOnce(found(url));
      expect(await getWikipediaSummary("x", "ja")).toMatchObject({ status: "found", url });
    }
    for (const url of [
      "https://evil.example/wiki/x",
      "http://ja.wikipedia.org/wiki/x",
      "https://ja.wikipedia.org.evil.example/wiki/x",
      "https://-.wikipedia.org/wiki/x",
    ]) {
      invoke.mockResolvedValueOnce(found(url));
      expect(await getWikipediaSummary("x", "ja")).toEqual({ status: "failed" });
    }
    invoke.mockResolvedValueOnce({ status: "missing" });
    expect(await getWikipediaSummary("x", null)).toEqual({ status: "missing" });
    expect(invoke).toHaveBeenLastCalledWith("wikipedia_summary", { text: "x", language: null });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/platform", () => ({ isAndroid: true }));

const { keepFontFiles, keptFontFiles } = await import("./fontFiles");

const face = (id: string) =>
  `@font-face { font-family: "Komori"; src: url("http://komori-font.localhost/${id}/a.ttf"); }`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("font files on the phone", () => {
  it("fetches each font file once and gives the sections its blob URL", async () => {
    const fetch = vi.fn(async () => new Response(new Blob(["font"])));
    vi.stubGlobal("fetch", fetch);
    let made = 0;
    URL.createObjectURL = vi.fn(() => `blob:kept-${++made}`);

    const css = face("noto") + face("noto");
    expect(keptFontFiles(css)).toBe(css);
    // Sections asking at the same time share one fetch.
    await Promise.all([keepFontFiles(css), keepFontFiles(css)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(keptFontFiles(css)).toBe(
      css.replaceAll("http://komori-font.localhost/noto/a.ttf", "blob:kept-1"),
    );
    // Kept: nothing more to wait for or fetch.
    expect(keepFontFiles(css)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("leaves a font file it could not fetch to Komori's URL, and tries it again later", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const css = face("missing");
    await keepFontFiles(css);
    expect(keptFontFiles(css)).toBe(css);
    await keepFontFiles(css);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(keepFontFiles("p { color: red; }")).toBeUndefined();
  });
});

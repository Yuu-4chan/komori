import { describe, expect, it, vi } from "vitest";

import { keepFontFiles, keptFontFiles } from "./fontFiles";

describe("font files on the PC", () => {
  it("serves the sections Komori's own font URLs, as before", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const css = `@font-face { src: url("http://komori-font.localhost/noto/a.ttf"); }`;
    expect(keepFontFiles(css)).toBeUndefined();
    expect(keptFontFiles(css)).toBe(css);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});

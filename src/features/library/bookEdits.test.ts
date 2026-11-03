import { describe, expect, it } from "vitest";

import { followTitle, guessVolume } from "./bookEdits";
import type { LibraryBook } from "./libraryApi";

const book = (title: string | null, fileName: string, extra: Partial<LibraryBook> = {}) =>
  ({
    id: fileName,
    title,
    author: null,
    fileName,
    importedAt: "2026-11-01T00:00:00Z",
    availability: "available",
    hasCover: false,
    ...extra,
  }) as LibraryBook;

describe("guessVolume", () => {
  it("takes the series number, then the title's, then the file name's, then the place", () => {
    expect(guessVolume(book("Wrong", "x.epub", { series: "Saga", seriesIndex: 4 }), 0)).toBe("4");
    expect(guessVolume(book("Saga 2.5", "x.epub", { series: "Saga", seriesIndex: 2.5 }), 0)).toBe(
      "2.5",
    );
    expect(guessVolume(book("魔法少女 ０３", "x.epub"), 0)).toBe("3");
    expect(guessVolume(book("Saga 7 (2020)", "x.epub"), 0)).toBe("7");
    expect(guessVolume(book("Z_Ver", "Saga 012.epub"), 0)).toBe("12");
    expect(guessVolume(book("月刊 2024", "x.epub"), 0)).toBe("2024");
    expect(guessVolume(book(null, "Nothing.epub"), 5)).toBe("6");
  });
});

describe("followTitle", () => {
  it("puts the volume where the first title has its number, written the same way", () => {
    expect(followTitle("Saga 1", "2")).toBe("Saga 2");
    expect(followTitle("Saga Vol. 01 - Dawn", "12")).toBe("Saga Vol. 12 - Dawn");
    expect(followTitle("Saga 001", "7")).toBe("Saga 007");
    expect(followTitle("鶴子の恩返し　１", "5")).toBe("鶴子の恩返し　５");
    expect(followTitle("Saga 1 (2020)", "3")).toBe("Saga 3 (2020)");
    expect(followTitle("Saga 1", "2.5")).toBe("Saga 2.5");
  });

  it("adds the volume after a space when the first title has no number", () => {
    expect(followTitle("Saga", "2")).toBe("Saga 2");
    expect(followTitle("Saga ", "2")).toBe("Saga 2");
  });
});

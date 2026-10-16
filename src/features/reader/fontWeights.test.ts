import { expect, it } from "vitest";
import { availableFontWeights, resolveFontWeight, standardFontWeights } from "./fontWeights";
import type { DownloadedFont } from "./readerFonts";

const installed = (id: string): DownloadedFont => ({ id, family: "", available: true, url: null });
it("exposes only downloaded static weights and updates after adding or removing faces", () => {
  const choice = { source: "google", id: "zen-old-mincho" } as const;
  expect(availableFontWeights(choice, [])).toEqual([]);
  expect(availableFontWeights(choice, [installed("zen-old-mincho-600")])).toEqual([600]);
  expect(
    availableFontWeights(choice, [
      installed("zen-old-mincho-600"),
      installed("zen-old-mincho-700"),
    ]),
  ).toEqual([600, 700]);
  expect(availableFontWeights(choice, [installed("klee-one-600")])).toEqual([]);
});
it("exposes downloaded variable ranges and retains the system font controls", () => {
  expect(
    availableFontWeights({ source: "google", id: "noto-sans-jp" }, [installed("noto-sans-jp")]),
  ).toEqual(standardFontWeights);
  expect(
    availableFontWeights({ source: "google", id: "noto-serif-jp" }, [installed("noto-serif-jp")]),
  ).toEqual([200, 300, 400, 500, 600, 700, 800, 900]);
  expect(availableFontWeights({ source: "system", family: "Arial" }, [])).toEqual(
    standardFontWeights,
  );
});
it("groups available imported faces by family and respects normal style matching", () => {
  const upload = (
    id: string,
    weight: string,
    style: "normal" | "italic" = "normal",
  ): DownloadedFont => ({ ...installed(id), source: "uploaded", family: "My font", weight, style });
  const choice = { source: "uploaded", id: "a".repeat(64) } as const;
  const normal = upload(choice.id, "600");
  expect(
    availableFontWeights(choice, [
      normal,
      upload("b".repeat(64), "400 700"),
      upload("c".repeat(64), "900", "italic"),
    ]),
  ).toEqual([400, 500, 600, 700]);
  expect(availableFontWeights(choice, [upload("b".repeat(64), "400 700")])).toEqual([]);
});
it("resolves unavailable requested weights without inventing a face", () => {
  expect(resolveFontWeight(400, [600])).toBe(600);
  expect(resolveFontWeight(600, [600, 700])).toBe(600);
  expect(resolveFontWeight(500, [400, 600])).toBe(400);
  expect(resolveFontWeight(800, [700, 900])).toBe(900);
  expect(resolveFontWeight(400, [])).toBe(400);
});

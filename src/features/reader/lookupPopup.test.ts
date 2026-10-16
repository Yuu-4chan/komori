import { describe, expect, it } from "vitest";

import { lookupPopupSize, lookupQuery, placeLookupPopup } from "./lookupPopup";

const area = { left: 0, top: 0, right: 1000, bottom: 800 };
// The placement cases below use this size; the default is checked on its own.
const size = { width: 420, height: 360 };

describe("Reader lookup popup placement", () => {
  it("looks up a selection's trimmed text, at most 256 characters", () => {
    expect(lookupQuery("\n  読む 　")).toBe("読む");
    expect(lookupQuery(" \n ")).toBe("");
    // Characters, not UTF-16 units: a supplementary-plane character counts once.
    const long = `${"𠮷".repeat(255)}読${"書".repeat(10)}`;
    expect([...lookupQuery(long)]).toHaveLength(256);
    expect(lookupQuery(long).endsWith("𠮷読")).toBe(true);
    expect(lookupQuery(`${"読".repeat(255)} 書`)).toBe("読".repeat(255));
  });

  it("shows below horizontal text, else above, moved in from the area's edges", () => {
    const below = placeLookupPopup(
      { left: 100, top: 100, right: 160, bottom: 124 },
      area,
      "horizontal",
      size,
    );
    expect(below).toEqual({ left: 100, top: 134, right: 520, bottom: 494 });
    const above = placeLookupPopup(
      { left: 900, top: 700, right: 960, bottom: 724 },
      area,
      "horizontal",
      size,
    );
    expect(above).toEqual({ left: 572, top: 330, right: 992, bottom: 690 });
    const leftEdge = placeLookupPopup(
      { left: -40, top: 10, right: 20, bottom: 34 },
      area,
      "horizontal",
      size,
    );
    expect(leftEdge.left).toBe(8);
  });

  it("shrinks into the larger side, or lies over a selection with room on neither", () => {
    // 300px below and 232px above: below, shrunk to its room.
    expect(
      placeLookupPopup({ left: 100, top: 250, right: 160, bottom: 482 }, area, "horizontal", size),
    ).toEqual({ left: 100, top: 492, right: 520, bottom: 792 });
    // A selection filling the page leaves no room beside it.
    expect(
      placeLookupPopup({ left: 20, top: 20, right: 980, bottom: 780 }, area, "horizontal", size),
    ).toEqual({ left: 20, top: 432, right: 440, bottom: 792 });
  });

  it("shows before vertical text in its reading order, else after it", () => {
    const line = { left: 500, top: 50, right: 530, bottom: 300 };
    expect(placeLookupPopup(line, area, "vertical-rl", size)).toEqual({
      left: 70,
      top: 50,
      right: 490,
      bottom: 410,
    });
    // Left-to-right vertical lines read on to the right.
    expect(placeLookupPopup(line, area, "vertical-lr", size)).toEqual({
      left: 540,
      top: 50,
      right: 960,
      bottom: 410,
    });
    expect(
      placeLookupPopup({ left: 100, top: 700, right: 130, bottom: 790 }, area, "vertical-rl", size),
    ).toEqual({ left: 140, top: 432, right: 560, bottom: 792 });
  });

  it("is 480 x 440 px when the reading area has room", () => {
    expect(lookupPopupSize).toEqual({ width: 480, height: 440 });
    expect(
      placeLookupPopup({ left: 100, top: 100, right: 160, bottom: 124 }, area, "horizontal"),
    ).toEqual({ left: 100, top: 134, right: 580, bottom: 574 });
  });

  it("fits an area smaller than the popup", () => {
    const small = { left: 300, top: 0, right: 700, bottom: 300 };
    expect(
      placeLookupPopup({ left: 320, top: 20, right: 380, bottom: 44 }, small, "horizontal", size),
    ).toEqual({ left: 308, top: 54, right: 692, bottom: 292 });
  });
});

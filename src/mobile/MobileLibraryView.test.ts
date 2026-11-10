import { describe, expect, it } from "vitest";

import { gridColumns } from "./MobileLibraryView";

describe("the phone Library's grid", () => {
  it("holds three books a row on a phone and more of about their size on wider screens", () => {
    // A phone, a 6" e-reader, a 7.8" one, a 10.3" one upright and on its side.
    expect([376, 548, 650, 912, 1224].map(gridColumns)).toEqual([3, 3, 4, 6, 8]);
    expect(gridColumns(0)).toBe(3);
  });
});

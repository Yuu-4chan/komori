import { describe, expect, it } from "vitest";

import { imageInkShift, inkShift } from "./imageInk";

/** RGBA pixels of a background color with rectangles of ink drawn on it. */
function pixels(
  width: number,
  height: number,
  background: [number, number, number, number],
  ink: Array<{ x: number; y: number; width: number; height: number }>,
  color: [number, number, number, number] = [20, 20, 20, 255],
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = ink.some(
        (box) => x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height,
      );
      data.set(inside ? color : background, (y * width + x) * 4);
    }
  }
  return data;
}

const white: [number, number, number, number] = [255, 255, 255, 255];

describe("heading image ink", () => {
  it("moves a title drawn at the top of a tall strip to its middle", () => {
    // Like a chapter-name strip: the title fills the top half, the rest is blank.
    const data = pixels(10, 100, white, [{ x: 1, y: 2, width: 8, height: 48 }]);
    // Ink rows 2-49 leave 2 rows before and 50 after: move down by 24 of 100 rows.
    expect(inkShift(data, 10, 100)).toEqual({ x: 0, y: 0.24 });
  });

  it("moves content left or up when the blank space comes first", () => {
    const data = pixels(100, 10, white, [{ x: 60, y: 2, width: 36, height: 6 }]);
    expect(inkShift(data, 100, 10)).toEqual({ x: -0.28, y: 0 });
  });

  it("treats near-background noise as background, as in JPEG images", () => {
    const data = pixels(
      10,
      100,
      white,
      [{ x: 0, y: 0, width: 10, height: 50 }],
      [240, 250, 245, 255],
    );
    expect(inkShift(data, 10, 100)).toBeUndefined();
  });

  it("finds content on a transparent or colored background", () => {
    const clear = pixels(10, 100, [0, 0, 0, 0], [{ x: 2, y: 50, width: 6, height: 46 }]);
    expect(inkShift(clear, 10, 100)).toEqual({ x: 0, y: -0.23 });
    const colored = pixels(10, 100, [200, 30, 30, 255], [{ x: 2, y: 4, width: 6, height: 20 }]);
    expect(inkShift(colored, 10, 100)).toEqual({ x: 0, y: 0.36 });
  });

  it("leaves centered, blank, unclear, and unreadable images alone", () => {
    expect(
      inkShift(pixels(10, 100, white, [{ x: 2, y: 20, width: 6, height: 60 }]), 10, 100),
    ).toBeUndefined();
    // Less than 1% off center.
    expect(
      inkShift(pixels(10, 100, white, [{ x: 2, y: 21, width: 6, height: 59 }]), 10, 100),
    ).toBeUndefined();
    expect(inkShift(pixels(10, 100, white, []), 10, 100)).toBeUndefined();
    // Corners of different colors leave no clear background.
    const photo = pixels(10, 100, white, [{ x: 0, y: 50, width: 10, height: 50 }]);
    photo.set([0, 0, 0, 255], 0);
    expect(inkShift(photo, 10, 100)).toBeUndefined();
    expect(inkShift(new Uint8ClampedArray(8), 10, 100)).toBeUndefined();
    expect(inkShift(new Uint8ClampedArray(0), 0, 0)).toBeUndefined();
  });

  it("measures nothing without image decoding", async () => {
    await expect(imageInkShift(new Blob(["image"]))).resolves.toBeUndefined();
  });
});

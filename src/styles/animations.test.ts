import { describe, expect, it } from "vitest";

import animations from "./animations.css?raw";

/** The declarations of the reduced-motion media block. */
function reducedMotionBlock(css: string): string {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index++) {
    if (css[index] === "{") depth++;
    else if (css[index] === "}" && --depth === 0) return css.slice(start, index + 1);
  }
  throw new Error("Unclosed reduced-motion block");
}

describe("reduced motion", () => {
  it("makes transitions instant, so elements without their own resize at once", () => {
    // Every element transitions all properties by default. A positive duration here once
    // made EPUB.js's view heights apply a frame late, so a vertical retreat's page move
    // was clamped short of a short final page.
    const block = reducedMotionBlock(animations);
    const durations = [...block.matchAll(/transition-duration:\s*([^;!]+)/g)].map((match) =>
      match[1].trim(),
    );
    expect(durations).toEqual(["0s"]);
    expect(block).not.toMatch(/transition:/);
  });
});

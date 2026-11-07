import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the app's viewport", () => {
  it("does not zoom with a pinch, so the phone app keeps its size", () => {
    const html = readFileSync("index.html", "utf8");
    const viewport = /name="viewport"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(viewport.split(/,\s*/)).toEqual(
      expect.arrayContaining(["maximum-scale=1.0", "user-scalable=no"]),
    );
  });
});

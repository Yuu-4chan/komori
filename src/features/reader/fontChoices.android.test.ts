import { describe, expect, it, vi } from "vitest";

vi.mock("../../app/platform", () => ({ isAndroid: true }));

const { defaultWesternFont, normalizeFontChoice } = await import("./fontChoices");

describe("fonts on the phone", () => {
  it("reads in the system serif, never in a font only Windows has", () => {
    expect(defaultWesternFont).toEqual({ source: "preset", id: "serif" });
    for (const id of ["georgia", "segoe-ui", "yu-mincho", "yu-gothic"])
      expect(normalizeFontChoice({ source: "preset", id }, undefined)).toBeUndefined();
    expect(normalizeFontChoice({ source: "preset", id: "inter" }, undefined)).toEqual({
      source: "preset",
      id: "inter",
    });
    expect(normalizeFontChoice({ source: "google", id: "noto-serif-jp" }, undefined)).toEqual({
      source: "google",
      id: "noto-serif-jp",
    });
  });
});

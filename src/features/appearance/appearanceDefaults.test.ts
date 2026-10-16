import { describe, expect, it } from "vitest";
import { defaultAppearance, normalizeAppearancePreferences } from "./appearancePreferences";

const chosenDefaults = {
  theme: "hojicha",
  appCustomTheme: {
    base: "light",
    background: "#f1eadf",
    surface: "#fbf7f1",
    text: "#34291f",
  },
  accentColor: "#b8743c",
  librarySort: "title",
  libraryCardLanguage: true,
  libraryCardLastRead: true,
  readerPopupMouseSelection: false,
  readerPopupHoverDelay: 0,
  readerPopupMaxResults: 5,
  readerPopupChildLevels: 5,
  readerTheme: "hojicha",
  readerShowClock: true,
  readerShowChapterPosition: false,
  readerShowChapterPercentage: false,
};

describe("User-chosen install defaults", () => {
  it("uses the chosen values for missing and independently invalid preferences", () => {
    expect(defaultAppearance).toMatchObject(chosenDefaults);
    for (const stored of [
      {},
      Object.fromEntries(Object.keys(chosenDefaults).map((key) => [key, null])),
      Object.fromEntries(Object.keys(chosenDefaults).map((key) => [key, "invalid"])),
    ]) {
      const loaded = normalizeAppearancePreferences({ ...stored, readerFontSize: 23 });
      expect({ ...defaultAppearance, ...loaded }).toMatchObject({
        ...chosenDefaults,
        readerFontSize: 23,
      });
    }
  });

  it("preserves every valid saved former default, including explicit false and zero values", () => {
    const saved = {
      theme: "light",
      appCustomTheme: {
        base: "light",
        background: "#eef2f8",
        surface: "#fbfcfe",
        text: "#162340",
      },
      accentColor: "#5874df",
      librarySort: "recent",
      libraryCardLanguage: false,
      libraryCardLastRead: false,
      readerPopupMouseSelection: true,
      readerPopupHoverDelay: 420,
      readerPopupMaxResults: 32,
      readerPopupChildLevels: 2,
      readerTheme: "paper",
      readerShowClock: false,
      readerShowChapterPosition: true,
      readerShowChapterPercentage: true,
      readerVnTextSpeed: 0,
    };
    expect(normalizeAppearancePreferences(saved)).toEqual(saved);
    expect({ ...defaultAppearance, ...normalizeAppearancePreferences(saved) }).toMatchObject(saved);
  });
});

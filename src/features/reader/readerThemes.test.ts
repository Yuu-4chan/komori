import { describe, expect, it } from "vitest";

import {
  isCustomTheme,
  normalizeCustomThemes,
  readerPresetThemes,
  themeColors,
} from "./readerThemes";

const legacy = {
  id: "0b8a3c2e-4d5f-4a6b-8c7d-9e0f1a2b3c4d",
  name: "Dusk",
  background: "#101820",
  text: "#f0e6d2",
  selection: "#445566",
  footerText: "#a09880",
};

describe("Reader Highlight colors", () => {
  it("uses the presets' Highlight colors without changing Selection", () => {
    const expected = {
      paper: ["#dce8f7", "#cadcfb"],
      sepia: ["#e7d1a8", "#e2c99a"],
      night: ["#475b82", "#3e4e6e"],
      latte: ["#8caaee", "#9ca0b0"],
      frappe: ["#8caaee", "#737994"],
      macchiato: ["#8aadf4", "#6e738d"],
      mocha: ["#89b4fa", "#585b70"],
    };
    for (const theme of readerPresetThemes) {
      expect(theme.highlight).toMatch(/^#[\da-f]{6}$/);
      if (theme.id in expected)
        expect([theme.highlight, theme.selection]).toEqual(
          expected[theme.id as keyof typeof expected],
        );
      expect(themeColors(theme).highlight).toBe(theme.highlight);
    }
  });

  it("backfills only absent saved Highlight values and keeps them independent on later edits", () => {
    const restored = normalizeCustomThemes([legacy])![0];
    expect(restored).toEqual({ ...legacy, highlight: legacy.selection });
    expect(isCustomTheme(legacy)).toBe(false);
    const edited = { ...restored, selection: "#abcdef" };
    expect(normalizeCustomThemes([edited])).toEqual([edited]);
    expect(edited.highlight).toBe(legacy.selection);
    expect(normalizeCustomThemes([{ ...edited, highlight: "#fedcba", css: "body {}" }])).toEqual([
      { ...edited, highlight: "#fedcba" },
    ]);
  });

  it.each([null, undefined, 123, "red", "#12345", "#gggggg", "red; } body {}"])(
    "rejects an invalid explicit Highlight value: %s",
    (highlight) => {
      expect(normalizeCustomThemes([{ ...legacy, highlight }])).toEqual([]);
      expect(isCustomTheme({ ...legacy, highlight })).toBe(false);
    },
  );
});

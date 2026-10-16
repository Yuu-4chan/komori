import { describe, expect, it } from "vitest";

import { normalizeAppearancePreferences } from "./appearancePreferences";
import {
  appPresetThemes,
  appThemeTokens,
  isAppThemeId,
  normalizeAppCustomTheme,
  resolveAppTheme,
} from "./appThemes";

describe("Application themes", () => {
  it("keeps small muted labels readable on preset Library surfaces", () => {
    // Evaluate the actual sRGB token expressions, including the hero's accent tint.
    const color = (value: string): number[] => {
      if (value.startsWith("#")) {
        return [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
      }
      const match = /^color-mix\(in srgb, (#[\da-f]{6}) (\d+)%, (.+)\)$/.exec(value)!;
      const share = Number(match[2]) / 100;
      return color(match[1]).map(
        (channel, index) => channel * share + color(match[3])[index] * (1 - share),
      );
    };
    const luminance = (channels: number[]) =>
      channels
        .map((channel) =>
          channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
        )
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    for (const theme of appPresetThemes) {
      const tokens = appThemeTokens(theme);
      const ink = luminance(color(tokens["--text-muted"]));
      for (const surface of [
        theme.surface,
        tokens["--surface-card"],
        `color-mix(in srgb, ${theme.accent} 9%, ${tokens["--surface-card"]})`,
      ]) {
        const paper = luminance(color(surface));
        const ratio = (Math.max(ink, paper) + 0.05) / (Math.min(ink, paper) + 0.05);
        expect(ratio, `${theme.label} muted label on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("offers light and dark presets and the custom theme", () => {
    expect(appPresetThemes.map((theme) => `${theme.id}:${theme.base}`)).toEqual([
      "light:light",
      "dark:dark",
      "sakura:light",
      "matcha:light",
      "hojicha:light",
      "midnight:dark",
      "ember:dark",
      "forest:dark",
    ]);
    expect(isAppThemeId("custom")).toBe(true);
    expect(isAppThemeId("neon")).toBe(false);
  });

  it("resolves a preset, the custom colors, or Hojicha for an unknown ID", () => {
    const custom = {
      base: "dark" as const,
      background: "#000000",
      surface: "#111111",
      text: "#eeeeee",
    };
    expect(resolveAppTheme("custom", custom)).toBe(custom);
    expect(resolveAppTheme("sakura", custom).surface).toBe("#fdf9f7");
    expect(resolveAppTheme("gone", custom)).toEqual(resolveAppTheme("hojicha", custom));
  });

  it("derives every surface token from a theme's colors", () => {
    const tokens = appThemeTokens(
      resolveAppTheme("midnight", resolveAppTheme("light", {} as never)),
    );
    expect(tokens["--surface-app"]).toBe("#111219");
    expect(tokens["--surface-main"]).toBe("#181a24");
    expect(tokens["--text-primary"]).toBe("#c9d1f2");
    expect(Object.keys(tokens)).toEqual([
      "--surface-app",
      "--surface-sidebar",
      "--surface-main",
      "--surface-card",
      "--surface-subtle",
      "--surface-raised",
      "--text-primary",
      "--text-secondary",
      "--text-muted",
      "--border-soft",
      "--border-medium",
    ]);
  });

  it("keeps a saved custom theme only when every color is valid", () => {
    expect(
      normalizeAppCustomTheme({
        base: "dark",
        background: "#ABCDEF",
        surface: "#111111",
        text: "#eeeeee",
      }),
    ).toEqual({ base: "dark", background: "#abcdef", surface: "#111111", text: "#eeeeee" });
    expect(
      normalizeAppCustomTheme({
        base: "sepia",
        background: "#abcdef",
        surface: "#111111",
        text: "#eeeeee",
      }),
    ).toBeUndefined();
    expect(
      normalizeAppCustomTheme({
        base: "dark",
        background: "red",
        surface: "#111111",
        text: "#eeeeee",
      }),
    ).toBeUndefined();
  });

  it("loads each valid app theme and Library choice on its own", () => {
    expect(
      normalizeAppearancePreferences({
        theme: "forest",
        appCustomTheme: {
          base: "light",
          background: "#f0f0f0",
          surface: "#ffffff",
          text: "#101010",
        },
        libraryView: "list",
        librarySort: "author",
        librarySortReversed: true,
        libraryFilter: "reading",
        libraryCardSeries: "yes",
        libraryCardLastRead: true,
      }),
    ).toEqual({
      theme: "forest",
      appCustomTheme: { base: "light", background: "#f0f0f0", surface: "#ffffff", text: "#101010" },
      libraryView: "list",
      librarySortReversed: true,
      libraryFilter: "reading",
      libraryCardLastRead: true,
    });
  });
});

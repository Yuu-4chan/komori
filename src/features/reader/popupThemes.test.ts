import { describe, expect, it } from "vitest";

import { defaultPopupPalette, popupThemeStyle } from "./popupThemes";
import { readerPresetThemes } from "./readerThemes";

/** Resolve the literal colors and bounded sRGB mixes used by popup tokens. */
function color(value: string): number[] {
  const hex = /^#[\da-f]{6}$/i.exec(value);
  if (hex) return [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16) / 255);
  const mix = /^color-mix\(in srgb, (#[\da-f]{6}) (\d+)%, (#[\da-f]{6})\)$/i.exec(value);
  if (!mix) throw new Error(`Unexpected color: ${value}`);
  const share = Number(mix[2]) / 100;
  const other = color(mix[3]);
  return color(mix[1]).map((channel, index) => channel * share + other[index] * (1 - share));
}

function luminance(channels: number[]) {
  return channels
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(first: string, second: string) {
  const values = [luminance(color(first)), luminance(color(second))].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("popup preset readability", () => {
  it("keeps custom semantic ink readable even with conflicting surfaces and low-contrast colors", () => {
    for (const background of ["#000000", "#ffffff", "#777777", "#ff0000", "#00ff00", "#0000ff"]) {
      for (const tag of ["#000000", "#ffffff", "#777777", "#ff00ff"]) {
        const tokens = popupThemeStyle("custom", {
          ...defaultPopupPalette,
          background,
          tag,
          text: background,
          accent: background,
        }) as Record<string, string>;
        expect(tokens["--surface-card"]).toBe(background);
        expect(tokens["--accent-base"]).toBe(background);
        for (const foreground of [
          "--text-primary",
          "--text-secondary",
          "--text-muted",
          "--accent-ink",
        ]) {
          for (const surface of ["--surface-card", "--surface-subtle", "--popup-tag"])
            expect(
              contrast(tokens[foreground], tokens[surface]),
              `${foreground} on ${surface}: ${background}, ${tag}`,
            ).toBeGreaterThanOrEqual(4.5);
        }
        for (const category of [
          "name",
          "expression",
          "popular",
          "frequent",
          "archaism",
          "dictionary",
          "frequency",
          "part-of-speech",
          "search",
          "pronunciation-dictionary",
        ])
          expect(contrast(tokens[`--tag-${category}`], background)).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(tokens["--text-on-accent"], tokens["--accent-action"]),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it.each(["classic", "paper", "night"] as const)(
    "keeps %s text readable on its own surfaces",
    (theme) => {
      const tokens = popupThemeStyle(theme) as Record<string, string>;
      for (const foreground of [
        "--text-primary",
        "--text-secondary",
        "--text-muted",
        "--accent-ink",
      ]) {
        for (const background of ["--surface-card", "--surface-subtle", "--popup-tag"]) {
          expect(
            contrast(tokens[foreground], tokens[background]),
            `${foreground} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(
        contrast(tokens["--text-on-accent"], tokens["--accent-action"]),
      ).toBeGreaterThanOrEqual(4.5);
      // Root theme/accent substitutions must not enter these scoped color expressions.
      expect(Object.values(tokens).some((value) => value.includes("var("))).toBe(false);
    },
  );

  it("keeps Application's existing inherited palette", () => {
    expect(popupThemeStyle("application")).toEqual({});
  });

  it.each(readerPresetThemes.map((theme) => [theme.id, theme] as const))(
    "follows the %s reader theme's page, readably",
    (_id, page) => {
      const tokens = popupThemeStyle("reader", undefined, page) as Record<string, string>;
      expect(tokens["--surface-card"]).toBe(page.background);
      expect(tokens["--accent-base"]).toBe(page.highlight);
      const dark = luminance(color(page.background)) < 0.2;
      expect(tokens.colorScheme).toBe(dark ? "dark" : "light");
      for (const foreground of ["--text-primary", "--text-secondary", "--accent-ink"])
        for (const surface of ["--surface-card", "--popup-tag"])
          expect(contrast(tokens[foreground], tokens[surface])).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("inherits the application palette while no reader theme is known", () => {
    expect(popupThemeStyle("reader")).toEqual({});
  });
});

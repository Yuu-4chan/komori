import type { CSSProperties } from "react";

/** Keep the IDs in step with native appearance validation. */
export type ReaderPopupTheme = "application" | "classic" | "paper" | "night" | "custom";

export interface ReaderPopupPalette {
  background: string;
  text: string;
  accent: string;
  border: string;
  tag: string;
}

export const popupPaletteFields = ["background", "text", "accent", "border", "tag"] as const;

/** All five colors must be valid; extra properties never become CSS. */
export function normalizePopupPalette(value: unknown): ReaderPopupPalette | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    !popupPaletteFields.every(
      (key) => typeof record[key] === "string" && /^#[\da-f]{6}$/i.test(record[key]),
    )
  )
    return undefined;
  return Object.fromEntries(
    popupPaletteFields.map((key) => [key, (record[key] as string).toLowerCase()]),
  ) as unknown as ReaderPopupPalette;
}

export const popupThemes = [
  {
    id: "application",
    label: "popupTheme.application",
    description: "popupTheme.applicationHint",
  },
  { id: "classic", label: "popupTheme.classic", description: "popupTheme.classicHint" },
  { id: "paper", label: "popupTheme.paper", description: "popupTheme.paperHint" },
  { id: "night", label: "popupTheme.night", description: "popupTheme.nightHint" },
  { id: "custom", label: "popupTheme.custom", description: "popupTheme.customHint" },
] as const;

export const isReaderPopupTheme = (value: unknown): value is ReaderPopupTheme =>
  popupThemes.some((theme) => theme.id === value);

/** The presets' five-color popup palettes. */
const palettes = {
  classic: {
    background: "#fff7f1",
    text: "#1f2433",
    accent: "#f48370",
    border: "#ead7cb",
    tag: "#fff0ea",
  },
  paper: {
    background: "#fffdf8",
    text: "#2a2e3a",
    accent: "#f0a25d",
    border: "#e6ddd0",
    tag: "#f6efe3",
  },
  night: {
    background: "#15192a",
    text: "#eef1ff",
    accent: "#7b90ff",
    border: "#313753",
    tag: "#222844",
  },
} as const;

export const defaultPopupPalette: ReaderPopupPalette = { ...palettes.classic };

const rgb = (hex: string) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
const luminance = (hex: string) =>
  rgb(hex).reduce((sum, byte, index) => {
    const channel = byte / 255;
    return (
      sum +
      (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) *
        [0.2126, 0.7152, 0.0722][index]
    );
  }, 0);
const contrast = (first: string, second: string) => {
  const a = luminance(first),
    b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const mixColor = (first: string, second: string, share: number) => {
  const other = rgb(second);
  return (
    "#" +
    rgb(first)
      .map((byte, index) =>
        Math.round(byte * (1 - share) + other[index] * share)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
};

/** Keep the chosen color when readable, otherwise mix only as far as needed. */
function readable(color: string, anchor: string, surfaces: string[]): string {
  for (let step = 0; step <= 100; step++) {
    const candidate = mixColor(color, anchor, step / 100);
    if (surfaces.every((surface) => contrast(candidate, surface) >= 4.5)) return candidate;
  }
  return anchor;
}

function customPaletteStyle(palette: ReaderPopupPalette): CSSProperties {
  const { background, accent, border } = palette;
  const anchor =
    contrast("#000000", background) >= contrast("#ffffff", background) ? "#000000" : "#ffffff";
  // Opposing background/tag colors cannot share readable ink. Bring only the tag surface
  // toward the background until the background's anchor is readable on both.
  const tag = readableSurface(palette.tag, background, anchor);
  const surfaces = [background, tag];
  const text = readable(palette.text, anchor, surfaces);
  const ink = readable(accent, anchor, surfaces);
  const action = readable(accent, "#000000", ["#ffffff"]);
  const tokens: Record<string, string> = {
    "--surface-main": background,
    "--surface-card": background,
    "--surface-subtle": tag,
    "--surface-raised": tag,
    "--surface-selected": tag,
    "--text-primary": text,
    "--text-secondary": readable(mixColor(text, background, 0.26), anchor, surfaces),
    "--text-muted": readable(mixColor(text, background, 0.28), anchor, surfaces),
    "--text-on-accent": "#ffffff",
    "--accent-base": accent,
    "--accent-ink": ink,
    "--accent-strong": ink,
    "--accent-action": action,
    "--accent-action-hover": action,
    "--accent-hover": action,
    "--accent-soft": tag,
    "--accent-faint": tag,
    "--border-soft": border,
    "--border-medium": border,
    "--border-accent": mixColor(border, accent, 0.38),
    "--popup-tag": tag,
    "--tag-ink-share": "100%",
    "--tag-tint-share": "0%",
    "--tag-ink-toward": anchor,
  };
  // Preserve category hues with readable ink on the popup background. Keep base colors
  // in step with the category tokens in styles/tokens.css.
  const categories = {
    name: "#5cb85c",
    expression: "#f0ad4e",
    popular: "#0275d8",
    frequent: "#5bc0de",
    archaism: "#d9534f",
    dictionary: "#aa66cc",
    frequency: "#5cb85c",
    "part-of-speech": "#565656",
    search: "#8a8a91",
    "pronunciation-dictionary": "#6640be",
  };
  for (const [name, color] of Object.entries(categories))
    tokens[`--tag-${name}`] = readable(color, anchor, [background]);
  return { ...tokens, colorScheme: anchor === "#ffffff" ? "dark" : "light" } as CSSProperties;
}

function readableSurface(tag: string, background: string, anchor: string): string {
  for (let step = 0; step <= 100; step++) {
    const candidate = mixColor(tag, background, step / 100);
    if (contrast(anchor, candidate) >= 4.5) return candidate;
  }
  return background;
}

/** Scoped to a popup or its preview. Application inherits the existing tokens unchanged.
 * Set derived tokens here too: inherited root tokens have already resolved their variables.
 */
export function popupThemeStyle(
  theme: ReaderPopupTheme,
  custom: ReaderPopupPalette = defaultPopupPalette,
): CSSProperties {
  if (theme === "application") return {};
  if (theme === "custom") return customPaletteStyle(custom);
  const { background, text, accent, border, tag } = palettes[theme];
  const dark = theme === "night";
  const ink = `color-mix(in srgb, ${accent} ${dark ? 64 : 45}%, ${text})`;
  const action = `color-mix(in srgb, ${accent} ${dark ? 70 : 62}%, ${dark ? "#05060a" : "#0c1020"})`;
  const actionHover = `color-mix(in srgb, ${accent} ${dark ? 60 : 50}%, ${dark ? "#05060a" : "#0c1020"})`;
  return {
    colorScheme: dark ? "dark" : "light",
    "--surface-main": background,
    "--surface-card": background,
    "--surface-subtle": tag,
    "--surface-raised": tag,
    "--surface-selected": tag,
    "--text-primary": text,
    "--text-secondary": `color-mix(in srgb, ${text} 74%, ${background})`,
    "--text-muted": `color-mix(in srgb, ${text} 72%, ${background})`,
    "--text-on-accent": "#ffffff",
    "--accent-base": accent,
    "--accent-ink": ink,
    "--accent-strong": ink,
    "--accent-action": action,
    "--accent-action-hover": actionHover,
    "--accent-hover": actionHover,
    "--accent-soft": tag,
    "--accent-faint": tag,
    "--border-soft": border,
    "--border-medium": border,
    "--border-accent": `color-mix(in srgb, ${accent} 38%, ${border})`,
    "--tag-ink-toward": dark ? "#ffffff" : "#0f1a3d",
    "--tag-ink-share": dark ? "45%" : "50%",
    "--tag-tint-share": dark ? "22%" : "16%",
    "--popup-tag": tag,
  } as CSSProperties;
}

/**
 * Application themes: the colors of Komori's own surfaces (sidebar, pages, cards, popups),
 * separate from the Reader themes that color a book. Each preset is a light or dark base
 * and a few colors; every other surface token is derived from them, so the custom theme
 * the reader edits works exactly like a preset. Keep the IDs in step with
 * `src-tauri/src/appearance_preferences.rs`.
 */
import type { MessageKey } from "../../i18n/i18n";

export type AppThemeBase = "light" | "dark";

export type AppPresetThemeId =
  "light" | "dark" | "sakura" | "matcha" | "hojicha" | "midnight" | "ember" | "forest";

export type AppThemeId = AppPresetThemeId | "custom";

/** The colors a theme is made of, each `#rrggbb`. */
export interface AppThemeColors {
  base: AppThemeBase;
  /** Behind everything: the window and the sidebar. */
  background: string;
  /** The page content area. */
  surface: string;
  text: string;
}

export interface AppPresetTheme extends AppThemeColors {
  id: AppPresetThemeId;
  label: MessageKey;
  /** The accent the theme is designed around; choosing the theme applies it. */
  accent: string;
}

export const appPresetThemes: readonly AppPresetTheme[] = [
  {
    id: "light",
    label: "appTheme.light",
    base: "light",
    background: "#eef2f8",
    surface: "#fbfcfe",
    text: "#162340",
    accent: "#5874df",
  },
  {
    id: "dark",
    label: "appTheme.dark",
    base: "dark",
    background: "#15161e",
    surface: "#1b1c26",
    text: "#e6e8f2",
    accent: "#7b93f0",
  },
  {
    id: "sakura",
    label: "appTheme.sakura",
    base: "light",
    background: "#f7efed",
    surface: "#fdf9f7",
    text: "#3b2429",
    accent: "#e0606b",
  },
  {
    id: "matcha",
    label: "appTheme.matcha",
    base: "light",
    background: "#edf1e7",
    surface: "#f9fbf6",
    text: "#1e2b20",
    accent: "#4f9a62",
  },
  {
    id: "hojicha",
    label: "appTheme.hojicha",
    base: "light",
    background: "#f1eadf",
    surface: "#fbf7f1",
    text: "#34291f",
    accent: "#b8743c",
  },
  {
    id: "midnight",
    label: "appTheme.midnight",
    base: "dark",
    background: "#111219",
    surface: "#181a24",
    text: "#c9d1f2",
    accent: "#7aa2f7",
  },
  {
    id: "ember",
    label: "appTheme.ember",
    base: "dark",
    background: "#171311",
    surface: "#1f1a17",
    text: "#f0e5db",
    accent: "#e58b5c",
  },
  {
    id: "forest",
    label: "appTheme.forest",
    base: "dark",
    background: "#0f1714",
    surface: "#151f1b",
    text: "#dbe9e1",
    accent: "#5bbd8b",
  },
];

export const defaultAppTheme: AppPresetThemeId = "hojicha";

/** The custom theme until the reader edits it: Hojicha's colors. */
export const defaultAppCustomTheme: AppThemeColors = {
  base: "light",
  background: "#f1eadf",
  surface: "#fbf7f1",
  text: "#34291f",
};

const presetById = new Map<string, AppPresetTheme>(
  appPresetThemes.map((theme) => [theme.id, theme]),
);

const isHexColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[\da-f]{6}$/i.test(value);

const isAppThemeBase = (value: unknown): value is AppThemeBase =>
  value === "light" || value === "dark";

export const isAppThemeId = (value: unknown): value is AppThemeId =>
  value === "custom" || (typeof value === "string" && presetById.has(value));

/** A saved custom theme's valid colors, lowercase, or undefined when any is invalid. */
export function normalizeAppCustomTheme(value: unknown): AppThemeColors | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { base, background, surface, text } = value as Record<string, unknown>;
  if (!isAppThemeBase(base) || !isHexColor(background) || !isHexColor(surface)) return undefined;
  if (!isHexColor(text)) return undefined;
  return {
    base,
    background: background.toLowerCase(),
    surface: surface.toLowerCase(),
    text: text.toLowerCase(),
  };
}

/** The colors the chosen theme shows. */
/** The accent the app shows: a preset's own, or the custom theme's saved accent. */
export function resolveAppAccent(id: string, customAccent: string): string {
  if (id === "custom") return customAccent;
  return (presetById.get(id) ?? presetById.get(defaultAppTheme)!).accent;
}

export function resolveAppTheme(id: string, custom: AppThemeColors): AppThemeColors {
  if (id === "custom") return custom;
  const { base, background, surface, text } =
    presetById.get(id) ?? presetById.get(defaultAppTheme)!;
  return { base, background, surface, text };
}

const mix = (first: string, share: number, second: string) =>
  `color-mix(in srgb, ${first} ${share}%, ${second})`;

/**
 * Every derived surface token for a theme. Cards lift toward white in light themes and
 * toward the text color in dark ones; borders and secondary text are the text color
 * softened into the surface, so any custom colors stay coherent.
 */
export function appThemeTokens(colors: AppThemeColors): Record<string, string> {
  const { base, background, surface, text } = colors;
  const light = base === "light";
  const card = light ? mix(surface, 45, "#ffffff") : mix(text, 5, surface);
  return {
    "--surface-app": background,
    "--surface-sidebar": background,
    "--surface-main": surface,
    "--surface-card": card,
    "--surface-subtle": light ? mix(background, 55, surface) : mix(text, 3, surface),
    "--surface-raised": light ? "#ffffff" : mix(text, 8, surface),
    "--text-primary": text,
    "--text-secondary": mix(text, 74, surface),
    "--text-muted": mix(text, 68, surface),
    "--border-soft": mix(text, light ? 9 : 10, surface),
    "--border-medium": mix(text, light ? 15 : 16, surface),
  };
}

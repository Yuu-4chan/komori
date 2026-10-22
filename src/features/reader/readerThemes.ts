import { i18n, type MessageKey } from "../../i18n/i18n";
/**
 * Reader themes: the colors of the book surface, separate from the application's own
 * light and dark theme. The presets, plus custom themes the reader creates,
 * names, and keeps. Keep the validation in step with
 * `src-tauri/src/appearance_preferences.rs`.
 */

export type ReaderPresetThemeId =
  | "paper"
  | "sepia"
  | "night"
  | "sakura"
  | "matcha"
  | "hojicha"
  | "solarized"
  | "nord"
  | "gruvbox"
  | "rose-pine"
  | "tokyo-night"
  | "latte"
  | "frappe"
  | "macchiato"
  | "mocha";

/** The colors a theme gives the book surface, each `#rrggbb`. */
export interface ReaderThemeColors {
  background: string;
  text: string;
  /** Behind text selected in the book, and behind the text a pointer lookup matched. */
  selection: string;
  /** Behind saved passages, independent of Selection. */
  highlight: string;
  /** The footer's progress text. */
  footerText: string;
}

export interface ReaderPresetTheme extends ReaderThemeColors {
  id: ReaderPresetThemeId;
  label: string;
}

/** A theme the reader created: a name and its colors, never CSS. */
export interface ReaderCustomTheme extends ReaderThemeColors {
  /** A lowercase UUID, which no preset ID can be. */
  id: string;
  name: string;
}

/** The most custom themes kept. */
export const readerCustomThemeLimit = 32;
/** The longest custom theme name, in characters. */
export const readerThemeNameMaxLength = 40;

export const defaultReaderTheme: ReaderPresetThemeId = "hojicha";

/** Mixes two `#rrggbb` colors, `share` of the first. */
function mixColors(first: string, second: string, share: number): string {
  const channel = (color: string, index: number) =>
    Number.parseInt(color.slice(1 + index * 2, 3 + index * 2), 16);
  return `#${[0, 1, 2]
    .map((index) =>
      Math.round(channel(first, index) * share + channel(second, index) * (1 - share))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** A preset's colors; the footer text is the text softened toward the page. */
function preset(
  id: ReaderPresetThemeId,
  label: string,
  background: string,
  text: string,
  selection: string,
  highlight: string = selection,
): ReaderPresetTheme {
  return {
    id,
    label,
    background,
    text,
    selection,
    highlight,
    footerText: mixColors(text, background, 0.62),
  };
}

export const readerPresetThemes: readonly ReaderPresetTheme[] = [
  preset("paper", "Paper", "#fbfaf6", "#26292e", "#cadcfb", "#dce8f7"),
  preset("sepia", "Sepia", "#f4ecd8", "#5b4636", "#e2c99a", "#e7d1a8"),
  preset("night", "Night", "#16181d", "#d9dce3", "#3e4e6e", "#475b82"),
  preset("sakura", "Sakura", "#fdf3f4", "#4a2c34", "#f5c6d1"),
  preset("matcha", "Matcha", "#eef3e5", "#2d3a27", "#c8dcad"),
  preset("hojicha", "Hojicha", "#ebdfcb", "#3e2f22", "#d4b98e"),
  preset("solarized", "Solarized", "#fdf6e3", "#586e75", "#e6ddc0"),
  preset("nord", "Nord", "#2e3440", "#d8dee9", "#4c566a"),
  preset("gruvbox", "Gruvbox", "#282828", "#ebdbb2", "#504945"),
  preset("rose-pine", "Rosé Pine", "#191724", "#e0def4", "#403d52"),
  preset("tokyo-night", "Tokyo Night", "#1a1b26", "#c0caf5", "#33467c"),
  preset("latte", "Latte", "#eff1f5", "#4c4f69", "#9ca0b0", "#8caaee"),
  preset("frappe", "Frappé", "#303446", "#c6d0f5", "#737994", "#8caaee"),
  preset("macchiato", "Macchiato", "#24273a", "#cad3f5", "#6e738d", "#8aadf4"),
  preset("mocha", "Mocha", "#1e1e2e", "#cdd6f4", "#585b70", "#89b4fa"),
];

const presetById = new Map<string, ReaderPresetTheme>(
  readerPresetThemes.map((theme) => [theme.id, theme]),
);

export const isThemeColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[\da-f]{6}$/i.test(value);

/** A name of 1–40 characters with no surrounding space and no control characters. */
export function isThemeName(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.trim() !== value) return false;
  return [...value].length <= readerThemeNameMaxLength && !/\p{Cc}/u.test(value);
}

export const isCustomThemeId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(value);

export const isPresetThemeId = (value: unknown): value is ReaderPresetThemeId =>
  typeof value === "string" && presetById.has(value);

/** A preset's ID or one a custom theme could have. */
export const isReaderThemeId = (value: unknown): value is string =>
  isPresetThemeId(value) || isCustomThemeId(value);

export function isCustomTheme(value: unknown): value is ReaderCustomTheme {
  if (!value || typeof value !== "object") return false;
  const theme = value as Record<string, unknown>;
  return (
    isCustomThemeId(theme.id) &&
    isThemeName(theme.name) &&
    isThemeColor(theme.background) &&
    isThemeColor(theme.text) &&
    isThemeColor(theme.selection) &&
    isThemeColor(theme.highlight) &&
    isThemeColor(theme.footerText)
  );
}

/**
 * The valid custom themes of a saved list, each once and at most the limit, or
 * undefined for anything but a list.
 */
export function normalizeCustomThemes(value: unknown): ReaderCustomTheme[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  const themes: ReaderCustomTheme[] = [];
  for (const stored of value) {
    if (themes.length === readerCustomThemeLimit) break;
    // Older saved themes had no Highlight and took Selection for it. Only an absent
    // Highlight gets that compatibility value; an invalid new value is rejected.
    const theme =
      stored && typeof stored === "object" && !Object.hasOwn(stored, "highlight")
        ? { ...stored, highlight: stored.selection }
        : stored;
    if (!isCustomTheme(theme) || ids.has(theme.id)) continue;
    ids.add(theme.id);
    const { id, name, background, text, selection, highlight, footerText } = theme;
    themes.push({ id, name, background, text, selection, highlight, footerText });
  }
  return themes;
}

/** The theme with this ID, or Paper when there is none. */
export function resolveReaderTheme(
  id: string,
  customThemes: readonly ReaderCustomTheme[],
): ReaderPresetTheme | ReaderCustomTheme {
  return (
    presetById.get(id) ??
    customThemes.find((theme) => theme.id === id) ??
    presetById.get(defaultReaderTheme)!
  );
}

/** Just the colors of a theme. */
export function themeColors(theme: ReaderThemeColors): ReaderThemeColors {
  const { background, text, selection, highlight, footerText } = theme;
  return { background, text, selection, highlight, footerText };
}

/** "Custom 1", or the first such name no other theme has. */
export function newCustomThemeName(customThemes: readonly ReaderCustomTheme[]): string {
  const names = new Set(customThemes.map((theme) => theme.name));
  const name = (number: number) => i18n().t("readerTheme.customName", { number: String(number) });
  let number = 1;
  while (names.has(name(number))) number += 1;
  return name(number);
}

const translatedPresets: Partial<Record<ReaderPresetThemeId, MessageKey>> = {
  paper: "readerTheme.paper",
  sepia: "readerTheme.sepia",
  night: "readerTheme.night",
  sakura: "readerTheme.sakura",
  matcha: "readerTheme.matcha",
  hojicha: "readerTheme.hojicha",
};

/** A preset's name in the interface language; named palettes such as Nord keep their names. */
export function presetThemeLabel(theme: ReaderPresetTheme): string {
  const key = translatedPresets[theme.id];
  return key ? i18n().t(key) : theme.label;
}

/** A random version 4 UUID, without needing a secure context. */
export function newCustomThemeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

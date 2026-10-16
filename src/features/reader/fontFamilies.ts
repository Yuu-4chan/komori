import interFontUrl from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";

// Stable IDs cross the native boundary; only these owned names can become CSS.
export const readerSerifFonts = [
  { value: "yu-mincho", label: "Yu Mincho", family: '"Yu Mincho"' },
  { value: "noto-serif-jp", label: "Noto Serif JP", family: '"Noto Serif JP"' },
  { value: "noto-serif-sc", label: "Noto Serif SC", family: '"Noto Serif SC"' },
  { value: "noto-serif-kr", label: "Noto Serif KR", family: '"Noto Serif KR"' },
  { value: "georgia", label: "Georgia", family: '"Georgia"' },
  { value: "serif", label: "System serif", family: "serif" },
] as const;

export const readerSansFonts = [
  { value: "segoe-ui", label: "Segoe UI", family: '"Segoe UI"' },
  { value: "yu-gothic", label: "Yu Gothic", family: '"Yu Gothic"' },
  { value: "noto-sans-jp", label: "Noto Sans JP", family: '"Noto Sans JP"' },
  { value: "noto-sans-sc", label: "Noto Sans SC", family: '"Noto Sans SC"' },
  { value: "noto-sans-kr", label: "Noto Sans KR", family: '"Noto Sans KR"' },
  { value: "inter", label: "Inter (included, Latin)", family: '"Komori Reader Inter"' },
  { value: "sans-serif", label: "System sans serif", family: "sans-serif" },
] as const;

export type ReaderSerifFont = (typeof readerSerifFonts)[number]["value"];
export type ReaderSansFont = (typeof readerSansFonts)[number]["value"];
export const defaultReaderSerifFont: ReaderSerifFont = "yu-mincho";
export const defaultReaderSansFont: ReaderSansFont = "segoe-ui";

export const isReaderSerifFont = (value: unknown): value is ReaderSerifFont =>
  readerSerifFonts.some((font) => font.value === value);
export const isReaderSansFont = (value: unknown): value is ReaderSansFont =>
  readerSansFonts.some((font) => font.value === value);

/** CSS fallback is per glyph: Group 1, Group 2, then the system's serif fallback. */
export function readerFontStack(group1?: ReaderSerifFont, group2?: ReaderSansFont): string {
  const families = [
    readerSerifFonts.find((font) => font.value === group1)?.family,
    readerSansFonts.find((font) => font.value === group2)?.family,
    "serif",
  ].filter((family): family is string => !!family);
  return [...new Set(families)].join(", ");
}

export const readerInterFace =
  `@font-face { font-family: "Komori Reader Inter"; src: url("${new URL(interFontUrl, import.meta.url).href}") ` +
  `format("woff2"); font-style: normal; font-weight: 100 900; font-display: block; }`;

export type FontAvailability = "available" | "unavailable" | "unknown";

/** Probe only allowlisted local fonts. No enumeration, downloads or font installation. */
export async function readerFontAvailability(value: string): Promise<FontAvailability> {
  if (["serif", "sans-serif", "inter"].includes(value)) return "available";
  const font = [...readerSerifFonts, ...readerSansFonts].find((font) => font.value === value);
  if (!font || typeof FontFace === "undefined") return "unknown";
  try {
    await new FontFace("KomoriFontProbe", `local(${font.family})`).load();
    return "available";
  } catch {
    return "unavailable";
  }
}

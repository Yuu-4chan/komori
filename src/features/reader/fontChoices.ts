import { i18n, type MessageKey } from "../../i18n/i18n";
import { readerSerifFonts, readerSansFonts, readerInterFace } from "./fontFamilies";
import catalog from "./googleFontCatalog.json";

export const presetFonts = [...readerSerifFonts, ...readerSansFonts];
export type FontCategory = "asian" | "western";
/** The presets each font menu offers, in its order; the generic families are in both. */
export const presetCategories: Record<FontCategory, readonly string[]> = {
  asian: [
    "yu-mincho",
    "yu-gothic",
    "noto-serif-jp",
    "noto-sans-jp",
    "noto-serif-sc",
    "noto-sans-sc",
    "noto-serif-kr",
    "noto-sans-kr",
    "serif",
    "sans-serif",
  ],
  western: ["georgia", "segoe-ui", "inter", "serif", "sans-serif"],
};
export const googleFontFiles: {
  id: string;
  familyId: string;
  family: string;
  category: string;
  weight: string;
  path: string;
  hash: string;
  licenseHash: string;
  size: number;
  bundled?: boolean;
}[] = catalog.fonts;
export const googleFonts = [...new Set(googleFontFiles.map((f) => f.familyId))].map((id) => {
  const files = googleFontFiles.filter((f) => f.familyId === id);
  return { id, family: files[0].family, category: files[0].category as FontCategory, files };
});
export const validUploadedId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-f0-9]{64}$/.test(id);
export interface UploadedFont {
  id: string;
  family: string;
  weight: string;
  style: "normal" | "italic";
}
const validFontWeight = (weight: unknown): weight is string =>
  typeof weight === "string" &&
  /^(?:[1-9]\d{0,2}|1000)(?: (?:[1-9]\d{0,2}|1000))?$/.test(weight) &&
  weight.split(" ").every((w, i, ws) => i === 0 || Number(w) >= Number(ws[0]));
export const validUploadedFont = (value: unknown): value is UploadedFont => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const font = value as UploadedFont;
  return (
    validUploadedId(font.id) &&
    validFontFamily(font.family) &&
    validFontWeight(font.weight) &&
    ["normal", "italic"].includes(font.style)
  );
};
export type ReaderFontChoice =
  | { source: "preset"; id: string }
  | { source: "system"; family: string }
  | { source: "uploaded"; id: string }
  | { source: "google"; id: string };
export type ReaderFontPair = {
  asian: ReaderFontChoice;
  western: ReaderFontChoice;
  downloaded: string[];
  uploaded?: UploadedFont[];
  weights?: { western: number; asian: number };
  systemFaces?: SystemFontFace[];
};
export interface SystemFontFace {
  family: string;
  name: string;
  weight: number;
  style: "normal" | "italic";
}
/** Noto Sans JP comes with Komori, and Georgia with Windows. */
export const defaultAsianFont: ReaderFontChoice = { source: "google", id: "noto-sans-jp" };
export const defaultWesternFont: ReaderFontChoice = { source: "preset", id: "georgia" };

export function validFontFamily(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    [...value].length <= 128 &&
    [...value].every((char) => {
      const code = char.codePointAt(0)!;
      return code >= 32 && (code < 127 || code > 159);
    }) &&
    !/[\\/:;{}<>"'(),@]/u.test(value)
  );
}
export function isReaderFontChoice(value: unknown): value is ReaderFontChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (Object.keys(c).length !== 2) return false;
  if (c.source === "system") return validFontFamily(c.family);
  if (c.source === "uploaded") return validUploadedId(c.id);
  if (c.source === "preset") return presetFonts.some((f) => f.value === c.id);
  return c.source === "google" && googleFonts.some((f) => f.id === c.id);
}
export function normalizeFontChoice(value: unknown, legacy: unknown): ReaderFontChoice | undefined {
  if (value !== undefined) return isReaderFontChoice(value) ? value : undefined;
  return presetFonts.some((f) => f.value === legacy)
    ? { source: "preset", id: legacy as string }
    : undefined;
}
export const fontChoiceKey = (font: ReaderFontChoice) =>
  font.source === "system" ? `system:${font.family}` : `${font.source}:${font.id}`;
const describedPresets: Record<string, MessageKey> = {
  serif: "fonts.systemSerif",
  "sans-serif": "fonts.systemSans",
  inter: "fonts.inter",
};

/** A preset's name as the menu shows it; generic and bundled choices are described. */
export const presetFontLabel = (id: string) =>
  describedPresets[id]
    ? i18n().t(describedPresets[id])
    : presetFonts.find((f) => f.value === id)!.label;

export const fontChoiceLabel = (font: ReaderFontChoice, uploaded: UploadedFont[] = []) =>
  font.source === "system"
    ? font.family
    : font.source === "uploaded"
      ? (uploaded.find((f) => f.id === font.id)?.family ?? i18n().t("fonts.uploadedMissing"))
      : font.source === "google"
        ? googleFonts.find((f) => f.id === font.id)!.family
        : presetFontLabel(font.id);
export const sameFontPair = (a?: ReaderFontPair, b?: ReaderFontPair) =>
  a === b ||
  (!!a &&
    !!b &&
    fontChoiceKey(a.asian) === fontChoiceKey(b.asian) &&
    fontChoiceKey(a.western) === fontChoiceKey(b.western) &&
    a.weights?.western === b.weights?.western &&
    a.weights?.asian === b.weights?.asian &&
    JSON.stringify(a.systemFaces ?? []) === JSON.stringify(b.systemFaces ?? []) &&
    [...a.downloaded].sort().join(",") === [...b.downloaded].sort().join(",") &&
    JSON.stringify((a.uploaded ?? []).map((f) => [f.id, f.family, f.weight, f.style]).sort()) ===
      JSON.stringify((b.uploaded ?? []).map((f) => [f.id, f.family, f.weight, f.style]).sort()));
const quote = (name: string) => `"${name}"`; // Names are validated before reaching here.
const family = (c: ReaderFontChoice) =>
  c.source === "system"
    ? quote(c.family)
    : c.source === "uploaded"
      ? quote(`Komori Uploaded ${c.id}`)
      : c.source === "google"
        ? quote(`Komori Google ${c.id}`)
        : presetFonts.find((f) => f.value === c.id)!.family;
// CJK radicals/ideographs, kana, Hangul, Bopomofo, compatibility/full-width forms.
const ASIAN_RANGE =
  "U+1100-11FF,U+2E80-9FFF,U+A960-A97F,U+AC00-D7FF,U+F900-FAFF,U+FE10-FE1F,U+FE30-FE4F,U+FF00-FFEF,U+1AFF0-1B16F,U+20000-323AF";
export function fontPairStack(pair: ReaderFontPair): string {
  return [
    ...new Set([
      pair.asian.source === "preset" && ["serif", "sans-serif"].includes(pair.asian.id)
        ? ""
        : '"Komori Asian"',
      pair.weights ? '"Komori Western"' : family(pair.western),
      family(pair.western),
      family(pair.asian),
      "serif",
    ]),
  ]
    .filter(Boolean)
    .join(", ");
}
export function googleFontUrl(id: string): string | undefined {
  const hash = googleFontFiles.find((f) => f.id === id)?.hash;
  return hash ? `http://komori-font.localhost/${id}/${hash}.ttf` : undefined;
}
/** Generic Western fallback remains browser-owned; owned aliases use an unshifted CSS baseline. */
export function fontPairBaseWeight(pair: ReaderFontPair): number {
  return pair.western.source === "preset" && ["serif", "sans-serif"].includes(pair.western.id)
    ? (pair.weights?.western ?? 400)
    : 400;
}
export function fontPairFaces(
  pair: ReaderFontPair,
  cssWeights: readonly number[] = [100, 200, 300, 400, 500, 600, 700, 800, 900],
): string {
  if (pair.weights) return weightedFontPairFaces(pair, cssWeights);
  return baseFontPairFaces(pair);
}
function baseFontPairFaces(pair: ReaderFontPair, includeAsian = true): string {
  const parts: string[] = [];
  const source = (
    c: Extract<ReaderFontChoice, { source: "preset" | "system" }>,
  ): string | undefined => {
    if (c.source === "preset" && ["serif", "sans-serif"].includes(c.id)) return undefined;
    if (c.source === "preset" && c.id === "inter") {
      parts.push(readerInterFace);
      return readerInterFace.match(/src: (.+?); font-style/)?.[1];
    }
    return `local(${family(c)})`;
  };
  for (const c of [pair.western, pair.asian]) {
    if (c.source === "google" || c.source === "uploaded") {
      const files =
        c.source === "google"
          ? googleFontFiles
              .filter((f) => f.familyId === c.id && pair.downloaded.includes(f.id))
              .map((f) => ({
                url: googleFontUrl(f.id),
                weight: f.weight.split(" ").map(Number).join(" "),
                style: "normal",
              }))
          : (pair.uploaded ?? [])
              .filter(
                (f) =>
                  f.family === pair.uploaded?.find((selected) => selected.id === c.id)?.family &&
                  validUploadedFont(f),
              )
              .map((f) => ({
                url: `http://komori-font.localhost/uploaded/${f.id}.ttf`,
                weight: f.weight,
                style: f.style,
              }));
      for (const file of files) {
        parts.push(
          `@font-face { font-family: ${family(c)}; src: url("${file.url}"); font-weight: ${file.weight}; font-style: ${file.style}; font-display: block; }`,
        );
        if (c === pair.asian && includeAsian)
          parts.push(
            `@font-face { font-family: "Komori Asian"; src: url("${file.url}"); font-weight: ${file.weight}; font-style: ${file.style}; unicode-range: ${ASIAN_RANGE}; font-display: block; }`,
          );
      }
      continue;
    }
    const src = source(c);
    const weight = c.source === "preset" && c.id === "inter" ? "100 900" : "400";
    if (c === pair.asian && src && includeAsian)
      parts.push(
        `@font-face { font-family: "Komori Asian"; src: ${src}; font-weight: ${weight}; unicode-range: ${ASIAN_RANGE}; font-display: block; }`,
      );
  }
  return [...new Set(parts)].join("\n");
}

/** Bind each script's real face to the book's CSS weights without changing its text nodes. */
function weightedFontPairFaces(pair: ReaderFontPair, cssWeights: readonly number[]): string {
  const parts = [baseFontPairFaces(pair, false)];
  for (const role of ["western", "asian"] as const) {
    const choice = pair[role];
    let files: { src: string; weight: string; style: string }[];
    if (choice.source === "google")
      files = googleFontFiles
        .filter((f) => f.familyId === choice.id && pair.downloaded.includes(f.id))
        .map((f) => ({ src: `url("${googleFontUrl(f.id)}")`, weight: f.weight, style: "normal" }));
    else if (choice.source === "uploaded")
      files = (pair.uploaded ?? [])
        .filter((f) => f.family === pair.uploaded?.find((f) => f.id === choice.id)?.family)
        .map((f) => ({
          src: `url("http://komori-font.localhost/uploaded/${f.id}.ttf")`,
          weight: f.weight,
          style: f.style,
        }));
    else if (choice.source === "preset" && choice.id === "inter")
      files = [
        {
          src: readerInterFace.match(/src: (.+?); font-style/)![1],
          weight: "100 900",
          style: "normal",
        },
      ];
    else {
      const name =
        choice.source === "system"
          ? choice.family
          : presetFonts.find((f) => f.value === choice.id)!.label;
      files = (pair.systemFaces ?? [])
        .filter((f) => f.family === name)
        .map((f) => ({ src: `local(${quote(f.name)})`, weight: String(f.weight), style: f.style }));
      // Before native face metadata arrives, retain the existing local-family behavior.
      if (
        !files.length &&
        !(choice.source === "preset" && ["serif", "sans-serif"].includes(choice.id))
      )
        files = [{ src: `local(${family(choice)})`, weight: "400", style: "normal" }];
    }
    for (const style of new Set(files.map((f) => f.style))) {
      const faces = files.filter((f) => f.style === style);
      for (const cssWeight of new Set(cssWeights)) {
        const requested = Math.min(
          1000,
          Math.max(1, cssWeight + pair.weights![role] - fontPairBaseWeight(pair)),
        );
        const candidates = faces.map((f) => {
          const [min, max = min] = f.weight.split(" ").map(Number);
          return {
            file: f,
            weight: Math.min(max, Math.max(min, requested)),
            variable: max !== min,
          };
        });
        // CSS's matching order: around 400/500 it tries the other normal face before bold.
        const lower = candidates
          .filter((c) => c.weight < requested)
          .sort((a, b) => b.weight - a.weight);
        const higher = candidates
          .filter((c) => c.weight > requested)
          .sort((a, b) => a.weight - b.weight);
        const face =
          candidates.find((c) => c.weight === requested) ??
          (requested >= 400 && requested <= 500
            ? (higher.find((c) => c.weight <= 500) ?? lower[0] ?? higher[0])
            : requested < 400
              ? (lower[0] ?? higher[0])
              : (higher[0] ?? lower[0]));
        if (!face) continue;
        parts.push(
          `@font-face { font-family: "Komori ${role === "asian" ? "Asian" : "Western"}"; src: ${face.file.src}; font-weight: ${cssWeight}; font-style: ${style}; ${face.variable ? `font-variation-settings: "wght" ${face.weight}; ` : ""}${role === "asian" ? `unicode-range: ${ASIAN_RANGE}; ` : ""}font-display: block; }`,
        );
      }
    }
  }
  return parts.join("\n");
}

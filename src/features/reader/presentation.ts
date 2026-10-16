/**
 * Reader presentation choices. Every one is the reader's own and applies to every book;
 * none defers to a book's own value. Keep the ranges in step with
 * `src-tauri/src/appearance_preferences.rs`.
 */

/** Reader font size choices in CSS pixels. */
export const readerFontSize = { min: 8, max: 72, step: 1, default: 16 } as const;

export type ReaderBlurMode = "all" | "after-toc";
export type ReaderFuriganaStyle = "hide" | "partial" | "toggle" | "full";
export const readerFuriganaStyles = ["hide", "partial", "toggle", "full"] as const;
export function isFuriganaStyle(value: unknown): value is ReaderFuriganaStyle {
  return readerFuriganaStyles.some((style) => style === value);
}

export function isBlurMode(value: unknown): value is ReaderBlurMode {
  return value === "all" || value === "after-toc";
}

/** A supported font size: a whole pixel within range, or the default for anything else. */
export function normalizeFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return readerFontSize.default;
  return Math.min(readerFontSize.max, Math.max(readerFontSize.min, Math.round(value)));
}

/** Reader line height choices, as a multiple of the text's font size. */
export const readerLineHeight = { min: 1, max: 3, step: 0.05, default: 1.65 } as const;

const lineHeightSteps = Math.round(1 / readerLineHeight.step);

/** A supported line height: a whole step within range, or the default for anything else. */
export function normalizeLineHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return readerLineHeight.default;
  // Dividing whole steps keeps 1.65 exactly 1.65 rather than 33 × 0.05.
  const stepped = Math.round(value * lineHeightSteps) / lineHeightSteps;
  return Math.min(readerLineHeight.max, Math.max(readerLineHeight.min, stepped));
}

/** Whether a value is already a supported line height. */
export function isLineHeight(value: unknown): value is number {
  return (
    typeof value === "number" &&
    value >= readerLineHeight.min &&
    value <= readerLineHeight.max &&
    Math.abs(value * lineHeightSteps - Math.round(value * lineHeightSteps)) < 1e-9
  );
}

/** Reader font weight choices: the weight of the book's normal text. */
export const readerFontWeight = {
  min: 100,
  max: 900,
  step: 100,
  normal: 400,
  default: 400,
} as const;

/** A supported font weight: a whole step within range, or the default for anything else. */
export function normalizeFontWeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return readerFontWeight.default;
  const stepped = Math.round(value / readerFontWeight.step) * readerFontWeight.step;
  return Math.min(readerFontWeight.max, Math.max(readerFontWeight.min, stepped));
}

/** Whether a value is already a supported font weight. */
export function isFontWeight(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= readerFontWeight.min &&
    (value as number) <= readerFontWeight.max &&
    (value as number) % readerFontWeight.step === 0
  );
}

/** Reader paragraph indentation choices in em of each paragraph's font size. */
export const readerParagraphIndent = { min: 0, max: 20, step: 0.5, default: 1 } as const;

const indentSteps = Math.round(1 / readerParagraphIndent.step);

/**
 * A supported paragraph indentation: a whole step within range, or the default for
 * anything else.
 */
export function normalizeParagraphIndent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return readerParagraphIndent.default;
  const stepped = Math.round(value * indentSteps) / indentSteps;
  return Math.min(readerParagraphIndent.max, Math.max(readerParagraphIndent.min, stepped));
}

/** Whether a value is already a supported paragraph indentation. */
export function isParagraphIndent(value: unknown): value is number {
  return (
    typeof value === "number" &&
    value >= readerParagraphIndent.min &&
    value <= readerParagraphIndent.max &&
    Number.isInteger(value * indentSteps)
  );
}

/**
 * Reader paragraph margin choices: the space before and after each paragraph along the
 * text's block direction, in CSS pixels.
 */
export const readerParagraphMargin = { min: 0, max: 200, step: 2, default: 0 } as const;

/** A supported paragraph margin: a whole step within range, or the default for anything else. */
export function normalizeParagraphMargin(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return readerParagraphMargin.default;
  const stepped = Math.round(value / readerParagraphMargin.step) * readerParagraphMargin.step;
  return Math.min(readerParagraphMargin.max, Math.max(readerParagraphMargin.min, stepped));
}

/** Whether a value is already a supported paragraph margin. */
export function isParagraphMargin(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= readerParagraphMargin.min &&
    (value as number) <= readerParagraphMargin.max &&
    (value as number) % readerParagraphMargin.step === 0
  );
}

/** Reader side margin choices: the empty space on the left and right of each page, in CSS pixels. */
const readerSideMargin = { min: 0, max: 400, step: 4, default: 40 } as const;

/** A supported side margin: a whole step within range, or the default for anything else. */
export function normalizeSideMargin(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return readerSideMargin.default;
  const stepped = Math.round(value / readerSideMargin.step) * readerSideMargin.step;
  return Math.min(readerSideMargin.max, Math.max(readerSideMargin.min, stepped));
}

/** Whether a value is already a supported side margin. */
function isSideMargin(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= readerSideMargin.min &&
    (value as number) <= readerSideMargin.max &&
    (value as number) % readerSideMargin.step === 0
  );
}

/**
 * Reader letter spacing choices: the space added between the characters of book text, in
 * CSS pixels. 0 keeps the book's own spacing; any other value replaces it in all text.
 */
export const readerLetterSpacing = { min: -10, max: 60, step: 1, default: 0 } as const;

/**
 * Reader word spacing choices: the space added at each space between words, in CSS pixels.
 * 0 keeps the book's own spacing; any other value replaces it in all text.
 */
export const readerWordSpacing = { min: -20, max: 120, step: 1, default: 0 } as const;

type PixelRange = { min: number; max: number; default: number };

function normalizePixels(range: PixelRange, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return range.default;
  // `+ 0` turns a rounded -0 into 0.
  return Math.min(range.max, Math.max(range.min, Math.round(value))) + 0;
}

function isPixels(range: PixelRange, value: unknown): value is number {
  return (
    Number.isInteger(value) && (value as number) >= range.min && (value as number) <= range.max
  );
}

/** A supported letter spacing: a whole pixel within range, or the default for anything else. */
export function normalizeLetterSpacing(value: unknown): number {
  return normalizePixels(readerLetterSpacing, value);
}

/** Whether a value is already a supported letter spacing. */
export function isLetterSpacing(value: unknown): value is number {
  return isPixels(readerLetterSpacing, value);
}

/** A supported word spacing: a whole pixel within range, or the default for anything else. */
export function normalizeWordSpacing(value: unknown): number {
  return normalizePixels(readerWordSpacing, value);
}

/** Whether a value is already a supported word spacing. */
export function isWordSpacing(value: unknown): value is number {
  return isPixels(readerWordSpacing, value);
}

/** Reader writing modes. */
const readerWritingModes = ["horizontal", "vertical"] as const;

export type ReaderWritingMode = (typeof readerWritingModes)[number];

export const defaultWritingMode: ReaderWritingMode = "horizontal";

/** Whether a value is a supported writing mode. */
export function isWritingMode(value: unknown): value is ReaderWritingMode {
  return readerWritingModes.includes(value as ReaderWritingMode);
}

/** A supported writing mode, or the default for anything else. */
export function normalizeWritingMode(value: unknown): ReaderWritingMode {
  return isWritingMode(value) ? value : defaultWritingMode;
}

/**
 * Reader text orientations of vertical text: Latin letters and digits lying sideways
 * (mixed) or standing upright.
 */
const readerTextOrientations = ["mixed", "upright"] as const;

export type ReaderTextOrientation = (typeof readerTextOrientations)[number];

export const defaultTextOrientation: ReaderTextOrientation = "mixed";

/** Whether a value is a supported text orientation. */
export function isTextOrientation(value: unknown): value is ReaderTextOrientation {
  return readerTextOrientations.includes(value as ReaderTextOrientation);
}

/** A supported text orientation, or the default for anything else. */
export function normalizeTextOrientation(value: unknown): ReaderTextOrientation {
  return isTextOrientation(value) ? value : defaultTextOrientation;
}

/**
 * Reader view modes: pages turned one at a time, the default, one continuous scroll
 * through the whole book, or one scroll through each chapter in turn.
 */
const readerViewModes = ["paginated", "continuous", "semi-continuous", "vn"] as const;

/** Paragraphs per VN group; large paragraphs remain scrollable. */
export const readerVnParagraphs = { min: 1, max: 20, step: 1, default: 1 } as const;
export function isVnParagraphs(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 20;
}
export function normalizeVnParagraphs(value: unknown): number {
  return isVnParagraphs(value) ? value : readerVnParagraphs.default;
}
/** Graphemes per second; zero displays all text immediately. */
export const readerVnTextSpeed = { min: 0, max: 200, step: 1, default: 40 } as const;
export function isVnTextSpeed(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 200;
}
export function normalizeVnTextSpeed(value: unknown): number {
  return isVnTextSpeed(value) ? value : readerVnTextSpeed.default;
}

export type ReaderViewMode = (typeof readerViewModes)[number];

/** Whether a value is a supported view mode. */
export function isViewMode(value: unknown): value is ReaderViewMode {
  return readerViewModes.includes(value as ReaderViewMode);
}

/** A supported view mode, or paginated for anything else. */
export function normalizeViewMode(value: unknown): ReaderViewMode {
  return isViewMode(value) ? value : "paginated";
}

/**
 * Reader max height choices: the tallest the book's reading area may be, in CSS pixels.
 * The default, the largest, leaves the reading area at the window's height.
 */
export const readerMaxHeight = { min: 100, max: 1_000_000, step: 10, default: 4000 } as const;

/** Requested text width per page. The live control limit comes from the native monitor. */
export const readerMaxWidth = { ...readerMaxHeight };
export const normalizeMaxWidth = normalizeMaxHeight;
export const isMaxWidth = isMaxHeight;

const readerPageLayouts = ["single", "double"] as const;
export type ReaderPageLayout = (typeof readerPageLayouts)[number];
export const isPageLayout = (value: unknown): value is ReaderPageLayout =>
  readerPageLayouts.includes(value as ReaderPageLayout);
export const normalizePageLayout = (value: unknown): ReaderPageLayout =>
  isPageLayout(value) ? value : "double";

/** Retired margins migrate once to a stable width, independently of the current monitor. */
export function legacyTextWidth(value: unknown): number | undefined {
  return isSideMargin(value) ? normalizeMaxWidth(1200 - 2 * value) : undefined;
}

/** A supported max height: a whole step within range, or the default for anything else. */
export function normalizeMaxHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return readerMaxHeight.default;
  const stepped = Math.round(value / readerMaxHeight.step) * readerMaxHeight.step;
  return Math.min(readerMaxHeight.max, Math.max(readerMaxHeight.min, stepped));
}

/** Whether a value is already a supported max height. */
export function isMaxHeight(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= readerMaxHeight.min &&
    (value as number) <= readerMaxHeight.max &&
    (value as number) % readerMaxHeight.step === 0
  );
}

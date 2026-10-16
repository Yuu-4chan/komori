import { googleFontFiles, type ReaderFontChoice } from "./fontChoices";
import type { DownloadedFont } from "./readerFonts";
import { readerFontWeight } from "./presentation";

export const standardFontWeights = Array.from(
  { length: (readerFontWeight.max - readerFontWeight.min) / readerFontWeight.step + 1 },
  (_, index) => readerFontWeight.min + index * readerFontWeight.step,
);

export const isFaceWeight = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 1000;

function weightsInRange(weight: string): number[] {
  const [first, last] = weight.split(" ").map(Number);
  return last === undefined
    ? [first]
    : [...new Set([first, ...standardFontWeights.filter((w) => w >= first && w <= last), last])];
}

/** Known managed faces, or the existing range when Windows chooses a system face. */
export function availableFontWeights(
  choice: ReaderFontChoice,
  fonts: readonly DownloadedFont[],
): number[] {
  if (choice.source === "preset" || choice.source === "system") return standardFontWeights;
  const files =
    choice.source === "google"
      ? googleFontFiles.filter(
          (f) =>
            f.familyId === choice.id &&
            fonts.some((installed) => installed.id === f.id && installed.available),
        )
      : (() => {
          const selected = fonts.find(
            (f) => f.source === "uploaded" && f.id === choice.id && f.available,
          );
          if (!selected) return [];
          const family = fonts.filter(
            (f) => f.source === "uploaded" && f.available && f.family === selected.family,
          );
          const normal = family.filter((f) => f.style === "normal");
          return normal.length ? normal : family;
        })();
  const weights = files.flatMap((file) => (file.weight ? weightsInRange(file.weight) : []));
  return [...new Set(weights)].sort((a, b) => a - b);
}

/** CSS matching order, so an unavailable saved request resolves predictably. */
export function resolveFontWeight(requested: number, available: readonly number[]): number {
  if (!available.length || available.includes(requested)) return requested;
  const lower = available.filter((weight) => weight < requested).sort((a, b) => b - a);
  const higher = available.filter((weight) => weight > requested).sort((a, b) => a - b);
  if (requested >= 400 && requested <= 500)
    return higher.find((weight) => weight <= 500) ?? lower[0] ?? higher[0];
  return requested < 400 ? (lower[0] ?? higher[0]) : (higher[0] ?? lower[0]);
}

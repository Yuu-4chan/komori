/** The saved blur radius in CSS pixels, independent of the enabled switch. */
export const backgroundBlurLevel = { min: 0, max: 40, step: 1, default: 16 } as const;
export function isBackgroundBlurLevel(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= backgroundBlurLevel.min &&
    value <= backgroundBlurLevel.max
  );
}

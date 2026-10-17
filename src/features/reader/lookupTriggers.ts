/** Input preferences are separate from book presentation: changing them never reflows text. */
export const shortcutPresets = [
  { value: "shift-enter", label: "Shift + Enter" },
  { value: "alt-x", label: "Alt + X" },
  { value: "ctrl-space", label: "Ctrl + Space" },
] as const;
export const mouseTriggers = [
  { value: "left", label: "popupSettings.mouseLeft" },
  { value: "double", label: "popupSettings.mouseDouble" },
  { value: "shift-right", label: "popupSettings.mouseShiftRight" },
  { value: "middle", label: "popupSettings.mouseMiddle" },
] as const;
export const readingPositions = [
  { value: "beside", label: "popupSettings.positionBeside" },
  { value: "above", label: "popupSettings.positionAbove" },
] as const;
/** Hover delay, scanned characters, listed results, and child popup levels; 0 means none. */
export const hoverDelayRange = { min: 0, max: 1200, step: 10 } as const;
export const scanLengthRange = { min: 1, max: 64, step: 1 } as const;
export const maxResultsRange = { min: 1, max: 64, step: 1 } as const;
export const childLevelsRange = { min: 0, max: 5, step: 1 } as const;
export const popupCloseBehaviors = [
  { value: "escape-outside", label: "popupSettings.closeEscapeOutside" },
  { value: "outside", label: "popupSettings.closeOutside" },
  { value: "persistent", label: "popupSettings.closePersistent" },
] as const;

export interface LookupTriggerPreferences {
  readerPopupEnabled: boolean;
  readerPopupMouseSelection: boolean;
  readerPopupShiftLookup: boolean;
  readerPopupKeyboardShortcut: boolean;
  readerPopupClickLookup: boolean;
  readerPopupHoverLookup: boolean;
  readerPopupCjkOnly: boolean;
  readerPopupShortcutPreset: (typeof shortcutPresets)[number]["value"];
  readerPopupMouseTrigger: (typeof mouseTriggers)[number]["value"];
  readerPopupCloseBehavior: (typeof popupCloseBehaviors)[number]["value"];
  readerPopupHoverDelay: number;
  readerPopupScanLength: number;
  readerPopupMaxResults: number;
  readerPopupChildLevels: number;
  readerPopupReadingPosition: (typeof readingPositions)[number]["value"];
}

export type LookupTrigger = "pointer" | "keyboard" | "shift" | "shortcut" | "click" | "hover";
export const defaultLookupTriggers: LookupTriggerPreferences = {
  readerPopupEnabled: true,
  readerPopupMouseSelection: false,
  readerPopupShiftLookup: true,
  readerPopupKeyboardShortcut: true,
  readerPopupClickLookup: true,
  readerPopupHoverLookup: false,
  readerPopupCjkOnly: false,
  readerPopupShortcutPreset: "shift-enter",
  readerPopupMouseTrigger: "middle",
  readerPopupCloseBehavior: "escape-outside",
  readerPopupHoverDelay: 0,
  readerPopupScanLength: 16,
  readerPopupMaxResults: 5,
  readerPopupChildLevels: 5,
  readerPopupReadingPosition: "beside",
};

export function normalizeLookupTriggers(value: unknown): Partial<LookupTriggerPreferences> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, fallback] of Object.entries(defaultLookupTriggers)) {
    const entry = record[key];
    if (typeof fallback === "boolean" && typeof entry === "boolean") result[key] = entry;
  }
  for (const [key, options] of [
    ["readerPopupShortcutPreset", shortcutPresets],
    ["readerPopupMouseTrigger", mouseTriggers],
    ["readerPopupCloseBehavior", popupCloseBehaviors],
    ["readerPopupReadingPosition", readingPositions],
  ] as const) {
    if (options.some(({ value }) => value === record[key])) result[key] = record[key];
  }
  for (const [key, range] of [
    ["readerPopupHoverDelay", hoverDelayRange],
    ["readerPopupScanLength", scanLengthRange],
    ["readerPopupMaxResults", maxResultsRange],
    ["readerPopupChildLevels", childLevelsRange],
  ] as const) {
    const value = record[key];
    if (Number.isInteger(value) && (value as number) >= range.min && (value as number) <= range.max)
      result[key] = value;
  }
  return result;
}

export function triggerEnabled(
  settings: LookupTriggerPreferences,
  trigger: LookupTrigger,
): boolean {
  if (!settings.readerPopupEnabled) return false;
  switch (trigger) {
    case "pointer":
      return settings.readerPopupMouseSelection;
    case "keyboard":
      return true; // Preserve keyboard-selection release lookup independently.
    case "shift":
      return settings.readerPopupShiftLookup;
    case "shortcut":
      return settings.readerPopupKeyboardShortcut;
    case "click":
      return settings.readerPopupClickLookup;
    case "hover":
      return settings.readerPopupHoverLookup;
  }
}

/** Automatic Reader gestures accept kana, Han (including extensions), and Hangul. */
export function lookupTextAllowed(settings: LookupTriggerPreferences, text: string): boolean {
  return (
    !settings.readerPopupCjkOnly ||
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)
  );
}

export function editableTarget(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return !!element?.closest?.(
    "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']",
  );
}

export function matchesLookupShortcut(
  event: KeyboardEvent,
  preset: LookupTriggerPreferences["readerPopupShortcutPreset"],
): boolean {
  if (
    event.repeat ||
    event.isComposing ||
    event.defaultPrevented ||
    event.metaKey ||
    editableTarget(event.target)
  )
    return false;
  switch (preset) {
    case "shift-enter":
      return event.key === "Enter" && event.shiftKey && !event.altKey && !event.ctrlKey;
    case "alt-x":
      return event.key.toLowerCase() === "x" && event.altKey && !event.shiftKey && !event.ctrlKey;
    case "ctrl-space":
      return event.key === " " && event.ctrlKey && !event.shiftKey && !event.altKey;
  }
}

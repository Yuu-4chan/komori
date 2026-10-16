import { editableTarget } from "./lookupTriggers";

export const escapeReturnWindow = 1800;

export const commandShortcuts = [
  {
    id: "library-search",
    context: "Library",
    key: "f",
    modifier: "ctrl",
    binding: "Ctrl+F",
    action: "Open and focus search",
  },
  {
    id: "dictionary",
    context: "Application pages",
    key: "d",
    modifier: "ctrl",
    binding: "Ctrl+D",
    action: "Open dictionary",
  },
  {
    id: "statistics",
    context: "Application pages",
    key: "s",
    modifier: "ctrl",
    binding: "Ctrl+S",
    action: "Open statistics",
  },
  {
    id: "settings",
    context: "Application pages",
    key: "g",
    modifier: "ctrl",
    binding: "Ctrl+G",
    action: "Open settings",
  },
  {
    id: "library",
    context: "Application pages",
    key: "b",
    modifier: "ctrl",
    binding: "Ctrl+B",
    action: "Return to library",
    availability: "Dictionary, Settings and Statistics pages",
  },
  {
    id: "images",
    context: "Reader",
    key: "g",
    modifier: "none",
    binding: "G",
    action: "Open image gallery",
  },
  {
    id: "bookmark",
    context: "Reader",
    key: "b",
    modifier: "none",
    binding: "B",
    action: "Save a quick bookmark",
    availability: "Book ready; no pending navigation or bookmark save",
  },
  {
    id: "note",
    context: "Reader",
    key: "n",
    modifier: "none",
    binding: "N",
    action: "Create a note from selected book text",
    availability: "Select 1–4,096 characters in a ready book",
  },
  {
    id: "sidebar",
    context: "Reader",
    key: "s",
    modifier: "none",
    binding: "S",
    action: "Toggle sidebar",
  },
  {
    id: "appearance",
    context: "Reader",
    key: "a",
    modifier: "none",
    binding: "A",
    action: "Open Appearance",
  },
  {
    id: "find",
    context: "Reader",
    key: "f",
    modifier: "ctrl",
    binding: "Ctrl+F",
    action: "Open and focus Find in book",
  },
  {
    id: "bookmarks",
    context: "Reader",
    key: "b",
    modifier: "ctrl",
    binding: "Ctrl+B",
    action: "Open all bookmarks",
  },
  {
    id: "last-bookmark",
    context: "Reader",
    key: "r",
    modifier: "none",
    binding: "R",
    action: "Go to the last bookmark",
    availability: "A bookmark saved in this book",
  },
  {
    id: "session",
    context: "Reader",
    key: "p",
    modifier: "none",
    binding: "P",
    action: "Start or pause reading session",
    availability: "Recording enabled",
  },
  {
    id: "anki-add",
    context: "Dictionary popup",
    key: "e",
    modifier: "alt",
    binding: "Alt+E",
    action: "Add active expression to Anki",
    availability: "Anki action enabled and ready; uses saved duplicate/recovery policy",
  },
  {
    id: "anki-browse",
    context: "Dictionary popup",
    key: "b",
    modifier: "alt",
    binding: "Alt+B",
    action: "Open active expression in Anki Browser",
    availability: "Anki action enabled; an existing or confirmed card",
  },
] as const;

export type ShortcutCommand = (typeof commandShortcuts)[number]["id"];
export function matchesModifiers(
  event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
  modifier: "ctrl" | "alt" | "none",
) {
  return (
    !event.metaKey &&
    !event.shiftKey &&
    event.ctrlKey === (modifier === "ctrl") &&
    event.altKey === (modifier === "alt")
  );
}

export function shortcutCommand(
  event: KeyboardEvent,
  context: "Library" | "Application pages" | "Reader" | "Dictionary popup",
): ShortcutCommand | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || editableTarget(event.target))
    return null;
  return (
    commandShortcuts.find(
      (shortcut) =>
        shortcut.context === context &&
        shortcut.key === event.key.toLowerCase() &&
        matchesModifiers(event, shortcut.modifier),
    )?.id ?? null
  );
}

/**
 * Commands may start from chrome or an EPUB realm; controls keep their own keyboard behavior.
 * A command shortcut, and Escape, also works from a button or link, whose keys are Enter and Space
 * only; fields, menus, listboxes and dialogs keep their own Escape.
 */
export function commandTarget(target: EventTarget | null, command = false): boolean {
  return (
    !editableTarget(target) &&
    !(target as Element | null)?.closest?.(
      command
        ? 'dialog, [role="dialog"], [role="menu"], [role="listbox"], [role="combobox"]'
        : 'button, a, option, dialog, [role="dialog"], [role="menu"], [role="listbox"], [role="combobox"], [data-reader-navigation-exclude]',
    )
  );
}

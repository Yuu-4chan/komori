import type { KeyboardEvent } from "react";

/** Release a search field without letting Escape also dismiss its surrounding UI. */
export function searchEscape(event: KeyboardEvent<HTMLInputElement>): boolean {
  if (
    event.key !== "Escape" ||
    event.defaultPrevented ||
    event.repeat ||
    event.nativeEvent.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return false;
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.blur();
  return true;
}

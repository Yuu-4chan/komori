import type { ReaderRect, ReaderSelection } from "./renderer";

/** The lookup popup's size when the reading area has room for it, in CSS pixels. */
export const lookupPopupSize = { width: 480, height: 440 } as const;

/** Only the lookup sheet and its Settings preview use this corner radius. */
export const lookupPopupRadius = { min: 0, max: 28, step: 1, default: 18 } as const;
export const isLookupRadius = (value: unknown): value is number =>
  Number.isInteger(value) &&
  (value as number) >= lookupPopupRadius.min &&
  (value as number) <= lookupPopupRadius.max;

/** User-selected dimensions, in CSS pixels; placement still fits the reading area. */
export const lookupPopupWidth = { min: 320, max: 1200, step: 20 } as const;
export const lookupPopupHeight = { min: 200, max: 1200, step: 20 } as const;
export function isLookupDimension(
  value: unknown,
  range: { min: number; max: number },
): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= range.min &&
    (value as number) <= range.max &&
    (value as number) % 20 === 0
  );
}

/** The space between the selection and the popup. */
const SELECTION_GAP = 10;
/** The space the popup keeps from the reading area's edges. */
const AREA_MARGIN = 8;
/** The least room beside the selection the popup shrinks into before it lies over it. */
const LEAST_ROOM = 120;

/** The native lookup's query limit in Unicode characters. */
const QUERY_CHARACTERS = 256;

/** The text a selection looks up: trimmed, and its first 256 characters when longer. */
export function lookupQuery(text: string): string {
  return [...text.trim()].slice(0, QUERY_CHARACTERS).join("").trimEnd();
}

/**
 * Where the popup shows for a selection, within the reading area: below horizontal text,
 * starting at the selection's left edge, and beside vertical text, before it in its reading
 * order (left of right-to-left lines), starting at its top. Without room on that side it
 * shows on the other; with room on neither it shrinks into the larger, and with too little
 * room for that it lies over the selection. It never leaves the reading area.
 */
export function placeLookupPopup(
  selection: ReaderRect,
  area: ReaderRect,
  writingMode: ReaderSelection["writingMode"],
  size: { width: number; height: number } = lookupPopupSize,
): ReaderRect {
  const inner = {
    left: area.left + AREA_MARGIN,
    top: area.top + AREA_MARGIN,
    right: area.right - AREA_MARGIN,
    bottom: area.bottom - AREA_MARGIN,
  };
  const width = Math.max(0, Math.min(size.width, inner.right - inner.left));
  const height = Math.max(0, Math.min(size.height, inner.bottom - inner.top));
  if (writingMode === "horizontal") {
    const left = clamp(selection.left, inner.left, inner.right - width);
    const [top, shownHeight] = beside(
      selection.top,
      selection.bottom,
      height,
      inner.top,
      inner.bottom,
      true,
    );
    return { left, top, right: left + width, bottom: top + shownHeight };
  }
  const [left, shownWidth] = beside(
    selection.left,
    selection.right,
    width,
    inner.left,
    inner.right,
    writingMode === "vertical-lr",
  );
  const top = clamp(selection.top, inner.top, inner.bottom - height);
  return { left, top, right: left + shownWidth, bottom: top + height };
}

/** A position and size along the axis where the popup lies beside the selection. */
function beside(
  start: number,
  end: number,
  size: number,
  min: number,
  max: number,
  preferAfter: boolean,
): [position: number, size: number] {
  const roomBefore = start - SELECTION_GAP - min;
  const roomAfter = max - (end + SELECTION_GAP);
  const after = (room: number) => [end + SELECTION_GAP, room] as [number, number];
  const before = (room: number) => [start - SELECTION_GAP - room, room] as [number, number];
  if (preferAfter ? roomAfter >= size : roomBefore < size && roomAfter >= size) return after(size);
  if (roomBefore >= size) return before(size);
  if (Math.max(roomBefore, roomAfter) >= LEAST_ROOM)
    return roomAfter >= roomBefore ? after(roomAfter) : before(roomBefore);
  const preferred = preferAfter ? end + SELECTION_GAP : start - SELECTION_GAP - size;
  return [clamp(preferred, min, max - size), size];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

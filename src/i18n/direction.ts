/**
 * 1 while the interface reads left to right, -1 while it is mirrored (Arabic): sideways arrow
 * keys and scrolling follow the interface's direction.
 */
export const inlineSign = (): 1 | -1 =>
  typeof document !== "undefined" && document.documentElement.dir === "rtl" ? -1 : 1;

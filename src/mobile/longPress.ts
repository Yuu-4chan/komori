import { useRef, type MouseEvent as ReactMouseEvent } from "react";

// How long after a long press its own click is ignored, so the book does not open too.
const longPressClick = 800;

/** A long press (Android's contextmenu) on a book, which then does not open it. */
export function useLongPress(onLongPress: () => void) {
  const pressed = useRef(0);
  return {
    onContextMenu: (event: ReactMouseEvent) => {
      event.preventDefault();
      pressed.current = Date.now();
      onLongPress();
    },
    onClickCapture: (event: ReactMouseEvent) => {
      if (Date.now() - pressed.current >= longPressClick) return;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

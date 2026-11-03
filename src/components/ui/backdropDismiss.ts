import { useRef, type MouseEvent, type PointerEvent } from "react";

/**
 * Closes a modal dialog on a click on its backdrop, only when the press began there too: a drag
 * from inside, such as selecting a field's text, that is released outside keeps it open.
 */
export function useBackdropDismiss(onDismiss: () => void) {
  const pressedBackdrop = useRef(false);
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      pressedBackdrop.current = event.target === event.currentTarget;
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      const fromBackdrop = pressedBackdrop.current;
      pressedBackdrop.current = false;
      if (fromBackdrop && event.target === event.currentTarget) onDismiss();
    },
  };
}

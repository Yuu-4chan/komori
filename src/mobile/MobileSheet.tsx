import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useBackCloser } from "./system";

interface MobileSheetProps {
  open: boolean;
  /** Kept open but out of sight, such as under what was opened from it. */
  hidden?: boolean;
  onClose: () => void;
  label: string;
  className?: string;
  children: ReactNode;
}

// How many sheets are open; while any is, the page under them keeps still.
let openSheets = 0;

/**
 * A sheet rising from the bottom of the phone over a dimmed page. Tapping the page or Back
 * closes it. While it is open the page under it keeps still, however the sheet is swiped.
 */
export function MobileSheet({
  open,
  hidden,
  onClose,
  label,
  className,
  children,
}: MobileSheetProps) {
  useBackCloser(open && !hidden, onClose);
  useEffect(() => {
    if (!open) return;
    openSheets += 1;
    document.documentElement.dataset.sheetOpen = "";
    return () => {
      openSheets -= 1;
      if (!openSheets) delete document.documentElement.dataset.sheetOpen;
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div
      className="mobile-sheet-layer"
      hidden={hidden}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-label={label}
        aria-modal="true"
        className={["mobile-sheet", className].filter(Boolean).join(" ")}
        role="dialog"
      >
        <span aria-hidden="true" className="mobile-sheet__handle" />
        {children}
      </section>
    </div>,
    document.body,
  );
}

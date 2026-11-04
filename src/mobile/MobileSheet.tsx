import type { ReactNode } from "react";
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

/**
 * A sheet rising from the bottom of the phone over a dimmed page. Tapping the page or Back
 * closes it.
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

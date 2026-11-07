import { useEffect, useRef, type ReactNode } from "react";
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
 * closes it, as does swiping the sheet down from its top (from anywhere in it while what is under
 * the finger is scrolled to its top). While it is open the page under it keeps still, however
 * the sheet is swiped.
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
  const sheet = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = sheet.current;
    if (!open || !element) return;
    return dragToClose(element, () => close.current());
  }, [open]);
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
        ref={sheet}
        role="dialog"
      >
        <span aria-hidden="true" className="mobile-sheet__handle" />
        {children}
      </section>
    </div>,
    document.body,
  );
}

/** How far a finger moves before a touch is a swipe, in CSS pixels. */
const SLOP = 10;

/**
 * Lets the sheet follow a finger swiping down and closes it past a quarter of its height (at
 * most 120px) or on a quick flick; a shorter swipe returns it. A swipe starts only where nothing
 * between the finger and the sheet is scrolled down, so lists still scroll back up first.
 */
function dragToClose(sheet: HTMLElement, close: () => void) {
  let start: { x: number; y: number; at: number } | null = null;
  let dragging = false;
  let offset = 0;
  const scrolledDown = (target: EventTarget | null) => {
    for (let node = target instanceof Element ? target : null; node; node = node.parentElement) {
      if (node.scrollTop > 0) return true;
      if (node === sheet) break;
    }
    return false;
  };
  const settle = (closing: boolean) => {
    dragging = false;
    start = null;
    sheet.style.transition = closing ? "" : "transform 160ms ease-out";
    if (closing) close();
    // A sheet still open (its owner kept it) slides back.
    requestAnimationFrame(() => {
      sheet.style.transform = "";
    });
    offset = 0;
  };
  const touchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    start =
      event.touches.length === 1 && touch && !scrolledDown(event.target)
        ? { x: touch.clientX, y: touch.clientY, at: event.timeStamp }
        : null;
  };
  const touchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!start || !touch) return;
    const down = touch.clientY - start.y;
    if (!dragging) {
      const across = Math.abs(touch.clientX - start.x);
      if (down > SLOP && down > across) {
        dragging = true;
        sheet.style.transition = "none";
      } else if (across > SLOP || down < -SLOP) {
        start = null;
        return;
      } else return;
    }
    if (event.cancelable) event.preventDefault();
    offset = Math.max(0, down - SLOP);
    sheet.style.transform = `translateY(${offset}px)`;
  };
  const touchEnd = (event: TouchEvent) => {
    if (!dragging || !start) {
      start = null;
      return;
    }
    const speed = offset / Math.max(1, event.timeStamp - start.at);
    settle(offset > Math.min(120, sheet.offsetHeight / 4) || (offset > 24 && speed > 0.6));
  };
  const touchCancel = () => {
    if (dragging) settle(false);
    start = null;
  };
  sheet.addEventListener("touchstart", touchStart, { passive: true });
  sheet.addEventListener("touchmove", touchMove, { passive: false });
  sheet.addEventListener("touchend", touchEnd);
  sheet.addEventListener("touchcancel", touchCancel);
  return () => {
    sheet.removeEventListener("touchstart", touchStart);
    sheet.removeEventListener("touchmove", touchMove);
    sheet.removeEventListener("touchend", touchEnd);
    sheet.removeEventListener("touchcancel", touchCancel);
  };
}

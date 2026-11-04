import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useState,
} from "react";

import { useAppearance } from "../features/appearance/AppearanceProvider";
import { popupThemeStyle } from "../features/reader/popupThemes";
import { resolveReaderTheme } from "../features/reader/readerThemes";
import type { ReaderRect } from "../features/reader/renderer";
import { useI18n } from "../i18n/i18n";
import { useBackCloser } from "./system";
import "./mobileReader.css";

// The sheet's share of the screen until it is dragged up to all of it.
const sheetShare = 0.54;
// The least of the screen a sheet beside a word in the middle takes.
const leastShare = 1 / 3;
// The space kept between the tapped word and the sheet, in CSS pixels.
const wordGap = 12;
// A drag of the handle past this resizes or closes the sheet.
const dragDistance = 64;

interface MobileLookupSheetProps {
  /** The looked-up text in the book, kept clear of the sheet. */
  rect?: ReaderRect;
  label: string;
  /** Back: returns to the lookup before, or closes the sheet from the first. */
  onBack: () => void;
  onClose: () => void;
  /** The lookups, the one shown last. */
  children: ReactNode;
}

/** Where the sheet goes for a word at `rect`: the bottom, unless that covers the word. */
export function sheetPlace(
  rect: ReaderRect | undefined,
  screen: number,
): { edge: "top" | "bottom"; height: number } {
  const share = Math.round(screen * sheetShare);
  if (!rect) return { edge: "bottom", height: share };
  const below = screen - rect.bottom - wordGap;
  const above = rect.top - wordGap;
  if (below >= share) return { edge: "bottom", height: share };
  if (above >= share) return { edge: "top", height: share };
  const least = Math.round(screen * leastShare);
  return below >= above
    ? { edge: "bottom", height: Math.max(below, least) }
    : { edge: "top", height: Math.max(above, least) };
}

/**
 * A Reader lookup on the phone: a sheet from the bottom of the screen, or from the top for a
 * word under that place, in the popup's theme. Its handle drags it to the whole screen and
 * back, or away; tapping the book beside it or Back closes it.
 */
export function MobileLookupSheet({
  rect,
  label,
  onBack,
  onClose,
  children,
}: MobileLookupSheetProps) {
  const { t } = useI18n();
  const { readerPopupTheme, readerPopupCustomPalette, readerTheme, readerCustomThemes } =
    useAppearance();
  const [{ edge, height }] = useState(() => sheetPlace(rect, window.innerHeight));
  const [full, setFull] = useState(false);
  const [drag, setDrag] = useState<{ pointerId: number; from: number; grow: number } | null>(null);
  useBackCloser(true, onBack);

  const growth = (event: ReactPointerEvent) =>
    drag ? (edge === "bottom" ? drag.from - event.clientY : event.clientY - drag.from) : 0;
  const end = (event: ReactPointerEvent, drop: boolean) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const grow = growth(event);
    setDrag(null);
    if (!drop) return;
    if (grow > dragDistance) setFull(true);
    else if (grow < -dragDistance) {
      if (full) setFull(false);
      else onClose();
    }
  };
  const shown = Math.min(
    window.innerHeight,
    Math.max(0, (full ? window.innerHeight : height) + (drag?.grow ?? 0)),
  );

  return (
    <div className={`mobile-lookup mobile-lookup--${edge}`}>
      <button
        aria-label={t("common.close")}
        className="mobile-lookup__close"
        onClick={onClose}
        type="button"
      />
      <section
        aria-label={label}
        className="mobile-lookup__sheet"
        data-dragging={drag ? "" : undefined}
        data-full={full ? "" : undefined}
        data-popup-theme={readerPopupTheme}
        role="dialog"
        style={
          {
            ...popupThemeStyle(
              readerPopupTheme,
              readerPopupCustomPalette,
              resolveReaderTheme(readerTheme, readerCustomThemes),
            ),
            height: shown,
          } as CSSProperties
        }
      >
        <div
          aria-hidden="true"
          className="mobile-lookup__handle"
          onLostPointerCapture={(event) => end(event, false)}
          onPointerCancel={(event) => end(event, false)}
          onPointerDown={(event) => {
            if (drag) return;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            setDrag({ pointerId: event.pointerId, from: event.clientY, grow: 0 });
          }}
          onPointerMove={(event) => {
            if (drag && event.pointerId === drag.pointerId)
              setDrag({ ...drag, grow: growth(event) });
          }}
          onPointerUp={(event) => end(event, true)}
        >
          <span />
        </div>
        {children}
      </section>
    </div>
  );
}

import { CalendarBlankIcon, CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { inlineSign } from "../../i18n/direction";
import { useI18n } from "../../i18n/i18n";

/** A month as `YYYY-MM`. */
const monthValue = (month: Date) =>
  `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;

const addMonths = (month: Date, months: number) =>
  new Date(month.getFullYear(), month.getMonth() + months, 1);

/**
 * A month field, as the day field: a button showing the month in the interface's language that
 * opens the year's months under it (or above it, without room below). The arrows move by a month
 * or a row, Page Up and Page Down by a year; Enter or a click chooses, Escape or a click
 * elsewhere closes. Months outside `min`–`max` (their first days) cannot be chosen.
 */
export function MonthPicker({
  id,
  label,
  value,
  min,
  max,
  onChoose,
}: {
  id: string;
  /** The field's name, read with the month shown. */
  label: string;
  /** The first day of the month shown. */
  value: Date;
  min: Date;
  max: Date;
  onChoose: (month: Date) => void;
}) {
  const { t, date } = useI18n();
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const [focused, setFocused] = useState(value);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const focusing = useRef(false);

  const minKey = monthValue(min);
  const maxKey = monthValue(max);
  const clamp = (month: Date) => {
    const key = monthValue(month);
    return key < minKey ? min : key > maxKey ? max : month;
  };
  const show = () => {
    setFocused(clamp(value));
    setAbove(false);
    focusing.current = true;
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  // Opens upward when the window has no room for it below.
  useLayoutEffect(() => {
    if (!open || !popover.current || !trigger.current) return;
    const height = popover.current.getBoundingClientRect().height;
    const box = trigger.current.getBoundingClientRect();
    setAbove(box.bottom + height + 12 > window.innerHeight && box.top - height - 12 > 0);
  }, [open]);

  // The focused month keeps the keyboard focus as it moves, also into another year.
  useEffect(() => {
    if (!open || !focusing.current) return;
    popover.current
      ?.querySelector<HTMLButtonElement>(`[data-month="${monthValue(focused)}"]`)
      ?.focus({ preventScroll: true });
  }, [open, focused]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  const year = focused.getFullYear();
  const moveYear = (years: number) => {
    focusing.current = false;
    setFocused((month) => clamp(addMonths(month, years * 12)));
  };

  function keyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (!(event.target as HTMLElement).dataset.month) return;
    const side = inlineSign();
    const months = {
      ArrowLeft: -side,
      ArrowRight: side,
      ArrowUp: -3,
      ArrowDown: 3,
      PageUp: -12,
      PageDown: 12,
    }[event.key];
    if (!months) return;
    event.preventDefault();
    focusing.current = true;
    setFocused(clamp(addMonths(focused, months)));
  }

  const shown = date(value, { year: "numeric", month: "long" });
  const current = monthValue(new Date());
  return (
    <span className="day-picker" ref={root}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${label}: ${shown}`}
        className="day-picker__trigger"
        id={id}
        onClick={() => (open ? close(false) : show())}
        ref={trigger}
        type="button"
      >
        <span>{shown}</span>
        <CalendarBlankIcon aria-hidden="true" size={16} />
      </button>
      {open ? (
        <div
          aria-label={String(year)}
          className={`day-picker__popover${above ? " day-picker__popover--above" : ""}`}
          onKeyDown={keyDown}
          ref={popover}
          role="dialog"
        >
          <div className="day-picker__month">
            <button
              aria-label={t("statisticsCards.previousYear")}
              disabled={year <= min.getFullYear()}
              onClick={() => moveYear(-1)}
              type="button"
            >
              <CaretLeftIcon aria-hidden="true" className="flip-rtl" size={14} weight="bold" />
            </button>
            <strong aria-live="polite">{date(focused, { year: "numeric" })}</strong>
            <button
              aria-label={t("statisticsCards.nextYear")}
              disabled={year >= max.getFullYear()}
              onClick={() => moveYear(1)}
              type="button"
            >
              <CaretRightIcon aria-hidden="true" className="flip-rtl" size={14} weight="bold" />
            </button>
          </div>
          <div className="day-picker__months">
            {Array.from({ length: 12 }, (_, index) => {
              const month = new Date(year, index, 1);
              const key = monthValue(month);
              const chosen = key === monthValue(value);
              return (
                <button
                  aria-label={date(month, { year: "numeric", month: "long" })}
                  aria-pressed={chosen}
                  className={[
                    "day-picker__day",
                    key === current ? "day-picker__day--today" : "",
                    chosen ? "day-picker__day--chosen" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-month={key}
                  disabled={key < minKey || key > maxKey}
                  key={key}
                  onClick={() => {
                    close(true);
                    if (!chosen) onChoose(month);
                  }}
                  tabIndex={key === monthValue(focused) ? 0 : -1}
                  type="button"
                >
                  {date(month, { month: "short" })}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </span>
  );
}

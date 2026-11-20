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

/** A local day as `YYYY-MM-DD`. */
export function dayValue(day: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

function parseDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return dayValue(day) === value ? day : null;
}

const addDays = (day: Date, days: number) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate() + days);

/** The same day of another month, or that month's last day when it is shorter. */
function addMonths(day: Date, months: number): Date {
  const last = new Date(day.getFullYear(), day.getMonth() + months + 1, 0).getDate();
  return new Date(day.getFullYear(), day.getMonth() + months, Math.min(day.getDate(), last));
}

/**
 * A day field: a button showing the day in the interface's language that opens a month
 * calendar under it (or above it, without room below). The arrows move by a day or a week,
 * Page Up and Page Down by a month, Home and End to the week's ends; Enter or a click chooses,
 * Escape or a click elsewhere closes. Days outside `min`–`max` cannot be chosen.
 */
export function DayPicker({
  id,
  labelledBy,
  value,
  min,
  max,
  empty,
  onChoose,
}: {
  id: string;
  /** The field's label, read with the day shown. */
  labelledBy?: string;
  /** The day shown, `YYYY-MM-DD`, or empty for none. */
  value: string;
  min: string;
  max: string;
  /** Shown while no day is. */
  empty: string;
  onChoose: (value: string) => void;
}) {
  const { t, date } = useI18n();
  const chosen = parseDay(value);
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const [focused, setFocused] = useState<Date>(() => chosen ?? parseDay(max) ?? new Date());
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const focusing = useRef(false);

  const clamp = (day: Date) => {
    const key = dayValue(day);
    return key < min ? parseDay(min)! : key > max ? parseDay(max)! : day;
  };
  const show = () => {
    setFocused(clamp(chosen ?? parseDay(max) ?? new Date()));
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

  // The focused day keeps the keyboard focus as it moves, also into another month.
  useEffect(() => {
    if (!open || !focusing.current) return;
    popover.current
      ?.querySelector<HTMLButtonElement>(`[data-day="${dayValue(focused)}"]`)
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

  const month = new Date(focused.getFullYear(), focused.getMonth(), 1);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  // Monday first, as the activity calendar.
  const leading = (month.getDay() + 6) % 7;
  const today = dayValue(new Date());
  const minMonth = min.slice(0, 7);
  const maxMonth = max.slice(0, 7);
  const monthKey = dayValue(month).slice(0, 7);

  const moveMonth = (months: number) => {
    focusing.current = false;
    setFocused((day) => clamp(addMonths(day, months)));
  };

  function keyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      // Closes the calendar, not the dialog it is in.
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (!(event.target as HTMLElement).dataset.day) return;
    const side = inlineSign();
    const weekday = (focused.getDay() + 6) % 7;
    const next = {
      ArrowLeft: () => addDays(focused, -side),
      ArrowRight: () => addDays(focused, side),
      ArrowUp: () => addDays(focused, -7),
      ArrowDown: () => addDays(focused, 7),
      PageUp: () => addMonths(focused, -1),
      PageDown: () => addMonths(focused, 1),
      Home: () => addDays(focused, -weekday),
      End: () => addDays(focused, 6 - weekday),
    }[event.key];
    if (!next) return;
    event.preventDefault();
    focusing.current = true;
    setFocused(clamp(next()));
  }

  const label = chosen ? date(chosen, { dateStyle: "medium" }) : empty;
  return (
    <span className="day-picker" ref={root}>
      <button
        aria-expanded={open}
        aria-labelledby={labelledBy ? `${labelledBy} ${id}-value` : undefined}
        aria-haspopup="dialog"
        className="day-picker__trigger"
        id={id}
        onClick={() => (open ? close(false) : show())}
        ref={trigger}
        type="button"
      >
        <span id={`${id}-value`}>{label}</span>
        <CalendarBlankIcon aria-hidden="true" size={16} />
      </button>
      {open ? (
        <div
          aria-label={date(month, { year: "numeric", month: "long" })}
          className={`day-picker__popover${above ? " day-picker__popover--above" : ""}`}
          onKeyDown={keyDown}
          ref={popover}
          role="dialog"
        >
          <div className="day-picker__month">
            <button
              aria-label={t("statisticsCards.previousMonth")}
              disabled={monthKey <= minMonth}
              onClick={() => moveMonth(-1)}
              type="button"
            >
              <CaretLeftIcon aria-hidden="true" className="flip-rtl" size={14} weight="bold" />
            </button>
            <strong aria-live="polite">{date(month, { year: "numeric", month: "long" })}</strong>
            <button
              aria-label={t("statisticsCards.nextMonth")}
              disabled={monthKey >= maxMonth}
              onClick={() => moveMonth(1)}
              type="button"
            >
              <CaretRightIcon aria-hidden="true" className="flip-rtl" size={14} weight="bold" />
            </button>
          </div>
          <div className="day-picker__grid">
            {Array.from({ length: 7 }, (_, index) => (
              <span aria-hidden="true" className="day-picker__weekday" key={`weekday-${index}`}>
                {/* 2024-01-01 was a Monday. */}
                {date(new Date(2024, 0, 1 + index), { weekday: "narrow" })}
              </span>
            ))}
            {Array.from({ length: leading }, (_, index) => (
              <span key={`blank-${index}`} />
            ))}
            {Array.from({ length: daysInMonth }, (_, index) => {
              const day = new Date(month.getFullYear(), month.getMonth(), index + 1);
              const key = dayValue(day);
              const isFocused = key === dayValue(focused);
              return (
                <button
                  aria-label={date(day, { dateStyle: "full" })}
                  aria-pressed={key === value}
                  className={[
                    "day-picker__day",
                    key === today ? "day-picker__day--today" : "",
                    key === value ? "day-picker__day--chosen" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-day={key}
                  disabled={key < min || key > max}
                  key={key}
                  onClick={() => {
                    close(true);
                    if (key !== value) onChoose(key);
                  }}
                  tabIndex={isFocused ? 0 : -1}
                  type="button"
                >
                  {index + 1}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </span>
  );
}

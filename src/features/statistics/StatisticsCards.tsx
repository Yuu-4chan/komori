import { i18n, useI18n, type MessageKey } from "../../i18n/i18n";
import {
  ArrowCounterClockwiseIcon,
  BookOpenTextIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  CheckCircleIcon,
  DeviceMobileIcon,
  MagnifyingGlassIcon,
  MonitorIcon,
  PencilSimpleIcon,
  TranslateIcon,
} from "@phosphor-icons/react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { DialogCaption } from "../../components/layout/WindowControls";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { useBackdropDismiss } from "../../components/ui/backdropDismiss";

import { BookCover } from "../library/BookCover";
import { DayPicker, dayValue, finishedDayTime } from "./DayPicker";
import { setBookCompletedDate, type LibraryBook } from "../library/libraryApi";
import {
  bookTitle,
  progressLabel,
  progressPercent,
  type LibraryReadingStatus,
} from "../library/libraryView";
import { formatDuration } from "./readingSession";
import {
  dayKey,
  speed,
  startOfMonth,
  type ActivitySummary,
  type BookActivity,
  type BookFinish,
  type CalendarDay,
  type LanguageShare,
} from "./statistics";
import { setBookFinishedDate, type LibraryKanji, type StoredReadingSession } from "./statisticsApi";
import { amount } from "../../i18n/amounts";
import { inlineSign } from "../../i18n/direction";

/** Whole numbers in the interface language. */
export const numbers = { format: (value: number) => i18n().number(value) };
const dayTitle = (date: Date) =>
  i18n().date(date, { month: "short", day: "numeric", year: "numeric" });
const dayLabel = (date: Date) => i18n().date(date, { month: "long", day: "numeric" });

export const formatMonth = (date: Date) => i18n().date(date, { month: "long", year: "numeric" });
export const formatCompact = (value: number) => i18n().compact(value, 2);

function unitAmount(unit: BookActivity["unit"], units: number): string {
  return amount(unit, units);
}

export function SectionHeading({
  id,
  title,
  description,
}: {
  id?: string;
  title: string;
  description: string;
}) {
  return (
    <div className="statistics-section-heading">
      <h2 id={id}>{title}</h2>
      <span>{description}</span>
    </div>
  );
}

export function MetricCard({
  icon,
  value,
  label,
  note,
  tone,
}: {
  icon: ReactNode;
  value: string;
  label: string;
  note: string;
  tone: "blue" | "green" | "gold" | "violet";
}) {
  return (
    <article className="statistics-metric">
      <span className={`statistics-metric__icon statistics-metric__icon--${tone}`}>{icon}</span>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
        <small title={note}>{note}</small>
      </div>
    </article>
  );
}

export function OverviewCard({
  icon,
  value,
  label,
  note,
}: {
  icon: ReactNode;
  value: string;
  label: string;
  note: string;
}) {
  return (
    <article className="statistics-metric overview-card">
      <span className="statistics-metric__icon">{icon}</span>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
        <small title={note}>{note}</small>
      </div>
    </article>
  );
}

// 2024-01-01 was a Monday; the week starts there.
const weekdays = () =>
  Array.from({ length: 7 }, (_, index) =>
    i18n().date(new Date(2024, 0, 1 + index), { weekday: "short" }),
  );

/** The month's days, Monday first, shaded by reading time; hover, focus or a click picks one. */
export function ActivityCalendar({
  days,
  selected,
  today,
  onSelect,
}: {
  days: CalendarDay[];
  selected: string;
  today: string;
  onSelect: (key: string) => void;
}) {
  const leading = days.length ? (days[0].date.getDay() + 6) % 7 : 0;
  const { t } = useI18n();
  // The month is one Tab stop, the inspected day (or today, or the 1st); the arrows move by a
  // day or a week, Home and End to the month's ends.
  const keys = days.map((day) => dayKey(day.date));
  const stop = keys.includes(selected) ? selected : keys.includes(today) ? today : keys[0];
  function move(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const index = keys.indexOf((event.target as HTMLElement).dataset.day ?? "");
    if (index < 0) return;
    const side = inlineSign();
    const next = {
      ArrowLeft: index - side,
      ArrowRight: index + side,
      ArrowUp: index - 7,
      ArrowDown: index + 7,
      Home: 0,
      End: keys.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    if (next < 0 || next >= keys.length) return;
    event.currentTarget.querySelector<HTMLElement>(`[data-day="${keys[next]}"]`)?.focus();
  }
  return (
    <div className="statistics-calendar">
      <div className="statistics-calendar__weekdays" aria-hidden="true">
        {weekdays().map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="statistics-calendar__grid" onKeyDown={move}>
        {Array.from({ length: leading }, (_, index) => (
          <span key={`blank-${index}`} className="statistics-calendar__blank" />
        ))}
        {days.map((day) => {
          const key = dayKey(day.date);
          const minutes = Math.floor(day.summary.activeMs / 60000);
          return (
            <button
              aria-label={t("statisticsCards.dayLabel", {
                date: dayLabel(day.date),
                reading: day.summary.sessions
                  ? t("statisticsCards.timeRead", { time: formatDuration(day.summary.activeMs) })
                  : t("statisticsCards.noReadingLower"),
              })}
              aria-pressed={key === selected}
              data-day={key}
              className={[
                "statistics-calendar__day",
                `statistics-calendar__day--${day.level}`,
                key === selected ? "statistics-calendar__day--active" : "",
                key === today ? "statistics-calendar__day--today" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              key={key}
              onClick={() => onSelect(key)}
              onFocus={() => onSelect(key)}
              // An uncovered calendar cell gets mouseenter when a modal closes. Only
              // deliberate pointer movement should change the inspected day then.
              onMouseMove={() => onSelect(key)}
              tabIndex={key === stop ? 0 : -1}
              title={minutes ? t("statisticsCards.minutes", { count: minutes }) : undefined}
              type="button"
            >
              <span>{day.date.getDate()}</span>
              <i aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <div className="statistics-calendar__legend" aria-hidden="true">
        <span>{t("statisticsCards.less")}</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <i
            className={`statistics-calendar__legend-dot statistics-calendar__legend-dot--${level}`}
            key={level}
          />
        ))}
        <span>{t("statisticsCards.more")}</span>
      </div>
    </div>
  );
}

/** This device's name in Statistics. */
const ownDevice =
  import.meta.env.TAURI_ENV_PLATFORM === "android" ? "sync.thisPhone" : "statistics.thisPc";
/** Phones read on a PC, and the PC on a phone. */
const OwnIcon = import.meta.env.TAURI_ENV_PLATFORM === "android" ? DeviceMobileIcon : MonitorIcon;
const OtherIcon = import.meta.env.TAURI_ENV_PLATFORM === "android" ? MonitorIcon : DeviceMobileIcon;

export function DailyDetail({
  date,
  summary,
  deviceName,
}: {
  date: Date;
  summary: ActivitySummary;
  /** The name of another device that read, by its ID. */
  deviceName: (id: string) => string | undefined;
}) {
  const { t, tp } = useI18n();
  const amounts = [
    summary.characters > 0 ? amount("characters", summary.characters) : null,
    summary.words > 0 ? amount("words", summary.words) : null,
  ].filter(Boolean);
  return (
    <aside className="statistics-day-detail" aria-label={t("statisticsCards.dayDetails")}>
      <span className="statistics-day-detail__date">{dayTitle(date)}</span>
      <strong>
        {summary.sessions
          ? t("statisticsCards.timeReading", { time: formatDuration(summary.activeMs) })
          : t("statisticsCards.restDay")}
      </strong>
      <div className="statistics-day-detail__primary">
        <span>{amounts.length ? amounts.join(" · ") : t("statisticsCards.noReading")}</span>
        <span>{tp("statisticsSettings.sessions", summary.sessions)}</span>
      </div>
      {summary.devices.length > 1 ? (
        <ul className="statistics-day-detail__devices" aria-label={t("statistics.byDevice")}>
          {summary.devices.map(({ device, activeMs }) => {
            const Icon = device === null ? OwnIcon : OtherIcon;
            return (
              <li key={device ?? ""}>
                <Icon aria-hidden="true" />
                <span>
                  {device === null
                    ? t(ownDevice)
                    : (deviceName(device) ?? t("statistics.otherDevice"))}
                </span>
                <strong>{formatDuration(activeMs)}</strong>
              </li>
            );
          })}
        </ul>
      ) : null}
      <dl className="statistics-day-detail__rows">
        <div>
          <dt>{t("statistics.readingTime")}</dt>
          <dd>{t("statisticsCards.minutes", { count: Math.floor(summary.activeMs / 60000) })}</dd>
        </div>
        <div>
          <dt>{t("statisticsCards.charactersLabel")}</dt>
          <dd>{numbers.format(summary.characters)}</dd>
        </div>
        <div>
          <dt>{t("statisticsCards.wordsLabel")}</dt>
          <dd>{numbers.format(summary.words)}</dd>
        </div>
      </dl>
    </aside>
  );
}

/** The books read on the chosen day, most read first. */
export function DailyBooks({
  date,
  books,
  library,
  onEdit,
}: {
  date: Date;
  books: BookActivity[];
  library: ReadonlyMap<string, LibraryBook>;
  onEdit: (activity: BookActivity) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const available = books.filter((book) => library.has(book.bookId));
  const shown = showAll ? available : available.slice(0, 3);
  const { t } = useI18n();
  return (
    <aside className="statistics-day-book" aria-label={t("statisticsCards.booksRead")}>
      <span className="statistics-day-book__eyebrow">
        {t(shown.length > 1 ? "statisticsCards.booksRead" : "statisticsCards.bookRead")}
      </span>
      {shown.length ? (
        <ul className="statistics-day-book__list">
          {shown.map((activity) => {
            const book = library.get(activity.bookId)!;
            return (
              <li
                className="statistics-day-book__content"
                key={activity.bookId}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
                  onEdit(activity);
                }}
              >
                <BookCover book={book} size="small" />
                <div className="statistics-day-book__copy">
                  <strong title={bookTitle(book)}>{bookTitle(book)}</strong>
                  {book.author ? <span>{book.author}</span> : null}
                  <small>
                    {unitAmount(activity.unit, activity.unitsRead)} ·{" "}
                    {formatDuration(activity.activeMs)}
                  </small>
                </div>
                <button
                  className="statistics-day-book__edit"
                  type="button"
                  aria-label={t("statisticsCards.editFor", { title: bookTitle(book) })}
                  title={t("statisticsCards.editTitle")}
                  onClick={() => onEdit(activity)}
                >
                  <PencilSimpleIcon size={15} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="statistics-day-book__empty">
          <BookOpenTextIcon aria-hidden="true" size={22} weight="duotone" />
          <strong>{t("statisticsCards.noBookRead")}</strong>
          <span>{t("statisticsCards.nothingRead", { date: dayLabel(date) })}</span>
        </div>
      )}
      {available.length > 3 ? (
        <button
          className="character-show-all"
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          <span>
            {showAll
              ? t("statisticsCards.showPreview")
              : t("statisticsCards.showAllBooks", { count: available.length })}
          </span>
          {showAll ? (
            <CaretUpIcon aria-hidden="true" size={16} />
          ) : (
            <CaretDownIcon aria-hidden="true" size={16} />
          )}
        </button>
      ) : null}
    </aside>
  );
}

/** How many covers show before Show all. */
const BOOKS_PREVIEW = 16;

/**
 * Each book read in the range as its cover, most time first; choosing one opens its own
 * totals over the range in a popup.
 */
export function BookTotals({
  books,
  library,
  finishes = noFinishes,
  onLibraryChanged,
  onSessionsChanged,
}: {
  books: BookActivity[];
  library: ReadonlyMap<string, LibraryBook>;
  /** When each finished book was finished. */
  finishes?: ReadonlyMap<string, BookFinish>;
  /** Every session, after a book's finished date changed. */
  onSessionsChanged?: (sessions: StoredReadingSession[]) => void;
  /** After the finished date of a book with no sessions changed in the Library. */
  onLibraryChanged?: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<BookActivity | null>(null);
  const { t } = useI18n();
  const available = books.filter((book) => library.has(book.bookId));
  const shown = showAll ? available : available.slice(0, BOOKS_PREVIEW);
  return (
    <>
      <ul className="statistics-books">
        {shown.map((activity) => {
          const book = library.get(activity.bookId)!;
          return (
            <li key={activity.bookId}>
              <button
                aria-haspopup="dialog"
                aria-label={bookTitle(book)}
                className="statistics-books__cover"
                onClick={() => setOpen(activity)}
                title={bookTitle(book)}
                type="button"
              >
                <BookCover book={book} />
              </button>
            </li>
          );
        })}
      </ul>
      {available.length > BOOKS_PREVIEW ? (
        <button
          className="character-show-all"
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          <span>
            {showAll
              ? t("statisticsCards.showPreview")
              : t("statisticsCards.showAllBooks", { count: available.length })}
          </span>
          {showAll ? (
            <CaretUpIcon aria-hidden="true" size={16} />
          ) : (
            <CaretDownIcon aria-hidden="true" size={16} />
          )}
        </button>
      ) : null}
      {open ? (
        <BookStatisticsDialog
          activity={open}
          book={library.get(open.bookId)!}
          finish={finishes.get(open.bookId) ?? null}
          onClose={() => setOpen(null)}
          onLibraryChanged={onLibraryChanged}
          onSessionsChanged={onSessionsChanged}
        />
      ) : null}
    </>
  );
}

const noFinishes: ReadonlyMap<string, BookFinish> = new Map();

/** The `YYYY-MM-DD` of the local day of `time`. */
export { finishedDayTime };

export function dateValue(time: number): string {
  return dayValue(new Date(time));
}

/**
 * The day a book was finished, changed in place: a chosen day replaces the day its sessions
 * read it to the end, and resetting goes back to that day. A book completed without a session
 * has nowhere to keep a day, so it shows when the Library completed it.
 */
function FinishedDate({
  bookId,
  keptOn,
  finish,
  onLibraryChanged,
  onSessionsChanged,
}: {
  bookId: string;
  /** Where a chosen day is kept: the book's sessions, its Library progress, or nowhere here. */
  keptOn: "sessions" | "library" | null;
  finish: BookFinish | null;
  onLibraryChanged?: () => void;
  onSessionsChanged?: (sessions: StoredReadingSession[]) => void;
}) {
  const { t, date } = useI18n();
  const id = useId();
  const shown = finish ? dateValue(finish.at) : "";
  const [failed, setFailed] = useState(false);
  const saving = useRef(0);
  const save = async (finishedAt: number | null) => {
    const version = ++saving.current;
    setFailed(false);
    try {
      if (keptOn === "library") {
        if (finishedAt === null || !(await setBookCompletedDate(bookId, finishedAt)))
          throw new Error("not completed");
        if (version === saving.current) onLibraryChanged?.();
        return;
      }
      const sessions = await setBookFinishedDate(bookId, finishedAt);
      if (version === saving.current) onSessionsChanged?.(sessions);
    } catch {
      if (version === saving.current) setFailed(true);
    }
  };
  if (!keptOn)
    return (
      <div className="statistics-book-dialog__finished">
        <span>{t("statisticsCards.finishedDate")}</span>
        <span>
          {finish
            ? date(new Date(finish.at), { dateStyle: "medium" })
            : t("statisticsCards.finishedNotSet")}
        </span>
      </div>
    );
  return (
    <div className="statistics-book-dialog__finished">
      <label htmlFor={id} id={`${id}-label`}>
        {t("statisticsCards.finishedDate")}
      </label>
      <span>
        <DayPicker
          empty={t("statisticsCards.finishedNotSet")}
          id={id}
          labelledBy={`${id}-label`}
          max={dateValue(Date.now())}
          min="2000-01-01"
          onChoose={(next) => {
            const time = finishedDayTime(next);
            if (time !== null) void save(time);
          }}
          value={shown}
        />
        {finish?.set && keptOn === "sessions" ? (
          <IconButton
            compact
            label={t("statisticsCards.resetFinishedDate")}
            onClick={() => void save(null)}
            quiet
          >
            <ArrowCounterClockwiseIcon aria-hidden="true" size={16} />
          </IconButton>
        ) : null}
      </span>
      {failed ? <small role="alert">{t("statisticsCards.finishedDateFailed")}</small> : null}
    </div>
  );
}

/** A finished book's totals over all its sessions: time read, sessions, amount read, speed, days and last read. */
function BookStatisticsDialog({
  activity,
  book,
  finish,
  onClose,
  onLibraryChanged,
  onSessionsChanged,
}: {
  activity: BookActivity;
  book: LibraryBook;
  finish: BookFinish | null;
  onClose: () => void;
  onLibraryChanged?: () => void;
  onSessionsChanged?: (sessions: StoredReadingSession[]) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { t, date } = useI18n();
  const backdrop = useBackdropDismiss(onClose);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement as HTMLElement | null;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    dialog.querySelector<HTMLButtonElement>("[data-dialog-cancel]")?.focus();
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      opener?.focus();
    };
  }, []);
  const characters = activity.unit === "characters";
  const pace = speed(activity.unitsRead, activity.activeMs);
  const values: [string, string][] = [
    [t("statistics.readingTime"), formatDuration(activity.activeMs)],
    [t("statistics.sessions"), numbers.format(activity.sessions)],
    [
      t(characters ? "statistics.charactersRead" : "statistics.wordsRead"),
      numbers.format(activity.unitsRead),
    ],
    [
      t(characters ? "statistics.avgChars" : "statistics.avgWords"),
      pace === null ? "—" : numbers.format(pace),
    ],
    [t("statisticsCards.daysRead"), numbers.format(activity.days)],
    [
      t("libraryToolbar.cardLastRead"),
      date(new Date(activity.lastReadAt), { dateStyle: "medium" }),
    ],
  ];
  return createPortal(
    <dialog
      aria-labelledby={titleId}
      className="confirm-dialog statistics-book-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={backdrop.onClick}
      onPointerDown={backdrop.onPointerDown}
      ref={dialogRef}
    >
      <DialogCaption />
      <div className="confirm-dialog__content">
        <div className="statistics-book-dialog__book">
          <BookCover book={book} size="small" />
          <div>
            <h2 id={titleId}>{bookTitle(book)}</h2>
            {book.author ? <span>{book.author}</span> : null}
            {/* A removed book's sessions keep no progress. */}
            {book.fileName ? <small>{progressLabel(book)}</small> : null}
          </div>
        </div>
        <dl className="statistics-book-dialog__values">
          {values.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <FinishedDate
          bookId={activity.bookId}
          // A PC's book shown on the phone keeps its day on the PC.
          keptOn={activity.sessions > 0 ? "sessions" : book.fromPc ? null : "library"}
          onLibraryChanged={onLibraryChanged}
          finish={finish}
          onSessionsChanged={onSessionsChanged}
        />
        <div className="confirm-dialog__actions">
          <Button data-dialog-cancel onClick={onClose} tone="secondary">
            {t("common.close")}
          </Button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}

/** The month switcher above the calendar; the next month stops at the current one. */
export function MonthSwitcher({
  month,
  first,
  last,
  onChange,
}: {
  month: Date;
  first: Date;
  last: Date;
  onChange: (month: Date) => void;
}) {
  const previous = new Date(month.getFullYear(), month.getMonth() - 1, 1);
  const next = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const { t } = useI18n();
  return (
    <div className="statistics-month-switcher">
      <button
        aria-label={t("statisticsCards.previousMonth")}
        disabled={previous < startOfMonth(first)}
        onClick={() => onChange(previous)}
        type="button"
      >
        <CaretLeftIcon aria-hidden="true" className="flip-rtl" size={16} weight="bold" />
      </button>
      <strong aria-live="polite">{formatMonth(month)}</strong>
      <button
        aria-label={t("statisticsCards.nextMonth")}
        disabled={next > last}
        onClick={() => onChange(next)}
        type="button"
      >
        <CaretRightIcon aria-hidden="true" className="flip-rtl" size={16} weight="bold" />
      </button>
    </div>
  );
}

const languageColors = ["blue", "pink", "violet", "teal"] as const;

export function LanguageBreakdown({
  cjk,
  other,
}: {
  cjk: LanguageShare[];
  other: LanguageShare[];
}) {
  const total = cjk.reduce((sum, share) => sum + share.characters, 0);
  let start = 0;
  const stops = cjk.map((share, index) => {
    const end = total ? start + (share.characters / total) * 100 : start;
    const stop = `var(--stat-${languageColors[index % languageColors.length]}) ${start}% ${end}%`;
    start = end;
    return stop;
  });
  const donut: CSSProperties = {
    background: total ? `conic-gradient(${stops.join(", ")})` : "var(--surface-subtle)",
  };
  const otherBooks = other.reduce((sum, share) => sum + share.books, 0);
  const { t, tp } = useI18n();
  return (
    <article className="statistics-card statistics-language-card">
      <div className="statistics-card__heading">
        <div>
          <h2>{t("statisticsCards.languages")}</h2>
          <span>{t("statisticsCards.languagesHint")}</span>
        </div>
        <TranslateIcon aria-hidden="true" size={19} />
      </div>
      {cjk.length || other.length ? (
        <div className="language-breakdown">
          <div
            className="language-donut"
            style={donut}
            role="img"
            aria-label={t("statisticsCards.cjkCharacters", { count: total })}
          >
            <div>
              <strong>{formatCompact(total)}</strong>
              <span>{t("statisticsCards.cjkCh")}</span>
            </div>
          </div>
          <div className="language-breakdown__legend">
            {cjk.map((share, index) => (
              <LanguageRow
                color={languageColors[index % languageColors.length]}
                key={share.key}
                label={share.label}
                value={t("statisticsCards.languageShare", {
                  count: formatCompact(share.characters),
                  percent: total ? Math.round((share.characters / total) * 100) : 0,
                })}
              />
            ))}
            {other.slice(0, 4).map((share, index) => (
              <LanguageRow
                color="gold"
                key={share.key || "unknown"}
                label={share.label}
                separate={index === 0}
                value={tp("librarySummary.books", share.books)}
              />
            ))}
            {other.length > 4 ? (
              <LanguageRow
                color="gold"
                label={t("statisticsCards.moreLanguages", { count: other.length - 4 })}
                value={tp(
                  "librarySummary.books",
                  otherBooks - other.slice(0, 4).reduce((sum, share) => sum + share.books, 0),
                )}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <p className="statistics-card__empty">{t("statisticsCards.noBooks")}</p>
      )}
    </article>
  );
}

function LanguageRow({
  color,
  label,
  value,
  separate = false,
}: {
  color: string;
  label: string;
  value: string;
  separate?: boolean;
}) {
  return (
    <div className={separate ? "language-row language-row--separate" : "language-row"}>
      <span className={`language-row__dot language-row__dot--${color}`} />
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

const statusLabels: Record<LibraryReadingStatus, MessageKey> = {
  completed: "libraryCard.completed",
  reading: "statisticsCards.inProgress",
  "not-started": "libraryCard.notStarted",
};

/** Dots the completion overview shows before Show all, so a large Library keeps the card short. */
export const COMPLETION_PREVIEW = 300;

export function CompletionOverview({
  books,
}: {
  books: { book: LibraryBook; status: LibraryReadingStatus }[];
}) {
  const completed = books.filter((entry) => entry.status === "completed").length;
  const reading = books.filter((entry) => entry.status === "reading").length;
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? books : books.slice(0, COMPLETION_PREVIEW);
  const { t } = useI18n();
  return (
    <article className="statistics-card completion-card">
      <div className="statistics-card__heading">
        <div>
          <h2>{t("statisticsCards.completion")}</h2>
          <span>{t("statisticsCards.completionHint", { completed, count: books.length })}</span>
        </div>
        <CheckCircleIcon aria-hidden="true" size={19} />
      </div>
      {books.length ? (
        <div
          className="completion-dots"
          role="img"
          aria-label={t("statisticsCards.completionLabel", {
            completed,
            reading,
            notStarted: books.length - completed - reading,
          })}
        >
          {shown.map(({ book, status }) => (
            <span
              className={`completion-dot completion-dot--${status}`}
              key={book.id}
              title={`${bookTitle(book)}: ${t(statusLabels[status])}${
                status === "reading" ? ` (${i18n().percentLabel(progressPercent(book))})` : ""
              }`}
            />
          ))}
        </div>
      ) : (
        <p className="statistics-card__empty">{t("statisticsCards.noBooks")}</p>
      )}
      {books.length > COMPLETION_PREVIEW ? (
        <button
          aria-expanded={showAll}
          className="character-show-all"
          onClick={() => setShowAll((current) => !current)}
          type="button"
        >
          <span>
            {showAll
              ? t("statisticsCards.showPreview")
              : t("statisticsCards.showAllBooks", { count: books.length })}
          </span>
          {showAll ? (
            <CaretUpIcon aria-hidden="true" size={16} />
          ) : (
            <CaretDownIcon aria-hidden="true" size={16} />
          )}
        </button>
      ) : null}
      <div className="completion-legend" aria-hidden="true">
        <span>
          <i className="is-complete" />
          {t("libraryCard.completed")}
        </span>
        <span>
          <i className="is-progress" />
          {t("statisticsCards.inProgress")}
        </span>
        <span>
          <i />
          {t("libraryCard.notStarted")}
        </span>
      </div>
    </article>
  );
}

const previewSize = 48;

/** The kanji counted in the Library's Japanese or Chinese books, completed books' marked. */
export function CharacterExplorer({
  groups,
  failed,
  onRetry,
  onOpen,
}: {
  groups: LibraryKanji[] | null;
  failed: boolean;
  onRetry: () => void;
  onOpen: (character: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<"ja" | "zh" | null>(null);
  const [showAll, setShowAll] = useState(false);
  const largest = groups?.slice().sort((a, b) => b.kanji.length - a.kanji.length)[0]?.language;
  const script = chosen ?? largest ?? "ja";
  const group = groups?.find((entry) => entry.language === script) ?? null;
  const filtered = useMemo(() => {
    const wanted = new Set(Array.from(query.trim()));
    const all = group?.kanji ?? [];
    return wanted.size ? all.filter((entry) => wanted.has(entry.character)) : all;
  }, [group, query]);
  const shown = showAll ? filtered : filtered.slice(0, previewSize);
  const { t, tp } = useI18n();
  return (
    <article className="statistics-card character-card">
      <div className="statistics-card__heading character-card__heading">
        <div>
          <h2>{t("statisticsCards.explorer")}</h2>
          <span>{t("statisticsCards.explorerHint")}</span>
        </div>
        <label className="character-search">
          <MagnifyingGlassIcon aria-hidden="true" size={15} />
          <input
            aria-label={t("statisticsCards.searchCharacters")}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("statisticsCards.searchPlaceholder")}
            spellCheck={false}
            value={query}
          />
        </label>
      </div>
      <div className="character-tabs" role="group" aria-label={t("statisticsCards.script")}>
        {(["ja", "zh"] as const).map((language) => (
          <button
            aria-pressed={script === language}
            className={script === language ? "character-tabs__active" : undefined}
            key={language}
            onClick={() => {
              setChosen(language);
              setShowAll(false);
            }}
            type="button"
          >
            {t(language === "ja" ? "statisticsCards.japanese" : "statisticsCards.chinese")}
          </button>
        ))}
      </div>
      <div className="character-card__legend" aria-hidden="true">
        <span>
          <i className="is-completed" />
          {t("statisticsCards.seenCompleted")}
        </span>
        <span>
          <i />
          {t("statisticsCards.present")}
        </span>
      </div>
      {failed ? (
        <div className="statistics-card__empty">
          <p>{t("statisticsCards.charactersFailed")}</p>
          <button className="character-show-all" onClick={onRetry} type="button">
            {t("common.tryAgain")}
          </button>
        </div>
      ) : !groups ? (
        <p className="statistics-card__empty" role="status">
          {t("statisticsCards.loadingCharacters")}
        </p>
      ) : !group?.kanji.length ? (
        <p className="statistics-card__empty">
          {t(script === "ja" ? "statisticsCards.noJapanese" : "statisticsCards.noChinese")}
        </p>
      ) : !filtered.length ? (
        <p className="statistics-card__empty">
          {t("statisticsCards.noMatch", { query: query.trim() })}
        </p>
      ) : (
        <>
          <div className="character-grid">
            {shown.map((entry) => {
              const books = tp("librarySummary.books", entry.books);
              return (
                <button
                  aria-label={t(
                    entry.completed ? "statisticsCards.kanjiCompleted" : "statisticsCards.kanji",
                    { character: entry.character, books },
                  )}
                  className={
                    entry.completed ? "character-tile character-tile--completed" : "character-tile"
                  }
                  key={entry.character}
                  onClick={() => onOpen(entry.character)}
                  title={t("statisticsCards.inBooks", { books })}
                  type="button"
                >
                  <strong lang={script}>{entry.character}</strong>
                  <span>{books}</span>
                </button>
              );
            })}
          </div>
          {filtered.length > previewSize ? (
            <button
              aria-expanded={showAll}
              className="character-show-all"
              onClick={() => setShowAll((current) => !current)}
              type="button"
            >
              <span>
                {showAll
                  ? t("statisticsCards.showPreview")
                  : t("statisticsCards.showAllCharacters", { count: filtered.length })}
              </span>
              {showAll ? (
                <CaretUpIcon aria-hidden="true" size={16} />
              ) : (
                <CaretDownIcon aria-hidden="true" size={16} />
              )}
            </button>
          ) : null}
        </>
      )}
    </article>
  );
}

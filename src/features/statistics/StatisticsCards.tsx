import { i18n, useI18n, type MessageKey } from "../../i18n/i18n";
import {
  BookOpenTextIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  CheckCircleIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  TranslateIcon,
} from "@phosphor-icons/react";
import { useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { BookCover } from "../library/BookCover";
import type { LibraryBook } from "../library/libraryApi";
import { bookTitle, progressPercent, type LibraryReadingStatus } from "../library/libraryView";
import { formatDuration } from "./readingSession";
import {
  dayKey,
  startOfMonth,
  type ActivitySummary,
  type BookActivity,
  type CalendarDay,
  type LanguageShare,
} from "./statistics";
import type { LibraryKanji } from "./statisticsApi";

/** Whole numbers in the interface language. */
export const numbers = { format: (value: number) => i18n().number(value) };
const dayTitle = (date: Date) =>
  i18n().date(date, { month: "short", day: "numeric", year: "numeric" });
const dayLabel = (date: Date) => i18n().date(date, { month: "long", day: "numeric" });

export const formatMonth = (date: Date) => i18n().date(date, { month: "long", year: "numeric" });
export const formatCompact = (value: number) => i18n().compact(value, 2);

function unitAmount(unit: BookActivity["unit"], units: number): string {
  const { t, tp } = i18n();
  return unit === "characters"
    ? t("statisticsCards.characters", { count: units })
    : tp("statisticsCards.words", units);
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
    const next = {
      ArrowLeft: index - 1,
      ArrowRight: index + 1,
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

export function DailyDetail({ date, summary }: { date: Date; summary: ActivitySummary }) {
  const { t, tp } = useI18n();
  const amounts = [
    summary.characters > 0 ? t("librarySummary.characters", { count: summary.characters }) : null,
    summary.words > 0 ? t("librarySummary.words", { count: summary.words }) : null,
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
          {showAll
            ? t("statisticsCards.showPreview")
            : t("statisticsCards.showAllBooks", { count: available.length })}
        </button>
      ) : null}
    </aside>
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
        <CaretLeftIcon aria-hidden="true" size={16} weight="bold" />
      </button>
      <strong aria-live="polite">{formatMonth(month)}</strong>
      <button
        aria-label={t("statisticsCards.nextMonth")}
        disabled={next > last}
        onClick={() => onChange(next)}
        type="button"
      >
        <CaretRightIcon aria-hidden="true" size={16} weight="bold" />
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
                status === "reading" ? ` (${progressPercent(book)}%)` : ""
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

export function ReadingVolumeCard({
  type,
  icon,
  title,
  description,
  value,
  unit,
  note,
  rows,
  library,
  empty,
}: {
  type: "cjk" | "western";
  icon: ReactNode;
  title: string;
  description: string;
  value: number;
  unit: string;
  note: string;
  rows: BookActivity[];
  library: ReadonlyMap<string, LibraryBook>;
  empty: string;
}) {
  const shown = rows.filter((row) => library.has(row.bookId)).slice(0, 3);
  const { t } = useI18n();
  return (
    <article className={`statistics-card reading-volume-card reading-volume-card--${type}`}>
      <div className="statistics-card__heading">
        <div>
          <h2>{title}</h2>
          <span>{description}</span>
        </div>
        {icon}
      </div>
      <div className="reading-volume-card__hero">
        <div>
          <strong>{numbers.format(value)}</strong>
          <span>{unit}</span>
        </div>
        <small>{note}</small>
      </div>
      {shown.length ? (
        <ul className="reading-volume-card__list">
          {shown.map((row) => {
            const book = library.get(row.bookId)!;
            const percent = progressPercent(book);
            return (
              <li className="reading-volume-row__item" key={row.bookId}>
                <div>
                  <strong title={bookTitle(book)}>{bookTitle(book)}</strong>
                  <span>
                    {t("statisticsCards.amountRead", {
                      amount: unitAmount(row.unit, row.unitsRead),
                    })}
                  </span>
                </div>
                <div
                  className="reading-volume-row__progress"
                  role="img"
                  aria-label={t("statisticsCards.percentOfBook", { percent })}
                >
                  <i>
                    <span style={{ width: `${percent}%` }} />
                  </i>
                  <strong>{percent}%</strong>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="statistics-card__empty">{empty}</p>
      )}
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

import {
  ArrowLeftIcon,
  BookOpenTextIcon,
  BooksIcon,
  CalendarBlankIcon,
  ChartBarIcon,
  CheckCircleIcon,
  ClockIcon,
  FileTextIcon,
  FlameIcon,
  GaugeIcon,
  TextAaIcon,
} from "@phosphor-icons/react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { i18n, useI18n } from "../i18n/i18n";
import { formattingLocale, type InterfaceLanguage } from "../i18n/languages";

import { MobileHeaderContext } from "../components/layout/mobileHeader";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { MenuButton } from "../components/ui/MenuButton";
import { useAppearance } from "../features/appearance/AppearanceProvider";
import { onLibraryDetailsUpdated, type LibraryBook } from "../features/library/libraryApi";
import { libraryCache } from "../features/library/libraryCache";
import { formatDuration } from "../features/statistics/readingSession";
import {
  DailyActivityEditor,
  type DailyEditTarget,
} from "../features/statistics/DailyActivityEditor";
import { DayPicker, dayValue, parseDay } from "../features/statistics/DayPicker";
import { MonthPicker } from "../features/statistics/MonthPicker";
import {
  addDays,
  bestStreakInMonth,
  calendarMonth,
  completionOrder,
  CUSTOM_RANGE_DAYS,
  currentStreak,
  dayKey,
  languageBreakdown,
  libraryCompletions,
  libraryOverview,
  rangePeriods,
  finishDates,
  speed,
  startOfMonth,
  summarize,
  type ActivitySummary,
  type StatisticsRange,
} from "../features/statistics/statistics";
import {
  listReadingDevices,
  listReadingSessions,
  type LibraryKanji,
  type ReadingDevice,
  type StoredReadingSession,
} from "../features/statistics/statisticsApi";
import { StatisticsSourceContext } from "../features/statistics/statisticsSource";
import {
  ActivityCalendar,
  BookTotals,
  CharacterExplorer,
  CompletionOverview,
  DailyBooks,
  DailyDetail,
  formatCompact,
  formatMonth,
  LanguageBreakdown,
  MetricCard,
  numbers,
  OverviewCard,
  SectionHeading,
} from "../features/statistics/StatisticsCards";

const rangeOptions = [
  { value: "today", label: "statistics.today", description: "statistics.todayHint" },
  { value: "month", label: "statistics.month", description: "statistics.monthHint" },
  { value: "custom", label: "statistics.custom", description: "statistics.customHint" },
  { value: "all", label: "statistics.all", description: "statistics.allHint" },
] as const;

type Loaded = {
  books: LibraryBook[];
  sessions: StoredReadingSession[];
  devices: ReadingDevice[];
};

export function StatisticsPage() {
  const navigate = useNavigate();
  const MobileHeader = useContext(MobileHeaderContext);
  const source = useContext(StatisticsSourceContext);
  const { statisticsEnabled } = useAppearance();
  const { t, tp, language } = useI18n();
  const [range, setRange] = useState<StatisticsRange>("month");
  const [data, setData] = useState<Loaded | "loading" | "failed">("loading");
  const [kanji, setKanji] = useState<LibraryKanji[] | null | "failed">(null);
  const [now] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState(() => dayKey(now));
  // The month a Month range shows and the days a Custom range spans (the last week at first).
  const [rangeMonth, setRangeMonth] = useState(() => startOfMonth(now));
  const [rangeDays, setRangeDays] = useState(() => ({
    from: dayValue(addDays(now, 1 - CUSTOM_RANGE_DAYS)),
    to: dayValue(now),
  }));
  const [edit, setEdit] = useState<DailyEditTarget | null>(null);
  const [editNotice, setEditNotice] = useState(false);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    const cached = libraryCache.books();
    setData((current) => (current === "failed" || !cached ? "loading" : current));
    try {
      const [books, sessions, devices] = await Promise.all([
        source.books(),
        listReadingSessions(),
        listReadingDevices().catch(() => []),
      ]);
      if (version !== loadVersion.current) return;
      setData({ books, sessions, devices });
    } catch {
      if (version === loadVersion.current) setData("failed");
    }
  }, [source]);
  const loadKanji = useCallback(async () => {
    setKanji(null);
    try {
      setKanji(await source.kanji());
    } catch {
      setKanji("failed");
    }
  }, [source]);
  useEffect(() => {
    void load();
    void loadKanji();
    // Counts read in the background (books imported before Komori counted them) arrive here.
    return onLibraryDetailsUpdated(() => {
      void load();
      void loadKanji();
    });
  }, [load, loadKanji]);

  const loaded = typeof data === "object" ? data : null;
  const devices = useMemo(
    () => new Map((loaded?.devices ?? []).map((device) => [device.id, device.name])),
    [loaded],
  );
  // Books removed from the Library keep their sessions, shown by the title they had; a book
  // only another device has is shown with that device's name.
  const library = useMemo(() => {
    const known = new Map((loaded?.books ?? []).map((book) => [book.id, book]));
    const readHere = new Set(
      (loaded?.sessions ?? []).filter((session) => !session.device).map((s) => s.bookId),
    );
    for (const session of loaded?.sessions ?? [])
      if (!known.has(session.bookId)) {
        const elsewhere = readHere.has(session.bookId)
          ? undefined
          : (devices.get(session.device ?? "") ?? i18n().t("statistics.otherDevice"));
        known.set(session.bookId, removedBook(session.bookId, session.bookTitle, elsewhere));
      }
    return known;
    // Removed books are named in the interface language.
  }, [loaded, devices, language]);
  const sessions = useMemo(() => loaded?.sessions ?? [], [loaded]);
  const periods = useMemo(
    () =>
      rangePeriods(range, now, {
        month: rangeMonth,
        from: parseDay(rangeDays.from) ?? undefined,
        to: parseDay(rangeDays.to) ?? undefined,
      }),
    [range, now, rangeMonth, rangeDays],
  );
  // Books the Library shows completed count as finished, even with no session reading them to the end.
  const completions = useMemo(
    () => libraryCompletions(loaded?.books ?? [], sessions),
    [loaded, sessions],
  );
  const summary = useMemo(
    () => summarize(sessions, periods.current, completions),
    [sessions, periods, completions],
  );
  const finishes = useMemo(() => finishDates(sessions, completions), [sessions, completions]);
  const previous = useMemo(
    () => (periods.previous ? summarize(sessions, periods.previous, completions) : null),
    [sessions, periods, completions],
  );
  // The daily calendar shows the range's month: a Month range's, a custom range's last day's, else
  // this one; the range is the page's one date.
  const month = useMemo(
    () =>
      range === "month"
        ? rangeMonth
        : startOfMonth((range === "custom" && parseDay(rangeDays.to)) || now),
    [range, rangeMonth, rangeDays.to, now],
  );
  const days = useMemo(() => calendarMonth(sessions, month), [sessions, month]);
  const firstMonth = useMemo(
    () => (sessions.length ? startOfMonth(new Date(sessions[0].startedAt)) : startOfMonth(now)),
    [sessions, now],
  );
  // The day chosen in the calendar's month, else today in it, else its first day.
  const selected =
    days.find((day) => dayKey(day.date) === selectedDay) ??
    days.find((day) => dayKey(day.date) === dayKey(now)) ??
    days[0];
  // Beside the range: a Month range's month, back to the first session's, with the month's first
  // day chosen in the calendar (today in this month); a Custom range's first and last days, the
  // calendar following the last.
  const rangeControls =
    range === "month" ? (
      <MonthPicker
        id="statistics-range-month"
        label={t("statistics.month")}
        max={startOfMonth(now)}
        min={firstMonth}
        onChoose={(month) => {
          setRangeMonth(month);
          setSelectedDay(dayKey(month.getTime() === startOfMonth(now).getTime() ? now : month));
        }}
        value={rangeMonth}
      />
    ) : range === "custom" ? (
      <div className="statistics-range-days">
        <span className="statistics-range-days__field">
          <span id="statistics-range-from">{t("statistics.rangeFrom")}</span>
          <DayPicker
            empty=""
            id="statistics-range-from-day"
            labelledBy="statistics-range-from"
            max={rangeDays.to}
            min="2000-01-01"
            onChoose={(from) => setRangeDays((current) => ({ ...current, from }))}
            value={rangeDays.from}
          />
        </span>
        <span className="statistics-range-days__field">
          <span id="statistics-range-to">{t("statistics.rangeTo")}</span>
          <DayPicker
            empty=""
            id="statistics-range-to-day"
            labelledBy="statistics-range-to"
            max={dayValue(now)}
            min={rangeDays.from}
            onChoose={(to) => {
              setRangeDays((current) => ({ ...current, to }));
              const day = parseDay(to);
              if (day) setSelectedDay(dayKey(day));
            }}
            value={rangeDays.to}
          />
        </span>
      </div>
    ) : null;

  const rangeMenu = (
    <MenuButton
      icon={<CalendarBlankIcon aria-hidden="true" size={17} />}
      label={t("statistics.range")}
      onChange={setRange}
      options={rangeOptions.map((option) => ({
        value: option.value,
        label: t(option.label),
        description: t(option.description),
      }))}
      value={range}
    />
  );
  const header = MobileHeader ? (
    <MobileHeader title={t("shell.statistics")} />
  ) : (
    <header className="statistics-header">
      <div className="statistics-header__identity">
        <button
          aria-label={t("statistics.back")}
          className="statistics-back"
          onClick={() => navigate("/library")}
          type="button"
        >
          <ArrowLeftIcon aria-hidden="true" className="flip-rtl" size={19} />
        </button>
        <div>
          <h1>{t("shell.statistics")}</h1>
          <p>{t("statistics.description")}</p>
        </div>
      </div>
      <div className="statistics-range">
        {rangeControls}
        {rangeMenu}
      </div>
    </header>
  );

  if (!loaded) {
    return (
      <div className="page page--statistics">
        {header}
        <Card className="content-card content-card--fill">
          {data === "failed" ? (
            <EmptyState
              action={
                <Button onClick={() => void load()} tone="secondary">
                  {t("common.tryAgain")}
                </Button>
              }
              description={t("statistics.loadFailedDescription")}
              icon={ChartBarIcon}
              title={t("statistics.loadFailed")}
            />
          ) : (
            <p className="statistics-loading" role="status">
              {t("statistics.loading")}
            </p>
          )}
        </Card>
      </div>
    );
  }

  const { books } = loaded;
  const overview = libraryOverview(books, now);
  // Words read shows while the Library has a book counted in words, or words were read.
  const wordBased = overview.wordBooks > 0 || summary.words > 0;
  const breakdown = languageBreakdown(books);
  const streak = currentStreak(sessions, now);
  const best = bestStreakInMonth(sessions, now);
  const rangeDescription =
    range === "today"
      ? t("statistics.today")
      : range === "month"
        ? formatMonth(rangeMonth)
        : range === "custom"
          ? formatDays(rangeDays.from, rangeDays.to, language)
          : sessions.length
            ? t("statistics.allSince", {
                date: i18n().date(new Date(sessions[0].startedAt), { dateStyle: "short" }),
              })
            : t("statistics.allTracked");

  const activityHeading = (
    <SectionHeading
      description={rangeDescription}
      id="statistics-activity"
      title={t("statistics.activity")}
    />
  );

  return (
    <div className="page page--statistics">
      {header}

      <section className="statistics-section" aria-labelledby="statistics-activity">
        {MobileHeader ? (
          // On the phone the range sits beside the heading it changes.
          <>
            <div className="mobile-statistics-heading">
              {activityHeading}
              {rangeMenu}
            </div>
            {rangeControls ? <div className="mobile-statistics-range">{rangeControls}</div> : null}
          </>
        ) : (
          activityHeading
        )}
        {statisticsEnabled ? null : (
          <p className="statistics-note statistics-note--off" role="note">
            {t("statistics.off")}{" "}
            <Link to="/settings?section=statistics">{t("statistics.turnOn")}</Link>
          </p>
        )}
        {sessions.length || !statisticsEnabled ? null : (
          <p className="statistics-note">{t("statistics.noSessions")}</p>
        )}
        <div className="statistics-metrics">
          <MetricCard
            icon={<ClockIcon />}
            label={t("statistics.readingTime")}
            note={comparison(summary.activeMs, previous?.activeMs, range) ?? daysRead(summary)}
            tone="blue"
            value={formatDuration(summary.activeMs)}
          />
          <MetricCard
            icon={<BookOpenTextIcon />}
            label={t("statistics.sessions")}
            note={
              comparison(summary.sessions, previous?.sessions, range) ??
              t(
                summary.devices.length > 1
                  ? "statistics.phoneAndPc"
                  : "statistics.recordedSessions",
              )
            }
            tone="blue"
            value={numbers.format(summary.sessions)}
          />
          <MetricCard
            icon={<TextAaIcon />}
            label={t("statistics.charactersRead")}
            note={t("statistics.cjkNote")}
            tone="green"
            value={numbers.format(summary.characters)}
          />
          {wordBased ? (
            <MetricCard
              icon={<FileTextIcon />}
              label={t("statistics.wordsRead")}
              note={t("statistics.wordBooks")}
              tone="gold"
              value={numbers.format(summary.words)}
            />
          ) : null}
          <SpeedCard previous={previous} range={range} summary={summary} />
          <MetricCard
            icon={<CheckCircleIcon />}
            label={t("statistics.finished")}
            note={t("statistics.startedFromBeginning", { count: summary.started })}
            tone="green"
            value={numbers.format(summary.finished)}
          />
        </div>
      </section>

      {summary.finishedBooks.length ? (
        <section className="statistics-card" aria-labelledby="statistics-books">
          <div className="statistics-card__heading">
            <div>
              <h2 id="statistics-books">{t("statisticsCards.booksRead")}</h2>
              <span>{rangeDescription}</span>
            </div>
          </div>
          <BookTotals
            books={summary.finishedBooks}
            finishes={finishes}
            library={library}
            onLibraryChanged={() => void load()}
            onSessionsChanged={(updated) => {
              ++loadVersion.current;
              setData((current) =>
                typeof current === "object" ? { ...current, sessions: updated } : current,
              );
            }}
          />
        </section>
      ) : null}

      <section
        className="statistics-card statistics-activity-card"
        aria-labelledby="daily-activity"
      >
        <div className="statistics-card__heading statistics-card__heading--activity">
          <div>
            <h2 id="daily-activity">{t("statistics.daily")}</h2>
            {/* A day's activity is edited by right-click, which the phone does not offer. */}
            {MobileHeader ? null : <span>{t("statistics.dailyHint")}</span>}
          </div>
        </div>
        <div className="statistics-activity-layout">
          <ActivityCalendar
            days={days}
            onSelect={(day) => {
              if (!edit) setSelectedDay(day);
            }}
            selected={selected ? dayKey(selected.date) : ""}
            today={dayKey(now)}
          />
          {selected ? (
            <div className="statistics-daily-side">
              <DailyDetail
                date={selected.date}
                deviceName={(id) => devices.get(id)}
                summary={selected.summary}
              />
              <DailyBooks
                key={dayKey(selected.date)}
                books={selected.summary.books}
                date={selected.date}
                library={library}
                onEdit={(activity) => {
                  setEditNotice(false);
                  setEdit({
                    date: selected.date,
                    book: library.get(activity.bookId)!,
                    activity,
                    sessionCount: sessions.filter(
                      (session) =>
                        session.bookId === activity.bookId &&
                        dayKey(new Date(session.startedAt)) === dayKey(selected.date),
                    ).length,
                  });
                }}
              />
            </div>
          ) : null}
        </div>
        {editNotice ? (
          <p className="statistics-note" role="status">
            {t("statistics.dailySaved")}
          </p>
        ) : null}
        {edit ? (
          <DailyActivityEditor
            target={edit}
            onCancel={() => setEdit(null)}
            onStale={() => void load()}
            onSaved={(updated) => {
              ++loadVersion.current;
              setData((current) =>
                typeof current === "object" ? { ...current, sessions: updated } : current,
              );
              setEdit(null);
              setEditNotice(true);
            }}
          />
        ) : null}
      </section>

      <section className="statistics-section" aria-labelledby="library-overview">
        <SectionHeading
          description={t("statistics.overviewHint")}
          id="library-overview"
          title={t("statistics.overview")}
        />
        <div className="statistics-metrics library-overview-grid">
          <OverviewCard
            icon={<BooksIcon />}
            label={t("statistics.books")}
            note={
              overview.addedThisMonth
                ? t("statistics.addedThisMonth", { count: overview.addedThisMonth })
                : t("statistics.noneAdded")
            }
            value={numbers.format(overview.books)}
          />
          {overview.wordBooks > 0 ? (
            <OverviewCard
              icon={<FileTextIcon />}
              label={t("statistics.wordsCounted")}
              note={tp("statistics.wordBooksCounted", overview.wordBooks, {
                counted: overview.countedWordBooks,
              })}
              value={formatCompact(overview.words)}
            />
          ) : null}
          <OverviewCard
            icon={<TextAaIcon />}
            label={t("statistics.cjkCharacters")}
            note={t("statistics.cjkNote")}
            value={formatCompact(overview.cjkCharacters)}
          />
          <OverviewCard
            icon={<CheckCircleIcon />}
            label={t("libraryCard.completed")}
            note={t("statistics.percentOfLibrary", {
              percent: overview.books ? Math.round((overview.completed / overview.books) * 100) : 0,
            })}
            value={numbers.format(overview.completed)}
          />
          <OverviewCard
            icon={<FlameIcon />}
            label={t("statistics.streak")}
            note={t("statistics.bestThisMonth", { days: tp("statistics.days", best) })}
            value={tp("statistics.days", streak)}
          />
        </div>
      </section>

      <section
        className="statistics-split-grid"
        aria-label={t("statistics.languagesAndCompletion")}
      >
        <LanguageBreakdown cjk={breakdown.cjk} other={breakdown.other} />
        <CompletionOverview books={completionOrder(books)} />
      </section>

      <CharacterExplorer
        failed={kanji === "failed"}
        groups={kanji === "failed" ? null : kanji}
        onOpen={(character) => navigate(`/dictionary?q=${encodeURIComponent(character)}`)}
        onRetry={() => void loadKanji()}
      />
    </div>
  );
}

function SpeedCard({
  summary,
  previous,
  range,
}: {
  summary: ActivitySummary;
  previous: ActivitySummary | null;
  range: StatisticsRange;
}) {
  const characters = speed(summary.characters, summary.characterMs);
  const words = speed(summary.words, summary.wordMs);
  const before = previous ? speed(previous.characters, previous.characterMs) : null;
  const { t } = useI18n();
  const note =
    characters !== null
      ? (comparison(characters, before ?? undefined, range) ??
        (words !== null
          ? t("statistics.wordsPerHour", { count: words })
          : t("statistics.charsPerHour")))
      : words !== null
        ? t("statistics.wordsPerHour", { count: words })
        : t("statistics.afterAMinute");
  return (
    <MetricCard
      icon={<GaugeIcon />}
      label={t(
        characters === null && words !== null ? "statistics.avgWords" : "statistics.avgChars",
      )}
      note={note}
      tone="violet"
      value={
        characters !== null
          ? numbers.format(characters)
          : words !== null
            ? numbers.format(words)
            : "—"
      }
    />
  );
}

/** "+12% vs the month before", or null when there is nothing to compare with. */
function comparison(
  current: number,
  previous: number | undefined,
  range: StatisticsRange,
): string | null {
  if (range === "all" || previous === undefined || previous <= 0) return null;
  const change = Math.round(((current - previous) / previous) * 100);
  const key =
    range === "today"
      ? "statistics.vsYesterday"
      : range === "month"
        ? "statistics.vsMonthBefore"
        : "statistics.vsPeriodBefore";
  return i18n().t(key, { change: `${change >= 0 ? "+" : ""}${change}` });
}

/** A custom range's days, as "Nov 17 – 23, 2026" or one day alone. */
function formatDays(from: string, to: string, language: InterfaceLanguage) {
  const first = parseDay(from);
  const last = parseDay(to);
  if (!first || !last) return "";
  return new Intl.DateTimeFormat(formattingLocale(language), { dateStyle: "medium" }).formatRange(
    first,
    last,
  );
}

function daysRead(summary: ActivitySummary): string {
  return i18n().t(summary.sessions ? "statistics.activeOnly" : "statistics.idleExcluded");
}

/** A book removed from the Library, or only on `device`, by the title its sessions kept. */
function removedBook(id: string, title: string | null, device?: string): LibraryBook {
  return {
    id,
    title: title ?? i18n().t("statistics.removedBook"),
    author: device ?? i18n().t("statistics.removedFromLibrary"),
    fileName: "",
    importedAt: "",
    availability: "missing",
    hasCover: false,
  };
}

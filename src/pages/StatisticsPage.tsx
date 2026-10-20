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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { i18n, useI18n } from "../i18n/i18n";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { MenuButton } from "../components/ui/MenuButton";
import { useAppearance } from "../features/appearance/AppearanceProvider";
import {
  listLibrary,
  onLibraryDetailsUpdated,
  type LibraryBook,
} from "../features/library/libraryApi";
import { libraryCache } from "../features/library/libraryCache";
import { formatDuration } from "../features/statistics/readingSession";
import {
  DailyActivityEditor,
  type DailyEditTarget,
} from "../features/statistics/DailyActivityEditor";
import {
  bestStreakInMonth,
  calendarMonth,
  completionOrder,
  currentStreak,
  dayKey,
  languageBreakdown,
  libraryOverview,
  rangePeriods,
  speed,
  startOfMonth,
  summarize,
  type ActivitySummary,
  type StatisticsRange,
} from "../features/statistics/statistics";
import {
  listLibraryKanji,
  listReadingSessions,
  type LibraryKanji,
  type StoredReadingSession,
} from "../features/statistics/statisticsApi";
import {
  ActivityCalendar,
  CharacterExplorer,
  CompletionOverview,
  DailyBooks,
  DailyDetail,
  formatCompact,
  formatMonth,
  LanguageBreakdown,
  MetricCard,
  MonthSwitcher,
  numbers,
  OverviewCard,
  SectionHeading,
} from "../features/statistics/StatisticsCards";

const rangeOptions = [
  { value: "today", label: "statistics.today", description: "statistics.todayHint" },
  { value: "month", label: "statistics.month", description: "statistics.monthHint" },
  { value: "all", label: "statistics.all", description: "statistics.allHint" },
] as const;

type Loaded = { books: LibraryBook[]; sessions: StoredReadingSession[] };

export function StatisticsPage() {
  const navigate = useNavigate();
  const { statisticsEnabled } = useAppearance();
  const { t, tp, language } = useI18n();
  const [range, setRange] = useState<StatisticsRange>("month");
  const [data, setData] = useState<Loaded | "loading" | "failed">("loading");
  const [kanji, setKanji] = useState<LibraryKanji[] | null | "failed">(null);
  const [now] = useState(() => new Date());
  const [month, setMonth] = useState(() => startOfMonth(now));
  const [selectedDay, setSelectedDay] = useState(() => dayKey(now));
  const [edit, setEdit] = useState<DailyEditTarget | null>(null);
  const [editNotice, setEditNotice] = useState(false);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    const cached = libraryCache.books();
    setData((current) => (current === "failed" || !cached ? "loading" : current));
    try {
      const [books, sessions] = await Promise.all([listLibrary(), listReadingSessions()]);
      if (version !== loadVersion.current) return;
      libraryCache.setBooks(books);
      setData({ books, sessions });
    } catch {
      if (version === loadVersion.current) setData("failed");
    }
  }, []);
  const loadKanji = useCallback(async () => {
    setKanji(null);
    try {
      setKanji(await listLibraryKanji());
    } catch {
      setKanji("failed");
    }
  }, []);
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
  // Books removed from the Library keep their sessions, shown by the title they had.
  const library = useMemo(() => {
    const known = new Map((loaded?.books ?? []).map((book) => [book.id, book]));
    for (const session of loaded?.sessions ?? [])
      if (!known.has(session.bookId))
        known.set(session.bookId, removedBook(session.bookId, session.bookTitle));
    return known;
    // Removed books are named in the interface language.
  }, [loaded, language]);
  const sessions = useMemo(() => loaded?.sessions ?? [], [loaded]);
  const periods = useMemo(() => rangePeriods(range, now), [range, now]);
  const summary = useMemo(() => summarize(sessions, periods.current), [sessions, periods]);
  const previous = useMemo(
    () => (periods.previous ? summarize(sessions, periods.previous) : null),
    [sessions, periods],
  );
  const days = useMemo(() => calendarMonth(sessions, month), [sessions, month]);
  const firstMonth = useMemo(
    () => (sessions.length ? startOfMonth(new Date(sessions[0].startedAt)) : startOfMonth(now)),
    [sessions, now],
  );
  const selected = days.find((day) => dayKey(day.date) === selectedDay) ?? days[0];

  const header = (
    <header className="statistics-header">
      <div className="statistics-header__identity">
        <button
          aria-label={t("statistics.back")}
          className="statistics-back"
          onClick={() => navigate("/library")}
          type="button"
        >
          <ArrowLeftIcon aria-hidden="true" size={19} />
        </button>
        <div>
          <h1>{t("shell.statistics")}</h1>
          <p>{t("statistics.description")}</p>
        </div>
      </div>
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
  const breakdown = languageBreakdown(books);
  const streak = currentStreak(sessions, now);
  const best = bestStreakInMonth(sessions, now);
  const rangeDescription =
    range === "today"
      ? t("statistics.today")
      : range === "month"
        ? formatMonth(now)
        : sessions.length
          ? t("statistics.allSince", {
              date: i18n().date(new Date(sessions[0].startedAt), { dateStyle: "short" }),
            })
          : t("statistics.allTracked");

  return (
    <div className="page page--statistics">
      {header}

      <section className="statistics-section" aria-labelledby="statistics-activity">
        <SectionHeading
          description={rangeDescription}
          id="statistics-activity"
          title={t("statistics.activity")}
        />
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
              t("statistics.recordedSessions")
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
          <MetricCard
            icon={<FileTextIcon />}
            label={t("statistics.wordsRead")}
            note={t("statistics.wordBooks")}
            tone="gold"
            value={numbers.format(summary.words)}
          />
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

      <section
        className="statistics-card statistics-activity-card"
        aria-labelledby="daily-activity"
      >
        <div className="statistics-card__heading statistics-card__heading--activity">
          <div>
            <h2 id="daily-activity">{t("statistics.daily")}</h2>
            <span>{t("statistics.dailyHint")}</span>
          </div>
          <MonthSwitcher
            first={firstMonth}
            last={startOfMonth(now)}
            month={month}
            onChange={(next) => {
              setMonth(next);
              const today = dayKey(now);
              setSelectedDay(startOfMonth(now).getTime() === next.getTime() ? today : dayKey(next));
            }}
          />
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
              <DailyDetail date={selected.date} summary={selected.summary} />
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
          <OverviewCard
            icon={<FileTextIcon />}
            label={t("statistics.wordsCounted")}
            note={tp("statistics.wordBooksCounted", overview.wordBooks, {
              counted: overview.countedWordBooks,
            })}
            value={formatCompact(overview.words)}
          />
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

/** "+12% vs last month", or null when there is nothing to compare with. */
function comparison(
  current: number,
  previous: number | undefined,
  range: StatisticsRange,
): string | null {
  if (range === "all" || previous === undefined || previous <= 0) return null;
  const change = Math.round(((current - previous) / previous) * 100);
  return i18n().t(range === "today" ? "statistics.vsYesterday" : "statistics.vsLastMonth", {
    change: `${change >= 0 ? "+" : ""}${change}`,
  });
}

function daysRead(summary: ActivitySummary): string {
  return i18n().t(summary.sessions ? "statistics.activeOnly" : "statistics.idleExcluded");
}

/** A book removed from the Library, by the title its sessions kept. */
function removedBook(id: string, title: string | null): LibraryBook {
  return {
    id,
    title: title ?? i18n().t("statistics.removedBook"),
    author: i18n().t("statistics.removedFromLibrary"),
    fileName: "",
    importedAt: "",
    availability: "missing",
    hasCover: false,
  };
}

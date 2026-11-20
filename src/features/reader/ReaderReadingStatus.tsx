import { useI18n } from "../../i18n/i18n";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Clock, PlayIcon, StopIcon } from "@phosphor-icons/react";

import {
  formatDurationSeconds,
  formatReadingSpeed,
  type ReadingSpeed,
} from "../statistics/readingSession";
import { ReadingStatsPanel } from "./ReadingStatsPanel";
import { useEverySecond } from "./useEverySecond";
import type { LiveReading } from "./readingStats";
import type { ReaderBookProgress } from "./renderer";
import type { SessionState } from "./useReadingSession";

/** No time read, one function for every render, so the refresh it feeds stays the same. */
const NO_READING_TIME = () => 0;

/** What the pill's statistics panel reads: the open book, where it is, and the live session. */
export interface ReadingStatsSource {
  bookId: string;
  progress: ReaderBookProgress | null;
  live: () => LiveReading;
}

/** How long the pointer rests on the session's button or time before its statistics show. */
const STATS_OPEN_MS = 250;
const STATS_CLOSE_MS = 200;

/**
 * The upper-center status pill, separate from the book's layout: the clock and the time read,
 * with the session's play/stop button between them while statistics are recorded. Resting on
 * the button or the time shows the session's and the book's statistics below the pill.
 */
export function ReaderReadingStatus({
  clock,
  readingTime,
  readingMs = NO_READING_TIME,
  session = "counting",
  onToggleSession,
  manual = false,
  stats,
}: {
  clock: boolean;
  readingTime: boolean;
  /** The current session's active reading time. */
  readingMs?: () => number;
  /** `off` while reading statistics are disabled. */
  session?: SessionState;
  /** Starts or stops the session; given, the pill shows its play/stop button. */
  onToggleSession?: () => void;
  /** A Manual session only counts from the button, so the pill shows it on its own too. */
  manual?: boolean;
  /** Given, resting on the button or the time shows the statistics panel. */
  stats?: ReadingStatsSource;
}) {
  const [now, setNow] = useState(() => new Date());
  const [statsOpen, setStatsOpen] = useState(false);
  const statsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hovering = useRef(false);
  const statsId = useId();
  useEffect(() => () => clearTimeout(statsTimer.current), []);
  const [elapsed, setElapsed] = useState(readingMs);
  const { t, date } = useI18n();
  const refresh = useCallback(() => {
    setNow(new Date());
    setElapsed(readingMs());
  }, [readingMs]);
  useEverySecond(clock || (readingTime && session !== "off"), refresh);

  const toggle = onToggleSession && session !== "off" ? onToggleSession : null;
  const statsShown = Boolean(stats?.progress) && session !== "off";
  useEffect(() => {
    if (!statsShown) setStatsOpen(false);
  }, [statsShown]);
  const hover = (open: boolean) => {
    hovering.current = open;
    clearTimeout(statsTimer.current);
    statsTimer.current = setTimeout(
      () => setStatsOpen(open),
      open ? STATS_OPEN_MS : STATS_CLOSE_MS,
    );
  };
  const statsTarget = statsShown
    ? {
        "aria-describedby": statsOpen ? statsId : undefined,
        onPointerEnter: () => hover(true),
        onPointerLeave: () => hover(false),
        onFocus: (event: { currentTarget: Element }) => {
          // Keyboard focus shows it; a click's focus leaves it to the pointer.
          if (focusVisible(event.currentTarget)) setStatsOpen(true);
        },
        onBlur: () => {
          if (!hovering.current) setStatsOpen(false);
        },
      }
    : {};
  if (!clock && !readingTime && !(toggle && manual)) return null;
  const time = date(now, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const duration = formatDurationSeconds(elapsed);
  return (
    <div className="reader-reading-status-top" role="group" aria-label={t("readingStatus.label")}>
      {clock && (
        <span aria-label={t("readingStatus.localTime", { time })}>
          <Clock size={14} aria-hidden="true" />
          <time dateTime={now.toISOString()}>{time}</time>
        </span>
      )}
      {toggle && (
        <button
          aria-label={t(
            session === "counting" ? "readingStatus.stopSession" : "readingStatus.startSession",
          )}
          aria-pressed={session === "counting"}
          className="reader-reading-status__session"
          onClick={toggle}
          {...statsTarget}
          title={
            statsShown
              ? undefined
              : t(
                  session === "counting"
                    ? "readingStatus.stopSession"
                    : "readingStatus.startSession",
                )
          }
          type="button"
        >
          {session === "counting" ? (
            <StopIcon aria-hidden="true" weight="fill" />
          ) : (
            <PlayIcon aria-hidden="true" weight="fill" />
          )}
        </button>
      )}
      {readingTime &&
        (session === "off" ? (
          <span title={t("readingStatus.offHint")}>{t("readingStatus.off")}</span>
        ) : (
          <span
            title={statsShown ? undefined : t("readingStatus.time")}
            aria-label={t("readingStatus.timeLabel", { duration })}
            {...statsTarget}
          >
            {duration}
          </span>
        ))}
      {statsShown && statsOpen && stats?.progress ? (
        <ReadingStatsPanel
          bookId={stats.bookId}
          id={statsId}
          live={stats.live}
          onPointerEnter={() => hover(true)}
          onPointerLeave={() => hover(false)}
          progress={stats.progress}
        />
      ) : null}
    </div>
  );
}

function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

/** The session's reading speed, refreshed each second while shown; null until a minute was read. */
export function useReadingSpeed(
  shown: boolean,
  speed: () => ReadingSpeed | null,
): ReadingSpeed | null {
  const [current, setCurrent] = useState(speed);
  const refresh = useCallback(() => {
    const next = speed();
    setCurrent((previous) =>
      previous?.perHour === next?.perHour && previous?.unit === next?.unit ? previous : next,
    );
  }, [speed]);
  useEverySecond(shown, refresh);
  return shown ? current : null;
}

/** The session's reading speed as the lower footer pill's last group. */
export function ReadingSpeedValue({ speed }: { speed: ReadingSpeed }) {
  const text = formatReadingSpeed(speed);
  const { t } = useI18n();
  return (
    <span className="reader-footer__values" role="group" aria-label={t("readingStatus.speed")}>
      <span
        title={t("readingStatus.speedTitle")}
        aria-label={t("readingStatus.speedLabel", { speed: text })}
      >
        {text}
      </span>
    </span>
  );
}

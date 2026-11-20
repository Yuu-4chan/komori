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

/** How long the pointer rests on a pill before its statistics show, and leaves before they go. */
const STATS_OPEN_MS = 250;
const STATS_CLOSE_MS = 200;

/**
 * The statistics panel of a Reader pill: it opens while the pointer rests on the pill (or on the
 * panel, which is inside it) and closes shortly after it leaves; nothing opens while not `shown`.
 */
export function useStatsHover(shown: boolean) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hovering = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (shown) return;
    clearTimeout(timer.current);
    hovering.current = false;
    setOpen(false);
  }, [shown]);
  const hover = (next: boolean) => {
    hovering.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), next ? STATS_OPEN_MS : STATS_CLOSE_MS);
  };
  return {
    open: shown && open,
    setOpen,
    hovering,
    /** For the pill: its pointer opens and closes the panel. */
    area: shown
      ? { onPointerEnter: () => hover(true), onPointerLeave: () => hover(false) }
      : undefined,
  };
}

/**
 * The upper-center status pill, separate from the book's layout: the clock and the time read,
 * with the session's play/stop button between them while statistics are recorded. Resting on
 * the pill, or focusing its button from the keyboard, shows the session's and the book's
 * statistics below it.
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
  const statsId = useId();
  const [elapsed, setElapsed] = useState(readingMs);
  const { t, date } = useI18n();
  const refresh = useCallback(() => {
    setNow(new Date());
    setElapsed(readingMs());
  }, [readingMs]);
  useEverySecond(clock || (readingTime && session !== "off"), refresh);

  const toggle = onToggleSession && session !== "off" ? onToggleSession : null;
  const statsShown = Boolean(stats?.progress) && session !== "off";
  const statsHover = useStatsHover(statsShown);
  const statsOpen = statsHover.open;
  if (!clock && !readingTime && !(toggle && manual)) return null;
  const time = date(now, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const duration = formatDurationSeconds(elapsed);
  return (
    <div
      className={`reader-reading-status-top${statsShown ? " reader-stats-area" : ""}`}
      role="group"
      aria-label={t("readingStatus.label")}
      {...statsHover.area}
    >
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
          aria-describedby={statsOpen ? statsId : undefined}
          onFocus={(event) => {
            // Keyboard focus shows it; a click's focus leaves it to the pointer.
            if (statsShown && focusVisible(event.currentTarget)) statsHover.setOpen(true);
          }}
          onBlur={() => {
            if (!statsHover.hovering.current) statsHover.setOpen(false);
          }}
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
          >
            {duration}
          </span>
        ))}
      {statsOpen && stats?.progress ? (
        <ReadingStatsPanel
          bookId={stats.bookId}
          id={statsId}
          live={stats.live}
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

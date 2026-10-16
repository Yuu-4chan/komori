import { useI18n } from "../../i18n/i18n";
import { useCallback, useEffect, useState } from "react";
import { Clock } from "@phosphor-icons/react";

import {
  formatDurationSeconds,
  formatReadingSpeed,
  type ReadingSpeed,
} from "../statistics/readingSession";
import type { SessionState } from "./useReadingSession";

/**
 * Calls `refresh` now and each second while `active` and the document is visible; hiding
 * the app suspends the timer and showing it again refreshes immediately.
 */
function useEverySecond(active: boolean, refresh: () => void) {
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const visibilityChanged = () => {
      clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== "hidden") {
        refresh();
        timer = setInterval(refresh, 1000);
      }
    };
    visibilityChanged();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [active, refresh]);
}

/** The upper-center status pill, separate from the book's layout. */
export function ReaderReadingStatus({
  clock,
  readingTime,
  readingMs = () => 0,
  session = "counting",
}: {
  clock: boolean;
  readingTime: boolean;
  /** The current session's active reading time. */
  readingMs?: () => number;
  /** `off` while reading statistics are disabled. */
  session?: SessionState;
}) {
  const [now, setNow] = useState(() => new Date());
  const [elapsed, setElapsed] = useState(readingMs);
  const { t, date } = useI18n();
  const refresh = useCallback(() => {
    setNow(new Date());
    setElapsed(readingMs());
  }, [readingMs]);
  useEverySecond(clock || (readingTime && session !== "off"), refresh);

  if (!clock && !readingTime) return null;
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
      {readingTime &&
        (session === "off" ? (
          <span title={t("readingStatus.offHint")}>{t("readingStatus.off")}</span>
        ) : (
          <span
            title={t("readingStatus.time")}
            aria-label={t("readingStatus.timeLabel", { duration })}
          >
            {duration}
          </span>
        ))}
    </div>
  );
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

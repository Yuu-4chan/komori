import { useCallback, useEffect, useState } from "react";

import { i18n, useI18n, type MessageKey } from "../../i18n/i18n";
import {
  formatDuration,
  formatDurationSeconds,
  formatReadingSpeed,
} from "../statistics/readingSession";
import { listBookReadingSessions, type StoredReadingSession } from "../statistics/statisticsApi";
import { useEverySecond } from "./useEverySecond";
import { readingStats, type LiveReading } from "./readingStats";
import type { ReaderBookProgress, ReaderProgressUnit } from "./renderer";

const number = (value: number) => i18n().number(value);

function speedText(perHour: number | null, unit: ReaderProgressUnit): string {
  return perHour === null ? "—" : formatReadingSpeed({ perHour, unit });
}

/**
 * The statistics below the Reader's status pill: this session, the whole book with its saved
 * sessions, and the time left to its end at each speed. Refreshed each second while shown.
 */
export function ReadingStatsPanel({
  bookId,
  id,
  live,
  progress,
  onPointerEnter,
  onPointerLeave,
}: {
  bookId: string;
  id: string;
  live: () => LiveReading;
  progress: ReaderBookProgress;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const { t } = useI18n();
  const [stored, setStored] = useState<StoredReadingSession[]>([]);
  const [current, setCurrent] = useState(live);
  const refresh = useCallback(() => setCurrent(live()), [live]);
  useEverySecond(true, refresh);
  useEffect(() => {
    let cancelled = false;
    listBookReadingSessions(bookId)
      .then((sessions) => {
        if (!cancelled) setStored(sessions);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  const stats = readingStats(stored, current, progress);
  const characters = stats.unit === "characters";
  const read: MessageKey = characters ? "statistics.charactersRead" : "statistics.wordsRead";
  const sections: [MessageKey, [MessageKey, string][]][] = [
    [
      "readingStatus.thisSession",
      [
        ["statistics.readingTime", formatDurationSeconds(stats.session.readingMs)],
        [read, number(stats.session.unitsRead)],
        ["readingStatus.speed", speedText(stats.session.speed, stats.unit)],
      ],
    ],
    [
      "readingStatus.thisBook",
      [
        ["libraryToolbar.sort.progress", i18n().percentLabel(stats.book.percent)],
        ["statistics.readingTime", formatDuration(stats.book.readingMs)],
        ["statistics.sessions", number(stats.book.sessions)],
        ["statisticsCards.daysRead", number(stats.book.days)],
        [read, number(stats.book.unitsRead)],
        ["readingStatus.speed", speedText(stats.book.speed, stats.unit)],
      ],
    ],
    [
      "readingStatus.toFinish",
      [
        [
          characters ? "readingStatus.charactersLeft" : "readingStatus.wordsLeft",
          number(stats.left),
        ],
        [
          "readingStatus.atSessionSpeed",
          stats.atSessionSpeed === null ? "—" : formatDuration(stats.atSessionSpeed),
        ],
        [
          "readingStatus.atBookSpeed",
          stats.atBookSpeed === null ? "—" : formatDuration(stats.atBookSpeed),
        ],
      ],
    ],
  ];
  return (
    <div
      className="reader-reading-stats"
      id={id}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      role="tooltip"
    >
      {sections.map(([heading, rows]) => (
        <section key={heading}>
          <h3>{t(heading)}</h3>
          <dl>
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt>{t(label)}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

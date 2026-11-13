import { useEffect, useRef, useState } from "react";

import { watchWindowVisibility } from "../../app/windowLifecycle";
import { useI18n } from "../../i18n/i18n";
import type { ReaderBookProgress } from "../reader/renderer";
import { formatReadingSpeed, type ReadingSpeed } from "../statistics/readingSession";
import { reportDiscordReading, type DiscordReading } from "./discordApi";

/** How often the open book is reported again, so the speed stays current. */
export const discordRefreshMs = 15_000;

/** Discord runs on the PC only; the phone reports nothing. */
const reports = import.meta.env.TAURI_ENV_PLATFORM !== "android";

const percent = (current: number, total: number) =>
  Math.floor((Math.min(current, total) / total) * 100);

/**
 * Reports the Reader's open book to the Discord status: when it opens and whenever its progress
 * changes, again every 15 s for the reading speed, and no book once it closes or the window goes
 * to the tray. Native code decides what Discord shows and when reading has stopped.
 */
export function useDiscordPresence(
  book: { id: string; title: string } | null,
  progress: ReaderBookProgress | null,
  readingSpeed: () => ReadingSpeed | null,
) {
  const { t } = useI18n();
  const [shown, setShown] = useState(true);
  useEffect(() => watchWindowVisibility(setShown), []);
  const reading = useRef<() => DiscordReading | null>(() => null);
  reading.current = () => {
    if (!book) return null;
    const chapter = progress?.chapter;
    const speed = readingSpeed();
    return {
      book: book.id,
      title: book.title,
      bookProgress: progress?.total ? `${percent(progress.current, progress.total)}%` : null,
      chapterProgress: chapter?.total
        ? `${t("readerFooter.chapterPrefix")} ${percent(chapter.current, chapter.total)}%`
        : null,
      readingSpeed: speed ? formatReadingSpeed(speed) : null,
      position: progress?.current ?? 0,
    };
  };
  const id = reports && shown ? (book?.id ?? null) : null;
  const title = book?.title;

  useEffect(() => {
    if (id) reportDiscordReading(reading.current());
  }, [id, title, progress, t]);

  useEffect(() => {
    if (!id) return;
    const timer = setInterval(() => reportDiscordReading(reading.current()), discordRefreshMs);
    return () => {
      clearInterval(timer);
      reportDiscordReading(null);
    };
  }, [id]);
}

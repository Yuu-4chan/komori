import { CaretRightIcon, DeviceMobileIcon, MonitorIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { flushPendingWrites } from "../app/windowLifecycle";
import { readerPositionStore } from "../features/reader/readingPosition";
import type { ReaderLocator } from "../features/reader/renderer";
import { i18n, useI18n } from "../i18n/i18n";
import {
  autoSync,
  getPcConflict,
  onPcSynced,
  resolvePcConflict,
  usePcLink,
  type PcConflict,
  type PcReading,
} from "./pcLinkApi";
import { useBackCloser } from "./system";

/**
 * The open book's part in syncing with the PC: the place it was read to on both sides since
 * they last synced, which the Reader asks about once the book shows; the PC's place, which an
 * open book follows when a sync brings it; and a sync on leaving the book.
 */
export function useReaderSync({
  bookId,
  ready,
  goToPosition,
}: {
  bookId: string | null;
  ready: boolean;
  goToPosition: (locator: ReaderLocator | null) => void;
}) {
  const [conflict, setConflict] = useState<PcConflict | null>(null);
  const go = useRef(goToPosition);
  go.current = goToPosition;

  const check = useCallback(() => {
    if (!bookId) return;
    void getPcConflict(bookId).then(
      (found) => setConflict(found),
      () => {},
    );
  }, [bookId]);

  useEffect(() => {
    if (ready) check();
  }, [ready, check]);

  useEffect(() => {
    if (!bookId) return;
    return onPcSynced((result) => {
      if (result.moved.includes(bookId))
        void readerPositionStore(bookId)
          .load()
          .then((locator) => go.current(locator));
      check();
    });
  }, [bookId, check]);

  // Leaving the book sends where it stopped, once that is saved.
  useEffect(
    () => () => {
      void flushPendingWrites().then(() => autoSync());
    },
    [],
  );

  const choose = useCallback(
    async (keep: "pc" | "phone") => {
      const chosen = conflict;
      setConflict(null);
      if (!bookId || !chosen) return;
      try {
        if (!(await resolvePcConflict(bookId, keep))) return;
      } catch {
        return;
      }
      if (keep === "pc") go.current(chosen.pc.position);
      void autoSync();
    },
    [bookId, conflict],
  );

  return { conflict, choose, close: () => setConflict(null) };
}

/** "Today, 21:14", "Yesterday, 08:02", or the date and time. */
function readAt(at: string | null): string | null {
  const time = at ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(time)) return null;
  const { date, relative } = i18n();
  const clock = date(time, { timeStyle: "short" });
  const day = (value: number) => {
    const start = new Date(value);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  };
  const days = Math.round((day(time) - day(Date.now())) / 86_400_000);
  if (days === 0 || days === -1) {
    const name = relative(days, "day");
    return `${name.charAt(0).toLocaleUpperCase()}${name.slice(1)}, ${clock}`;
  }
  return date(time, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Asks where to continue a book read on the PC and on this phone since they last synced: each
 * side's chapter, how far and when, the later one marked. Back or tapping outside asks again
 * the next time the book opens.
 */
export function ContinueFromDialog({
  conflict,
  title,
  lang,
  chapterAt,
  onChoose,
  onClose,
}: {
  conflict: PcConflict | null;
  title: string;
  lang?: string;
  chapterAt: (offset: number) => string | undefined;
  onChoose: (keep: "pc" | "phone") => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const pcName = usePcLink()?.pcName ?? "";
  useBackCloser(conflict !== null, onClose);
  if (!conflict) return null;
  const pcLater =
    (Date.parse(conflict.pcAt ?? "") || 0) >= (Date.parse(conflict.phoneAt ?? "") || 0);

  const row = (keep: "pc" | "phone", reading: PcReading, at: string | null) => {
    const progress = reading.progress;
    const chapter = progress ? chapterAt(progress.current) : undefined;
    const percent =
      progress && progress.total > 0
        ? `${Math.min(100, Math.floor((progress.current / progress.total) * 100))}%`
        : null;
    const rest = [percent, readAt(at)].filter(Boolean).join(" · ");
    const Icon = keep === "pc" ? MonitorIcon : DeviceMobileIcon;
    return (
      <button
        className={
          (keep === "pc") === pcLater
            ? "mobile-continue-from__side mobile-continue-from__side--later"
            : "mobile-continue-from__side"
        }
        onClick={() => onChoose(keep)}
        type="button"
      >
        <span aria-hidden="true" className="mobile-continue-from__icon">
          <Icon />
        </span>
        <span className="mobile-continue-from__text">
          <strong>{keep === "pc" ? pcName : t("sync.thisPhone")}</strong>
          <span>
            {chapter ? <span lang={lang}>{chapter}</span> : null}
            {chapter && rest ? " · " : null}
            {rest}
          </span>
        </span>
        <CaretRightIcon aria-hidden="true" className="mobile-continue-from__caret" />
      </button>
    );
  };

  return createPortal(
    <div
      className="mobile-continue-from-layer"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-labelledby="mobile-continue-from-title"
        aria-modal="true"
        className="mobile-continue-from"
        role="dialog"
      >
        <div>
          <h2 id="mobile-continue-from-title">{t("sync.continueFrom")}</h2>
          <p lang={lang}>{title}</p>
        </div>
        {row("pc", conflict.pc, conflict.pcAt)}
        {row("phone", conflict.phone, conflict.phoneAt)}
      </section>
    </div>,
    document.body,
  );
}

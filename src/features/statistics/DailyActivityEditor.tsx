import { useState } from "react";

import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { bookTitle } from "../library/libraryView";
import type { LibraryBook } from "../library/libraryApi";
import { addDays, startOfDay, type BookActivity } from "./statistics";
import { i18n, useI18n } from "../../i18n/i18n";
import {
  DailyActivityConflict,
  editDailyActivity,
  maxDailyMs,
  maxDailyUnits,
  type StoredReadingSession,
} from "./statisticsApi";

export interface DailyEditTarget {
  date: Date;
  book: LibraryBook;
  activity: BookActivity;
  sessionCount: number;
}

export function DailyActivityEditor({
  target,
  onCancel,
  onSaved,
  onStale,
}: {
  target: DailyEditTarget;
  onCancel: () => void;
  onSaved: (sessions: StoredReadingSession[]) => void;
  onStale: () => void;
}) {
  const initialMinutes = String(Number((target.activity.activeMs / 60_000).toFixed(6)));
  const [amount, setAmount] = useState(String(target.activity.unitsRead));
  const [minutes, setMinutes] = useState(initialMinutes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"stale" | "failed" | null>(null);
  const { t } = useI18n();
  const unitsRead = /^\d+$/.test(amount) ? Number(amount) : NaN;
  const activeMs =
    minutes === initialMinutes
      ? target.activity.activeMs
      : /^\d+(?:\.\d+)?$/.test(minutes)
        ? Math.round(Number(minutes) * 60_000)
        : NaN;
  const valid =
    Number.isSafeInteger(unitsRead) &&
    unitsRead >= 0 &&
    unitsRead <= maxDailyUnits &&
    Number.isSafeInteger(activeMs) &&
    activeMs >= 0 &&
    activeMs <= maxDailyMs &&
    Number(minutes) <= 1440;
  const validation = valid
    ? null
    : t(
        target.activity.unit === "characters"
          ? "dailyEdit.rangeCharacters"
          : "dailyEdit.rangeWords",
        { units: maxDailyUnits, minutes: 1440 },
      );

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const day = startOfDay(target.date);
      onSaved(
        await editDailyActivity({
          bookId: target.activity.bookId,
          dayStart: +day,
          dayEnd: +addDays(day, 1),
          unit: target.activity.unit,
          unitsRead,
          activeMs,
          expectedUnits: target.activity.unitsRead,
          expectedActiveMs: target.activity.activeMs,
          expectedSessions: target.sessionCount,
        }),
      );
    } catch (failure) {
      // Only our own messages are safe to display; invoke errors can hold native paths.
      const stale = failure instanceof DailyActivityConflict;
      setError(stale ? "stale" : "failed");
      if (stale) onStale();
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      title={t("dailyEdit.title")}
      dialogRole="dialog"
      confirmLabel={t("dailyEdit.save")}
      confirmTone="primary"
      busy={busy}
      busyLabel={t("backup.saving")}
      confirmDisabled={!valid}
      description={`${bookTitle(target.book)} · ${i18n().date(target.date, { year: "numeric", month: "long", day: "numeric" })}`}
      error={
        error === "stale"
          ? t("dailyEdit.conflict")
          : error === "failed"
            ? t("dailyEdit.failed")
            : validation
      }
      onCancel={onCancel}
      onConfirm={() => void save()}
    >
      <div className="statistics-edit-fields">
        <label className="text-field">
          <span className="text-field__label">
            {t(
              target.activity.unit === "characters"
                ? "statistics.charactersRead"
                : "statistics.wordsRead",
            )}
          </span>
          <input
            className="text-field__input"
            aria-invalid={
              !Number.isSafeInteger(unitsRead) || unitsRead < 0 || unitsRead > maxDailyUnits
            }
            type="text"
            inputMode="numeric"
            value={amount}
            disabled={busy}
            onChange={(event) => {
              setAmount(event.target.value);
              setError(null);
            }}
          />
        </label>
        <label className="text-field">
          <span className="text-field__label">{t("dailyEdit.minutes")}</span>
          <input
            className="text-field__input"
            aria-invalid={
              !Number.isSafeInteger(activeMs) ||
              activeMs < 0 ||
              activeMs > maxDailyMs ||
              Number(minutes) > 1440
            }
            type="text"
            inputMode="decimal"
            value={minutes}
            disabled={busy}
            onChange={(event) => {
              setMinutes(event.target.value);
              setError(null);
            }}
          />
        </label>
      </div>
      <p>{t("dailyEdit.hint")}</p>
      {busy ? <p role="status">{t("dailyEdit.saving")}</p> : null}
    </ConfirmDialog>
  );
}

import { useEffect, useId, useState } from "react";

import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { useI18n } from "../../i18n/i18n";
import { DayPicker, dayValue, finishedDayTime } from "../statistics/DayPicker";

/** Marks books completed on the day they were finished: today unless another is chosen. */
export function MarkCompletedDialog({
  busy,
  error,
  onCancel,
  onConfirm,
  open,
}: {
  busy: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (completedAt: number) => void;
  open: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const [day, setDay] = useState(() => dayValue(new Date()));
  useEffect(() => {
    if (open) setDay(dayValue(new Date()));
  }, [open]);
  return (
    <ConfirmDialog
      busy={busy}
      confirmLabel={t("library.markCompleted")}
      confirmTone="primary"
      dialogRole="dialog"
      error={error}
      focusConfirm
      onCancel={onCancel}
      onConfirm={() => {
        const time = finishedDayTime(day);
        if (time !== null) onConfirm(time);
      }}
      open={open}
      title={t("library.markCompleted")}
    >
      <div className="finished-day">
        <label htmlFor={id} id={`${id}-label`}>
          {t("statisticsCards.finishedDate")}
        </label>
        <span>
          <DayPicker
            empty=""
            id={id}
            labelledBy={`${id}-label`}
            max={dayValue(new Date())}
            min="2000-01-01"
            onChoose={setDay}
            value={day}
          />
        </span>
      </div>
    </ConfirmDialog>
  );
}

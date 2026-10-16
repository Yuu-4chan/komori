import { useI18n } from "../../i18n/i18n";
import { SelectionRadio } from "../../components/ui/SelectionBox";
import { useEffect, useId, useState } from "react";

import { ConfirmDialog } from "../../components/ui/ConfirmDialog";

export type SeriesChoice = { kind: "name"; name: string } | { kind: "none" } | { kind: "metadata" };

interface SeriesDialogProps {
  open: boolean;
  /** How many books the choice applies to. */
  count: number;
  /** The series every chosen book already shares, to start from. */
  initialName: string;
  /** Series names already in the Library, offered as the name is typed. */
  suggestions: readonly string[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (choice: SeriesChoice) => void;
}

const MAX_NAME = 200;

/**
 * Puts the selected books in a series by hand (numbered in the order shown), in no series, or
 * back on the series their own metadata names.
 */
export function SeriesDialog({
  open,
  count,
  initialName,
  suggestions,
  busy,
  error,
  onCancel,
  onConfirm,
}: SeriesDialogProps) {
  const { t, tp } = useI18n();
  const [kind, setKind] = useState<SeriesChoice["kind"]>("name");
  const [name, setName] = useState(initialName);
  const listId = useId();
  const nameId = useId();

  useEffect(() => {
    if (!open) return;
    setKind("name");
    setName(initialName);
  }, [initialName, open]);

  const trimmed = name.trim().replace(/\s+/g, " ");
  const choice: SeriesChoice | null =
    kind === "name"
      ? trimmed && trimmed.length <= MAX_NAME
        ? { kind: "name", name: trimmed }
        : null
      : { kind };

  return (
    <ConfirmDialog
      busy={busy}
      busyLabel={t("backup.saving")}
      confirmDisabled={choice === null}
      confirmLabel={t("series.save")}
      confirmTone="primary"
      description={tp("series.description", count)}
      dialogRole="dialog"
      error={error}
      onCancel={onCancel}
      onConfirm={() => choice && onConfirm(choice)}
      open={open}
      title={t("series.title")}
    >
      <form
        className="series-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (choice && !busy) onConfirm(choice);
        }}
      >
        <label className="series-dialog__option">
          <SelectionRadio
            checked={kind === "name"}
            name="series-kind"
            onChange={() => setKind("name")}
          />
          <span>
            <strong>{t("series.title")}</strong>
            <small>{t("series.nameHint")}</small>
          </span>
        </label>
        <div className="series-dialog__name">
          <label className="visually-hidden" htmlFor={nameId}>
            {t("series.name")}
          </label>
          <input
            autoComplete="off"
            disabled={kind !== "name"}
            id={nameId}
            list={listId}
            maxLength={MAX_NAME}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("series.name")}
            spellCheck={false}
            value={name}
          />
          <datalist id={listId}>
            {suggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        </div>
        <label className="series-dialog__option">
          <SelectionRadio
            checked={kind === "none"}
            name="series-kind"
            onChange={() => setKind("none")}
          />
          <span>
            <strong>{t("libraryCard.noSeries")}</strong>
            <small>{t("series.noneHint")}</small>
          </span>
        </label>
        <label className="series-dialog__option">
          <SelectionRadio
            checked={kind === "metadata"}
            name="series-kind"
            onChange={() => setKind("metadata")}
          />
          <span>
            <strong>{t("series.metadata")}</strong>
          </span>
        </label>
      </form>
    </ConfirmDialog>
  );
}

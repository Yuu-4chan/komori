import { MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";

import { useI18n } from "../../i18n/i18n";

/** Whether a stepper's new value came from its − and + buttons or was typed. */
export type StepperSource = "button" | "entry";

interface StepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number, source: StepperSource) => void;
  /** The value's number as shown, without its unit. */
  format?: (value: number) => string;
  /** The unit shown after the value, such as px. */
  unit?: string;
}

/**
 * A labelled value with decrease and increase buttons. The value
 * can also be typed: Enter or leaving the field applies it, rounded to the step and kept
 * within the range, and Escape or an entry that is not a number keeps the current value.
 */
export function Stepper({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = String,
  unit = "",
}: StepperProps) {
  const labelId = useId();
  const { t } = useI18n();
  // What the reader has typed since the field last showed the value, if anything.
  const [draft, setDraft] = useState<string | null>(null);
  const atMin = value <= min;
  const atMax = value >= max;

  const apply = () => {
    if (draft === null) return;
    setDraft(null);
    const typed = parseEntry(draft, unit);
    if (typed === null) return;
    const next = Math.min(max, Math.max(min, roundToStep(typed, step)));
    if (next !== value) onChange(next, "entry");
  };

  return (
    <div className="stepper-field">
      <div className="stepper-field__label">
        <span id={labelId}>{label}</span>
      </div>
      <div className="stepper" role="group" aria-labelledby={labelId}>
        {/* aria-disabled keeps focus on a button that reaches its limit. */}
        <button
          type="button"
          aria-label={t("common.decrease", { label })}
          aria-disabled={atMin || undefined}
          onClick={() => {
            if (!atMin) onChange(Math.max(min, value - step), "button");
          }}
        >
          <MinusIcon aria-hidden="true" weight="bold" />
        </button>
        <label className="stepper__value">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            aria-labelledby={labelId}
            value={draft ?? format(value)}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={apply}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                apply();
              } else if (event.key === "Escape" && draft !== null) {
                // Escape cancels the entry here rather than reaching the surrounding view.
                event.preventDefault();
                event.stopPropagation();
                setDraft(null);
              }
            }}
          />
          {unit && <span aria-hidden="true">{unit}</span>}
        </label>
        {/* Announces the value as the buttons change it. */}
        <output className="visually-hidden" aria-live="polite">
          {unit ? `${format(value)} ${unit}` : format(value)}
        </output>
        <button
          type="button"
          aria-label={t("common.increase", { label })}
          aria-disabled={atMax || undefined}
          onClick={() => {
            if (!atMax) onChange(Math.min(max, value + step), "button");
          }}
        >
          <PlusIcon aria-hidden="true" weight="bold" />
        </button>
      </div>
    </div>
  );
}

/** A typed number, allowing a decimal comma and the stepper's own unit, or null. */
function parseEntry(entry: string, unit: string): number | null {
  let text = entry.trim().replace(",", ".");
  if (unit && text.endsWith(unit)) text = text.slice(0, -unit.length).trimEnd();
  if (text === "") return null;
  const typed = Number(text);
  return Number.isFinite(typed) ? typed : null;
}

function roundToStep(value: number, step: number) {
  const decimals = String(step).split(".")[1]?.length ?? 0;
  return Number((Math.round(value / step) * step).toFixed(decimals));
}

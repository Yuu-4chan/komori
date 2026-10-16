import { useId } from "react";

interface ToggleSettingProps {
  label: string;
  /** What the setting does, shown under its label and read as the switch's description. */
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

/**
 * A labelled on/off setting with a switch. In a Settings
 * list (`.settings-list`) it is one row of the list, its description under its label.
 */
export function ToggleSetting({
  label,
  description,
  checked,
  onChange,
  disabled,
}: ToggleSettingProps) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <button
      type="button"
      disabled={disabled}
      className={checked ? "toggle-setting toggle-setting--on" : "toggle-setting"}
      aria-pressed={checked}
      aria-labelledby={labelId}
      aria-describedby={description ? descriptionId : undefined}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-setting__text">
        <strong id={labelId}>{label}</strong>
        {description ? <small id={descriptionId}>{description}</small> : null}
      </span>
      <span className="toggle-setting__switch" aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

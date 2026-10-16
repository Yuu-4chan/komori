interface SwitchProps {
  /** The accessible name; the switch shows no text of its own. */
  label: string;
  checked: boolean;
  disabled?: boolean;
  className?: string;
  onChange: (checked: boolean) => void;
}

/** A standalone on/off switch with the same track as `ToggleSetting`, for rows with their own text. */
export function Switch({ label, checked, disabled, className, onChange }: SwitchProps) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={["switch", className].filter(Boolean).join(" ")}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      title={label}
      type="button"
    >
      <span className="toggle-setting__switch" aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

import { useEffect, useId, useState } from "react";

interface TextFieldProps {
  label: string;
  value: string;
  maxLength?: number;
  autoFocus?: boolean;
  /**
   * Whether a typed value can apply. A value that cannot is kept in the field until it
   * can, or until leaving the field returns it to the current value.
   */
  accepts?: (value: string) => boolean;
  onChange: (value: string) => void;
}

/** A labelled one-line text field in the style of the settings fields. */
export function TextField({
  label,
  value,
  maxLength,
  autoFocus,
  accepts = () => true,
  onChange,
}: TextFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  return (
    <div className="text-field">
      <label className="text-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="text-field__input"
        value={draft}
        maxLength={maxLength}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (accepts(next)) onChange(next);
        }}
        onBlur={() => {
          if (!accepts(draft)) setDraft(value);
        }}
      />
    </div>
  );
}

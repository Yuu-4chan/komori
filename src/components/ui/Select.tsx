import { CaretUpDownIcon } from "@phosphor-icons/react";
import { useId } from "react";

interface SelectOption<T extends string> {
  value: T;
  label: string;
}

interface SelectProps<T extends string> {
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}

/** A labelled native select, shown as a pop-up button; Komori draws its options. */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: SelectProps<T>) {
  const id = useId();
  return (
    <div className="select-field">
      <div className="select-field__label">
        <label htmlFor={id}>{label}</label>
      </div>
      <span className="select-control">
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <CaretUpDownIcon aria-hidden="true" weight="bold" />
      </span>
    </div>
  );
}

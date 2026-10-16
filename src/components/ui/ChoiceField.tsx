import { SegmentedControl, type SegmentedOption } from "./SegmentedControl";

interface ChoiceFieldProps<Value extends string> {
  label: string;
  value: Value;
  options: SegmentedOption<Value>[];
  onChange: (value: Value) => void;
}

/** A labelled choice of a few options. */
export function ChoiceField<Value extends string>({
  label,
  value,
  options,
  onChange,
}: ChoiceFieldProps<Value>) {
  return (
    <div className="choice-field">
      <span className="choice-field__label" aria-hidden="true">
        {label}
      </span>
      <SegmentedControl label={label} value={value} options={options} onChange={onChange} />
    </div>
  );
}

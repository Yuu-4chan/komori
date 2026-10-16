export interface SegmentedOption<Value extends string> {
  label: string;
  value: Value;
}

interface SegmentedControlProps<Value extends string> {
  label: string;
  onChange: (value: Value) => void;
  options: SegmentedOption<Value>[];
  value: Value;
}

export function SegmentedControl<Value extends string>({
  label,
  onChange,
  options,
  value,
}: SegmentedControlProps<Value>) {
  return (
    <div className="segmented-control" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          aria-pressed={option.value === value}
          className={option.value === value ? "is-active" : undefined}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

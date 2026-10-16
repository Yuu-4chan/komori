import { CheckIcon } from "@phosphor-icons/react";
import type { InputHTMLAttributes, Ref } from "react";

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  ref?: Ref<HTMLInputElement>;
};

/** One box treatment for native checkboxes and the indicators of existing choice controls. */
export function SelectionBox({
  checked,
  className = "",
}: {
  checked: boolean;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={`selection-box ${className}`} data-checked={checked}>
      <CheckIcon weight="bold" />
    </span>
  );
}

/**
 * The chosen option's check mark in a single-choice menu or list, like a system menu: an empty
 * column of the same width marks the others, so every label lines up.
 */
export function ChoiceCheck({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden="true" className="choice-check" data-checked={checked}>
      {checked ? <CheckIcon weight="bold" /> : null}
    </span>
  );
}

function SelectionInput({
  className = "",
  checked = false,
  type,
  ...props
}: InputProps & { type: "checkbox" | "radio" }) {
  return (
    <span className={`selection-checkbox ${className}`} data-kind={type}>
      <input {...props} checked={checked} type={type} />
      <SelectionBox checked={checked} />
    </span>
  );
}

export function SelectionCheckbox(props: InputProps) {
  return <SelectionInput {...props} type="checkbox" />;
}

export function SelectionRadio(props: InputProps) {
  return <SelectionInput {...props} type="radio" />;
}

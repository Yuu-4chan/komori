import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Stepper, type StepperSource } from "./Stepper";

function Harness({
  initial,
  onChange,
  step = 0.05,
  unit,
  format = (value: number) => value.toFixed(2),
}: {
  initial: number;
  onChange: (value: number, source: StepperSource) => void;
  step?: number;
  unit?: string;
  format?: (value: number) => string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <Stepper
        label="Line height"
        value={value}
        min={1}
        max={3}
        step={step}
        unit={unit}
        format={format}
        onChange={(next, source) => {
          onChange(next, source);
          setValue(next);
        }}
      />
      <button type="button">Elsewhere</button>
    </>
  );
}

describe("Stepper", () => {
  it("shows its value in a field labelled with its label, with the unit beside it", () => {
    render(<Harness initial={16} step={1} unit="px" format={String} onChange={vi.fn()} />);
    const field = screen.getByRole("textbox", { name: "Line height" });
    expect(field).toHaveValue("16");
    expect(screen.getByRole("group", { name: "Line height" })).toHaveTextContent("16 px");
    expect(screen.getByText("px", { selector: "span" })).toBeInTheDocument();
    // The announced value reads its unit as a word.
    expect(document.querySelector("output")?.textContent).toBe("16 px");
  });

  it("applies a typed value on Enter, rounded to the step, and shows the applied value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={1.65} onChange={onChange} />);
    const field = screen.getByRole("textbox", { name: "Line height" });

    await user.click(field);
    // Focusing selects the value, so typing replaces it.
    await user.keyboard("1.83{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(1.85, "entry");
    expect(field).toHaveValue("1.85");
    expect(field).toHaveFocus();

    await user.clear(field);
    await user.keyboard("2,1{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(2.1, "entry");
    expect(field).toHaveValue("2.10");
  });

  it("applies a typed value on leaving the field and clamps it to the range", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={1.65} onChange={onChange} />);
    const field = screen.getByRole("textbox", { name: "Line height" });

    await user.clear(field);
    await user.type(field, "9");
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith(3, "entry");
    expect(field).toHaveValue("3.00");
    expect(screen.getByRole("button", { name: "Increase Line height" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    await user.clear(field);
    await user.type(field, "-4");
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(onChange).toHaveBeenLastCalledWith(1, "entry");
    expect(field).toHaveValue("1.00");
  });

  it("accepts its own unit and keeps the current value for Escape, empty, or non-numeric entries", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const outside = vi.fn();
    render(
      <div onKeyDown={(event) => outside(event.key)}>
        <Harness initial={16} step={1} unit="px" format={String} onChange={onChange} />
      </div>,
    );
    const field = screen.getByRole("textbox", { name: "Line height" });

    await user.clear(field);
    await user.type(field, "2.5 px{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(3, "entry");
    onChange.mockClear();

    await user.clear(field);
    await user.type(field, "2");
    await user.keyboard("{Escape}");
    expect(field).toHaveValue("3");
    // Escape cancelled the entry, so it does not also reach the surrounding view.
    expect(outside).not.toHaveBeenCalledWith("Escape");
    await user.tab();

    await user.clear(field);
    await user.tab();
    expect(field).toHaveValue("3");

    await user.clear(field);
    await user.type(field, "big{Enter}");
    expect(field).toHaveValue("3");

    // The same value as shown is not a change.
    await user.clear(field);
    await user.type(field, "3.2{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(field).toHaveValue("3");

    // Escape with nothing typed is left to the surrounding view.
    await user.keyboard("{Escape}");
    expect(outside).toHaveBeenCalledWith("Escape");
  });

  it("reports button steps as such and keeps their limits", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={2.95} onChange={onChange} />);
    const increase = screen.getByRole("button", { name: "Increase Line height" });
    await user.click(increase);
    expect(onChange).toHaveBeenLastCalledWith(3, "button");
    await user.click(increase);
    expect(onChange).toHaveBeenCalledOnce();
    expect(increase).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Line height" })).toHaveValue("3.00");
  });
});

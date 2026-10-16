import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it } from "vitest";
import { SelectionCheckbox, SelectionRadio } from "./SelectionBox";

it("boxed inputs keep label clicks, Space, disabled state and native radio arrow navigation", async () => {
  function Choices() {
    const [checked, setChecked] = useState(false);
    const [choice, setChoice] = useState("one");
    return (
      <>
        <label>
          <SelectionCheckbox checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          Include
        </label>
        <SelectionCheckbox
          aria-label="Unavailable"
          checked={false}
          disabled
          onChange={() => setChecked(true)}
        />
        {["one", "two"].map((value) => (
          <label key={value}>
            <SelectionRadio
              checked={choice === value}
              name="choice"
              onChange={() => setChoice(value)}
            />
            {value}
          </label>
        ))}
      </>
    );
  }
  const user = userEvent.setup();
  render(<Choices />);
  const box = screen.getByRole("checkbox", { name: "Include" });
  await user.click(screen.getByText("Include"));
  expect(box).toBeChecked();
  box.focus();
  await user.keyboard(" ");
  expect(box).not.toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: "Unavailable" }));
  expect(box).not.toBeChecked();
  screen.getByRole("radio", { name: "one" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("radio", { name: "two" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "two" })).toHaveFocus();
});

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ColorField, hexToHsv, hsvToHex } from "../ui/ColorField";
import { NativeSurfaces } from "./NativeSurfaces";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "pasted") }));

function Choice() {
  const [value, setValue] = useState("daily");
  return (
    <>
      <select aria-label="Frequency" value={value} onChange={(e) => setValue(e.target.value)}>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
      </select>
      <output>{value}</output>
    </>
  );
}

function Named() {
  const [value, setValue] = useState("");
  return (
    <>
      <input
        aria-label="Series name"
        list="names"
        onChange={(e) => setValue(e.target.value)}
        value={value}
      />
      <datalist id="names">
        <option value="Cat Tales" />
        <option value="Dog Days" />
      </datalist>
      <output>{value}</output>
    </>
  );
}

describe("Komori's own surfaces", () => {
  it("toggles an open select closed for a full pointer click, then reopens normally", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Choice />
        <NativeSurfaces />
      </>,
    );
    const select = screen.getByRole("combobox", { name: "Frequency" });
    await user.click(select);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.click(select);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(select).toHaveFocus();
    expect(select).toHaveValue("daily");
    await user.click(select);
    await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: "Daily" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(select).toHaveValue("daily");
    await user.click(select);
    await user.click(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("switches directly between select controls without keeping the old options", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Choice />
        <select aria-label="Position" defaultValue="beside">
          <option value="beside">Beside</option>
          <option value="above">Above</option>
        </select>
        <NativeSurfaces />
      </>,
    );
    await user.click(screen.getByRole("combobox", { name: "Frequency" }));
    await user.click(screen.getByRole("combobox", { name: "Position" }));
    expect(screen.getAllByRole("listbox")).toHaveLength(1);
    expect(screen.getByRole("listbox", { name: "Position" })).toBeInTheDocument();
    await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: "Above" }));
    expect(screen.getByRole("combobox", { name: "Position" })).toHaveValue("above");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows a select's options as Komori's list and chooses by pointer or keyboard", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Choice />
        <NativeSurfaces />
      </>,
    );
    const select = screen.getByRole("combobox", { name: "Frequency" });
    fireEvent.mouseDown(select, { button: 0 });
    const list = screen.getByRole("listbox", { name: "Frequency" });
    expect(within(list).getByRole("option", { name: "Daily" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(list).getByRole("option", { name: "Daily" })).toHaveFocus();
    // One choice: a check marks it, and no option shows a checkbox.
    expect(list.querySelectorAll(".selection-box")).toHaveLength(0);
    expect(list.querySelectorAll(".choice-check svg")).toHaveLength(1);
    await user.click(within(list).getByRole("option", { name: "Weekly" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("weekly");
    expect(select).toHaveFocus();

    fireEvent.keyDown(select, { key: "Enter" });
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("monthly");
    fireEvent.keyDown(select, { key: " " });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("monthly");
  });

  it("offers a field's suggestions while focus stays in the field", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Named />
        <NativeSurfaces />
      </>,
    );
    const field = screen.getByRole("combobox", { name: "Series name" });
    await user.click(field);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Cat Tales",
      "Dog Days",
    ]);
    await user.type(field, "do");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Dog Days"]);
    await user.keyboard("{ArrowDown}");
    expect(field).toHaveAttribute("aria-activedescendant");
    await user.keyboard("{Enter}");
    expect(field).toHaveValue("Dog Days");
    expect(screen.getByRole("status")).toHaveTextContent("Dog Days");
    expect(field).toHaveFocus();
  });

  it("gives a text field Komori's menu with what can be done there", async () => {
    render(
      <>
        <input aria-label="Search" defaultValue="cats" />
        <input aria-label="Locked" defaultValue="dogs" readOnly />
        <NativeSurfaces />
      </>,
    );
    const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Search" });
    field.focus();
    field.setSelectionRange(0, 2);
    fireEvent.contextMenu(field, { clientX: 10, clientY: 10 });
    const menu = screen.getByRole("menu", { name: "Text" });
    const item = (name: string) => within(menu).getByRole("menuitem", { name });
    expect(item("Cut")).toBeEnabled();
    expect(item("Copy")).toBeEnabled();
    expect(item("Paste")).toBeEnabled();
    fireEvent.click(item("Select all"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 4]);

    const locked = screen.getByRole<HTMLInputElement>("textbox", { name: "Locked" });
    locked.focus();
    locked.setSelectionRange(0, 0);
    fireEvent.contextMenu(locked);
    const second = screen.getByRole("menu", { name: "Text" });
    expect(within(second).getByRole("menuitem", { name: "Cut" })).toBeDisabled();
    expect(within(second).getByRole("menuitem", { name: "Copy" })).toBeDisabled();
    expect(within(second).getByRole("menuitem", { name: "Paste" })).toBeDisabled();
  });

  it("shows a title in Komori's tooltip", () => {
    vi.useFakeTimers();
    try {
      render(
        <>
          <button title="Add books" type="button">
            +
          </button>
          <NativeSurfaces />
        </>,
      );
      fireEvent.pointerOver(document.querySelector("button")!);
      act(() => vi.advanceTimersByTime(700));
      expect(document.querySelector(".app-tooltip")).toHaveTextContent("Add books");
      fireEvent.pointerDown(document.body);
      expect(document.querySelector(".app-tooltip")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Color field", () => {
  it("converts between HEX and hue, saturation and brightness", () => {
    for (const hex of ["#000000", "#ffffff", "#4f9a62", "#ff0000", "#123456", "#d9dce3"])
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    expect(hexToHsv("#00ff00")).toEqual({ h: 120, s: 1, v: 1 });
  });

  it("picks a color in Komori's picker instead of the system's", async () => {
    const user = userEvent.setup();
    const changes: string[] = [];
    function Field() {
      const [value, setValue] = useState("#4f9a62");
      return (
        <ColorField
          label="Accent"
          onChange={(next) => {
            changes.push(next);
            setValue(next);
          }}
          value={value}
        />
      );
    }
    render(<Field />);
    expect(document.querySelector('input[type="color"]')).toBeNull();
    await user.click(screen.getByRole("button", { name: "Choose accent color" }));
    const picker = screen.getByRole("dialog", { name: "Accent color" });
    const area = within(picker).getByRole("slider", { name: "Accent saturation and brightness" });
    expect(area).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(changes).toHaveLength(1);
    expect(hexToHsv(changes[0]).v).toBeGreaterThan(hexToHsv("#4f9a62").v);
    expect(screen.getByRole("textbox", { name: "Accent HEX" })).toHaveValue(changes[0]);
    const hue = within(picker).getByRole("slider", { name: "Accent hue" });
    hue.focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    // A tenth of the way round, give or take the rounding of a HEX color.
    expect(Math.abs(hexToHsv(changes.at(-1)!).h - hexToHsv(changes[0]).h - 36)).toBeLessThan(2);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose accent color" })).toHaveFocus();
  });
});

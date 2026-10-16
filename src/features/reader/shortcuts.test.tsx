import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppearanceProvider, useAppearance } from "../appearance/AppearanceProvider";
import { commandShortcuts, commandTarget, shortcutCommand } from "./shortcuts";
import { SettingsPage } from "../../pages/SettingsPage";

function Preferences() {
  const appearance = useAppearance();
  return (
    <button
      onClick={() => {
        appearance.setReaderPopupTriggers({
          readerPopupShortcutPreset: "alt-x",
          readerPopupKeyboardShortcut: false,
        });
        appearance.setReaderPopupAnkiAction(false);
      }}
    >
      Change lookup configuration
    </button>
  );
}
describe("shortcut reference and exact dispatch", () => {
  it.each(commandShortcuts)(
    "dispatches $context $binding with only its exact modifiers",
    (shortcut) => {
      const modifiers = {
        ctrlKey: shortcut.modifier === "ctrl",
        altKey: shortcut.modifier === "alt",
      };
      expect(
        shortcutCommand(
          new KeyboardEvent("keydown", { key: shortcut.key, ...modifiers }),
          shortcut.context,
        ),
      ).toBe(shortcut.id);
      for (const exclusion of [
        { shiftKey: true },
        { metaKey: true },
        { repeat: true },
        { isComposing: true },
        { ctrlKey: !modifiers.ctrlKey },
        { altKey: !modifiers.altKey },
      ]) {
        expect(
          shortcutCommand(
            new KeyboardEvent("keydown", { key: shortcut.key, ...modifiers, ...exclusion }),
            shortcut.context,
          ),
        ).not.toBe(shortcut.id);
      }
    },
  );
  it("excludes editable targets across realms and existing control keys", () => {
    for (const html of [
      "<input>",
      "<textarea></textarea>",
      "<select></select>",
      '<div contenteditable="plaintext-only"></div>',
      '<div role="textbox"></div>',
    ]) {
      const root = document.createElement("div");
      root.innerHTML = html;
      const event = new KeyboardEvent("keydown", { key: "b" });
      Object.defineProperty(event, "target", { value: root.firstChild });
      expect(shortcutCommand(event, "Reader")).toBeNull();
      expect(commandTarget(root.firstChild)).toBe(false);
    }
    expect(commandTarget(document.createElement("button"))).toBe(false);
    expect(commandTarget(document.createElement("button"), true)).toBe(true);
    expect(commandTarget(document.createElement("textarea"), true)).toBe(false);
    const event = new KeyboardEvent("keydown", { key: "b", cancelable: true });
    event.preventDefault();
    expect(shortcutCommand(event, "Reader")).toBeNull();
  });
  it("opens through the section URL and lists every dispatched command, current lookup preset and disabled state", () => {
    render(
      <MemoryRouter initialEntries={["/settings?section=shortcuts"]}>
        <AppearanceProvider store={null}>
          <Preferences />
          <SettingsPage />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Shortcuts" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // A category is named by its title and described by the line under it.
    expect(screen.getByRole("button", { name: "Shortcuts" })).toHaveAccessibleDescription(
      "Keys and availability",
    );
    expect(screen.getByRole("button", { name: "Anki" })).not.toHaveAttribute("aria-pressed");
    for (const shortcut of commandShortcuts) {
      const group = screen.getByRole("heading", { name: shortcut.context }).closest("section")!;
      const row = within(group).getByText(shortcut.action).closest("tr")!;
      expect(within(row).getByText(shortcut.binding)).toBeInTheDocument();
    }
    // The Library's books and the Statistics calendar move by arrows within one Tab stop.
    const library = screen.getByRole("heading", { name: "Library" }).closest("section")!;
    for (const [binding, action] of [
      ["Arrows", "Move between books"],
      ["Space", "Select the focused book"],
      ["Shift+F10 / Menu key", "Open the focused book’s actions"],
      ["Escape / Alt+Left", "Return to the whole Library"],
    ])
      expect(within(library).getByText(action).closest("tr")).toHaveTextContent(binding);
    expect(screen.getByText("Move between days").closest("tr")).toHaveTextContent(
      "Arrows, Home / End",
    );
    expect(screen.getByText("Shift+Enter")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Change lookup configuration"));
    expect(screen.getByText("Alt+X")).toBeInTheDocument();
    expect(screen.getByText("Look up selected book text").closest("tr")).toHaveTextContent(
      "Disabled",
    );
    expect(
      screen.getByText("Open active expression in Anki Browser").closest("tr"),
    ).toHaveTextContent("disabled");
  });
});

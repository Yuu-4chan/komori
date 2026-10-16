import { MemoryRouter } from "react-router-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppearanceProvider } from "../appearance/AppearanceProvider";
import {
  defaultAppearance,
  normalizeAppearancePreferences,
} from "../appearance/appearancePreferences";
import {
  defaultLookupTriggers,
  normalizeLookupTriggers,
  shortcutPresets,
  mouseTriggers,
  popupCloseBehaviors,
  readingPositions,
  lookupTextAllowed,
} from "./lookupTriggers";
import { ReaderPopupSettings } from "./ReaderPopupSettings";

describe("Lookup trigger preferences", () => {
  it("accepts Han extensions, both kana scripts and Hangul, ignoring Latin, punctuation and ruby readings", () => {
    const settings = { ...defaultLookupTriggers, readerPopupCjkOnly: true };
    for (const text of ["は", "カナ", "ｶﾅ", "𠮷", "한글", "English 日本"])
      expect(lookupTextAllowed(settings, text)).toBe(true);
    for (const text of ["English", "123", "。！？", " "])
      expect(lookupTextAllowed(settings, text)).toBe(false);
    expect(lookupTextAllowed(defaultLookupTriggers, "English")).toBe(true);
  });

  it("keeps legacy defaults and independently rejects invalid stored fields", () => {
    expect({ ...defaultLookupTriggers, ...normalizeLookupTriggers({}) }).toEqual(
      defaultLookupTriggers,
    );
    for (const [field, value] of Object.entries(defaultLookupTriggers)) {
      expect(normalizeLookupTriggers({ [field]: value })).toEqual({ [field]: value });
      for (const invalid of [null, [], {}, "unknown", -1, 1201, 420.5]) {
        expect(normalizeAppearancePreferences({ [field]: invalid, readerFontSize: 22 })).toEqual({
          readerFontSize: 22,
        });
      }
    }
    // Zero scans without waiting.
    for (const delay of [0, 150, 420, 1200])
      expect(normalizeLookupTriggers({ readerPopupHoverDelay: delay })).toEqual({
        readerPopupHoverDelay: delay,
      });
    for (const [field, valid, invalid] of [
      ["readerPopupScanLength", [1, 16, 64], [0, 65]],
      ["readerPopupMaxResults", [1, 32, 64], [0, 65]],
      ["readerPopupChildLevels", [0, 2, 5], [6]],
    ] as const) {
      for (const value of valid)
        expect(normalizeLookupTriggers({ [field]: value })).toEqual({ [field]: value });
      for (const value of invalid) expect(normalizeLookupTriggers({ [field]: value })).toEqual({});
    }
    for (const [field, options] of [
      ["readerPopupShortcutPreset", shortcutPresets],
      ["readerPopupMouseTrigger", mouseTriggers],
      ["readerPopupCloseBehavior", popupCloseBehaviors],
      ["readerPopupReadingPosition", readingPositions],
    ] as const)
      for (const { value } of options)
        expect(normalizeLookupTriggers({ [field]: value })).toEqual({ [field]: value });
  });

  it("saves the complete trigger card and restores all choices after reopening", async () => {
    const saved = { ...defaultAppearance };
    const store = {
      load: async () => saved,
      save: vi.fn(async (next) => {
        Object.assign(saved, next);
      }),
    };
    const mount = () =>
      render(
        <MemoryRouter>
          <AppearanceProvider store={store}>
            <ReaderPopupSettings />
            {/* Reading position is a design choice, in Appearance. */}
          </AppearanceProvider>
        </MemoryRouter>,
      );
    const view = mount();
    await screen.findByRole("group", { name: "Lookup triggers" });
    for (const label of [
      "Keyboard shortcut",
      "Mouse selection",
      "Click lookup",
      "Hover lookup",
      "Shift lookup",
      "Only look up Japanese/CJK text",
    ])
      fireEvent.click(screen.getByRole("button", { name: label }));
    fireEvent.change(screen.getByLabelText("Shortcut preset"), { target: { value: "ctrl-space" } });
    fireEvent.change(screen.getByLabelText("Mouse trigger"), { target: { value: "shift-right" } });
    fireEvent.change(screen.getByLabelText("Popup close behavior"), {
      target: { value: "persistent" },
    });
    // Each stepper value is typed and applied with Enter; 0 ms scans without waiting.
    for (const [label, value] of [
      ["Scan delay", "0"],
      ["Scan length", "32"],
      ["Maximum results", "10"],
      ["Child popup levels", "0"],
    ]) {
      fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value } });
      fireEvent.keyDown(screen.getByRole("textbox", { name: label }), { key: "Enter" });
    }
    fireEvent.change(screen.getByLabelText("Reading position"), { target: { value: "above" } });
    await waitFor(() => expect(saved.readerPopupReadingPosition).toBe("above"));
    expect(saved).toMatchObject({
      readerPopupHoverDelay: 0,
      readerPopupScanLength: 32,
      readerPopupMaxResults: 10,
      readerPopupChildLevels: 0,
    });
    expect(saved).toMatchObject({
      readerPopupKeyboardShortcut: false,
      readerPopupMouseSelection: true,
      readerPopupClickLookup: true,
      readerPopupHoverLookup: true,
      readerPopupShiftLookup: false,
      readerPopupCjkOnly: true,
      readerPopupShortcutPreset: "ctrl-space",
      readerPopupMouseTrigger: "shift-right",
      readerPopupCloseBehavior: "persistent",
    });
    view.unmount();
    mount();
    expect(await screen.findByRole("button", { name: "Shift lookup" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByLabelText("Shortcut preset")).toHaveValue("ctrl-space");
    expect(screen.getByLabelText("Mouse trigger")).toHaveValue("shift-right");
    expect(screen.getByLabelText("Popup close behavior")).toHaveValue("persistent");
    expect(screen.getByRole("textbox", { name: "Scan delay" })).toHaveValue("0");
    expect(screen.getByRole("textbox", { name: "Scan length" })).toHaveValue("32");
    expect(screen.getByRole("textbox", { name: "Maximum results" })).toHaveValue("10");
    expect(screen.getByRole("textbox", { name: "Child popup levels" })).toHaveValue("Off");
    expect(screen.getByLabelText("Reading position")).toHaveValue("above");
    expect(screen.getByRole("button", { name: "Only look up Japanese/CJK text" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

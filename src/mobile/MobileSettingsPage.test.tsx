import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../features/appearance/AppearanceProvider";

vi.mock("../app/platform", () => ({ isAndroid: true }));

const { MobileSettingsPage } = await import("./MobileSettingsPage");

function settings(section?: string) {
  render(
    <MemoryRouter initialEntries={[section ? `/settings?section=${section}` : "/settings"]}>
      <AppearanceProvider store={null}>
        <MobileSettingsPage />
      </AppearanceProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe("Settings on the phone", () => {
  it("lists the phone's sections, each opening as its own page", async () => {
    settings();
    const nav = screen.getByRole("navigation", { name: "Settings categories" });
    expect(
      within(nav)
        .getAllByRole("button")
        .map((row) => row.textContent),
    ).toEqual([
      "General",
      "Reader popup",
      "Dictionary",
      "AnkiAnkiDroid",
      "SyncNot paired",
      "About",
    ]);
    await userEvent.click(within(nav).getByRole("button", { name: "Dictionary" }));
    expect(screen.getByRole("heading", { level: 1, name: "Dictionary" })).toBeTruthy();
  });

  it("shows the popup settings that apply to a lookup by touch", () => {
    settings("popup");
    expect(screen.getByRole("heading", { name: "Lookup appearance" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Scanning and results" })).toBeTruthy();
    expect(screen.getByText("Scan length")).toBeTruthy();
    expect(screen.getByText("Font size")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Lookup triggers" })).toBeNull();
    expect(screen.getByText("Popup width")).toBeTruthy();
    expect(screen.getByText("Popup height")).toBeTruthy();
    expect(screen.getByText("Rounded corners")).toBeTruthy();
    expect(screen.getByText("Add to Anki action")).toBeTruthy();
    // The phone has no preview popup.
    expect(document.querySelector(".reader-lookup")).toBeNull();
  });

  it("looks up a tapped word by choice", async () => {
    settings("popup");
    const tapLookup = screen.getByRole("button", { name: "Tap a word to look it up" });
    expect(tapLookup.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(tapLookup);
    expect(tapLookup.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("combobox", { name: "Show lookups in" })).toBeNull();
  });

  it("shows the dictionaries, their language and word audio", () => {
    settings("dictionary");
    expect(screen.getByRole("combobox", { name: "Lookup language" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add dictionaries" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Word audio" })).toBeTruthy();
    expect(screen.queryByText(/Alt\+/)).toBeNull();
  });
});

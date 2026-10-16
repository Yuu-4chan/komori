import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceProvider } from "../appearance/AppearanceProvider";
import { SettingsPage } from "../../pages/SettingsPage";
import { GeneralSettings } from "./GeneralSettings";
import {
  defaultStartupPreferences,
  getStartupPreferences,
  saveStartupPreferences,
} from "./startupApi";

vi.mock("./startupApi", async (original) => ({
  ...(await original<typeof import("./startupApi")>()),
  getStartupPreferences: vi.fn(),
  saveStartupPreferences: vi.fn(),
}));

describe("Startup choices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStartupPreferences).mockResolvedValue(defaultStartupPreferences);
  });

  it("opens General by URL and saves every choice by keyboard, reading the native result on reopen", async () => {
    const user = userEvent.setup();
    let saved = { ...defaultStartupPreferences };
    vi.mocked(getStartupPreferences).mockImplementation(async () => saved);
    vi.mocked(saveStartupPreferences).mockImplementation(async (patch) => {
      saved = { ...saved, ...patch };
      return saved;
    });
    const view = render(
      <MemoryRouter initialEntries={["/settings?section=general"]}>
        <AppearanceProvider store={null}>
          <SettingsPage />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "page");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Launch at startup" })).toBeEnabled(),
    );
    for (const [key, label, description] of [
      // A label that says what the switch does has no hint under it.
      ["launchAtStartup", "Launch at startup", ""],
      ["restoreLastBook", "Restore last book", ""],
      ["rememberWindowSize", "Remember window size and position", ""],
      ["minimizeToTray", "Minimize to tray", "Keep Komori available after closing the window."],
      ["checkForUpdates", "Check for updates automatically", ""],
    ] as const) {
      const toggle = screen.getByRole("button", { name: label });
      expect(toggle).toHaveAccessibleDescription(description);
      toggle.focus();
      await user.keyboard(" ");
      await waitFor(() =>
        expect(toggle).toHaveAttribute("aria-pressed", String(!defaultStartupPreferences[key])),
      );
      expect(saveStartupPreferences).toHaveBeenLastCalledWith({
        [key]: !defaultStartupPreferences[key],
      });
    }
    view.unmount();
    render(
      <AppearanceProvider store={null}>
        <GeneralSettings />
      </AppearanceProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Minimize to tray" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Remember window size and position" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps choices disabled during load/write and reports a failed write without claiming it saved", async () => {
    const user = userEvent.setup();
    let finish!: (value: typeof defaultStartupPreferences) => void;
    vi.mocked(getStartupPreferences).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(
      <AppearanceProvider store={null}>
        <GeneralSettings />
      </AppearanceProvider>,
    );
    const toggle = screen.getByRole("button", { name: "Launch at startup" });
    expect(toggle).toBeDisabled();
    finish(defaultStartupPreferences);
    await waitFor(() => expect(toggle).toBeEnabled());
    let reject!: (error: Error) => void;
    vi.mocked(saveStartupPreferences).mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    await user.click(toggle);
    expect(toggle).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restore last book" })).toBeDisabled();
    reject(Error("registry denied"));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not save");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toBeEnabled();
  });

  it("retries a failed native load and reflects the actual startup entry", async () => {
    vi.mocked(getStartupPreferences)
      .mockRejectedValueOnce(Error("unavailable"))
      .mockResolvedValueOnce({ ...defaultStartupPreferences, launchAtStartup: true });
    render(
      <AppearanceProvider store={null}>
        <GeneralSettings />
      </AppearanceProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("could not read");
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Launch at startup" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  });
});

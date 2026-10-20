import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceProvider } from "../appearance/AppearanceProvider";
import { SettingsPage } from "../../pages/SettingsPage";
import { DiscordSettings } from "./DiscordSettings";
import {
  defaultDiscordPreferences,
  getDiscordPreferences,
  saveDiscordPreferences,
  type DiscordPreferences,
} from "./discordApi";

vi.mock("./discordApi", async (original) => ({
  ...(await original<typeof import("./discordApi")>()),
  getDiscordPreferences: vi.fn(),
  saveDiscordPreferences: vi.fn(),
}));

const parts = ["Book title", "Book progress", "Chapter progress", "Reading speed"];

describe("Discord settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDiscordPreferences).mockResolvedValue(defaultDiscordPreferences);
  });

  it("opens under Integrations, turns the status on and saves each part, reading the native result on reopen", async () => {
    const user = userEvent.setup();
    let saved: DiscordPreferences = { ...defaultDiscordPreferences };
    vi.mocked(getDiscordPreferences).mockImplementation(async () => saved);
    vi.mocked(saveDiscordPreferences).mockImplementation(async (patch) => {
      saved = { ...saved, ...patch };
      return saved;
    });
    const view = render(
      <MemoryRouter initialEntries={["/settings?section=discord"]}>
        <AppearanceProvider store={null}>
          <SettingsPage />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Discord" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("group", { name: "Integrations" })).toContainElement(
      screen.getByRole("button", { name: "Discord" }),
    );
    const enabled = screen.getByRole("button", { name: "Show reading status in Discord" });
    await waitFor(() => expect(enabled).toBeEnabled());
    expect(enabled).toHaveAttribute("aria-pressed", "false");
    expect(enabled).toHaveAccessibleDescription(
      "While Discord is open. After 5 minutes without reading, it shows Idle.",
    );
    // The parts wait for the status to be on.
    for (const label of parts) expect(screen.getByRole("button", { name: label })).toBeDisabled();
    const format = screen.getByLabelText("Book progress as");
    expect(format).toBeDisabled();

    enabled.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(enabled).toHaveAttribute("aria-pressed", "true"));
    expect(saveDiscordPreferences).toHaveBeenLastCalledWith({ enabled: true });
    await waitFor(() => expect(format).toBeEnabled());
    expect(format).toHaveValue("percentage");
    await user.selectOptions(format, "position");
    await waitFor(() => expect(format).toHaveValue("position"));
    expect(saveDiscordPreferences).toHaveBeenLastCalledWith({ bookProgressFormat: "position" });
    for (const [key, label] of [
      ["showBookTitle", "Book title"],
      ["showBookProgress", "Book progress"],
      ["showChapterProgress", "Chapter progress"],
      ["showReadingSpeed", "Reading speed"],
    ] as const) {
      const toggle = screen.getByRole("button", { name: label });
      await waitFor(() => expect(toggle).toBeEnabled());
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      await user.click(toggle);
      await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
      expect(saveDiscordPreferences).toHaveBeenLastCalledWith({ [key]: false });
    }
    // Hiding book progress leaves nothing for its format to choose.
    expect(format).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reading speed" })).toHaveAccessibleDescription(
      "Shown while reading statistics are on, after a minute of reading.",
    );

    view.unmount();
    render(<DiscordSettings />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Show reading status in Discord" })).toBeEnabled(),
    );
    for (const label of parts)
      expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "false");
  });

  it("reports read and save failures and retries a failed read", async () => {
    const user = userEvent.setup();
    vi.mocked(getDiscordPreferences).mockRejectedValueOnce(Error("unavailable"));
    render(<DiscordSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Komori could not read your Discord choices.",
    );
    expect(screen.getByRole("button", { name: "Show reading status in Discord" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    const enabled = screen.getByRole("button", { name: "Show reading status in Discord" });
    await waitFor(() => expect(enabled).toBeEnabled());

    vi.mocked(saveDiscordPreferences).mockRejectedValueOnce(Error("locked"));
    await user.click(enabled);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Komori could not save this choice.",
    );
    expect(enabled).toHaveAttribute("aria-pressed", "false");
  });
});

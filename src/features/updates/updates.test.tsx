import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceProvider } from "../appearance/AppearanceProvider";
import { defaultStartupPreferences, getStartupPreferences } from "../startup/startupApi";
import { ReleaseNotes, STARTUP_CHECK_DELAY, UpdatesProvider } from "./updates";
import { UpdateSetting } from "./UpdateSetting";
import { checkForUpdate, installUpdate, type AvailableUpdate } from "./updatesApi";

const appWindow = vi.hoisted(() => ({
  isMaximized: vi.fn(async () => false),
  onResized: vi.fn(async () => () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => appWindow }));
vi.mock("../startup/startupApi", async (original) => ({
  ...(await original<typeof import("../startup/startupApi")>()),
  getStartupPreferences: vi.fn(),
}));
vi.mock("./updatesApi", () => ({ checkForUpdate: vi.fn(), installUpdate: vi.fn() }));

const update: AvailableUpdate = {
  version: "1.1.0",
  currentVersion: "1.0.0",
  notes: "### Reader\n\n- Faster pages.\n- Fixed <b>bold</b> titles\n  in vertical books.\nThanks!",
};

function renderUpdates() {
  return render(
    <AppearanceProvider store={null}>
      <UpdatesProvider>
        <UpdateSetting />
      </UpdatesProvider>
    </AppearanceProvider>,
  );
}

describe("Updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStartupPreferences).mockResolvedValue(defaultStartupPreferences);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a changelog as text, with lists, headings and paragraphs", () => {
    render(<ReleaseNotes notes={update.notes} />);
    const notes = screen.getByRole("region");
    expect(within(notes).getByRole("heading", { level: 3 })).toHaveTextContent("Reader");
    expect(
      within(notes)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Faster pages.", "Fixed <b>bold</b> titles in vertical books."]);
    expect(notes.querySelector("b")).toBeNull();
    expect(within(notes).getByText("Thanks!").tagName).toBe("P");
  });

  it("checks once after launch and asks before installing, with the release's changelog", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(checkForUpdate).mockResolvedValue(update);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderUpdates();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY - 100);
    });
    expect(checkForUpdate).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    const dialog = await screen.findByRole("dialog", { name: "Komori 1.1.0 is available" });
    expect(dialog).toHaveAccessibleDescription(
      "You have 1.0.0. Komori closes to install the update and opens again.",
    );
    expect(within(dialog).getByRole("region", { name: "What's new" })).toHaveTextContent(
      "Faster pages.",
    );
    expect(installUpdate).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Komori 1.1.0 is available.");
    await user.click(screen.getByRole("button", { name: "Show update" }));
    await user.click(screen.getByRole("button", { name: "Install and restart" }));
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not check by itself when automatic checks are off, and a failed automatic check stays quiet", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getStartupPreferences).mockResolvedValue({
      ...defaultStartupPreferences,
      checkForUpdates: false,
    });
    const view = renderUpdates();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY * 2);
    });
    expect(checkForUpdate).not.toHaveBeenCalled();
    view.unmount();

    vi.mocked(getStartupPreferences).mockResolvedValue(defaultStartupPreferences);
    vi.mocked(checkForUpdate).mockRejectedValue("failure.updateCheck");
    renderUpdates();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY * 2);
    });
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).not.toHaveTextContent("could not");
  });

  it("reports a manual check's result and failures, and an install failure in the dialog", async () => {
    const user = userEvent.setup();
    vi.mocked(getStartupPreferences).mockResolvedValue({
      ...defaultStartupPreferences,
      checkForUpdates: false,
    });
    vi.mocked(checkForUpdate)
      .mockRejectedValueOnce("failure.updateCheck")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(update);
    vi.mocked(installUpdate).mockRejectedValue("failure.updateInstall");
    renderUpdates();
    const check = screen.getByRole("button", { name: "Check for updates" });
    await user.click(check);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Komori could not check for updates. Check your connection and try again.",
      ),
    );
    await user.click(check);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("is up to date."));
    await user.click(check);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Install and restart" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The update could not be downloaded or verified. Try again later.",
    );
    expect(within(dialog).getByRole("button", { name: "Install and restart" })).toBeEnabled();
  });
});

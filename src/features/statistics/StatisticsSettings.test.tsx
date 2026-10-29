import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../appearance/AppearanceProvider";
import type { AppearancePreferences } from "../appearance/appearancePreferences";
import { StatisticsSettings } from "./StatisticsSettings";
import { deleteReadingSessions, getStatisticsCounts } from "./statisticsApi";

vi.mock("./statisticsApi", () => ({
  getStatisticsCounts: vi.fn(),
  deleteReadingSessions: vi.fn(),
}));

function renderSettings() {
  const saved: AppearancePreferences[] = [];
  render(
    <AppearanceProvider
      store={{
        load: async () => ({}),
        save: async (preferences) => {
          saved.push(preferences);
        },
      }}
    >
      <StatisticsSettings />
    </AppearanceProvider>,
  );
  return saved;
}

describe("Settings > Statistics", () => {
  it("saves recording, session start and jump limit at once", async () => {
    vi.mocked(getStatisticsCounts).mockResolvedValue({
      sessions: 0,
      orphanSessions: 0,
      orphanBooks: 0,
    });
    const user = userEvent.setup();
    const saved = renderSettings();
    const record = await screen.findByRole("button", { name: "Record reading statistics" });
    expect(record).toHaveAttribute("aria-pressed", "true");
    await user.click(record);
    await waitFor(() => expect(saved.at(-1)?.statisticsEnabled).toBe(false));

    const start = screen.getByRole("combobox", { name: "Session start" });
    expect(start).toHaveValue("auto");
    await user.selectOptions(start, "manual");
    await waitFor(() => expect(saved.at(-1)?.statisticsSessionStart).toBe("manual"));
    expect(screen.getByText(/press P in the reader/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Decrease Jump limit" }));
    await waitFor(() => expect(saved.at(-1)?.statisticsJumpLimit).toBe(4_900));
    // Short values that fit the control column: the jump limit's unit is in its hint.
    expect(screen.getByText("4,900")).toBeInTheDocument();
    expect(screen.getByText(/more than this many characters or words/)).toBeInTheDocument();
    expect(screen.getByText("5 min")).toBeInTheDocument();
    // Nothing recorded: both deletions are unavailable.
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete all" })).toBeDisabled();
  });

  it("deletes removed books' statistics or all of them only after confirmation", async () => {
    vi.mocked(getStatisticsCounts)
      .mockResolvedValueOnce({ sessions: 12, orphanSessions: 3, orphanBooks: 1 })
      .mockResolvedValueOnce({ sessions: 9, orphanSessions: 0, orphanBooks: 0 })
      .mockResolvedValueOnce({ sessions: 0, orphanSessions: 0, orphanBooks: 0 });
    vi.mocked(deleteReadingSessions).mockResolvedValueOnce(3).mockResolvedValueOnce(9);
    const user = userEvent.setup();
    renderSettings();
    expect(await screen.findByText("3 sessions of 1 book no longer in the library.")).toBeVisible();
    expect(screen.getByText(/Komori holds 12 sessions/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    let dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAccessibleName("Delete removed books' statistics?");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(deleteReadingSessions).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() => expect(deleteReadingSessions).toHaveBeenCalledWith(true));
    expect(await screen.findByText("Deleted 3 sessions.")).toBeInTheDocument();
    expect(screen.getByText(/Every recorded session belongs to a book/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete all" }));
    dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete all 9 sessions?");
    await user.click(within(dialog).getByRole("button", { name: "Delete all statistics" }));
    await waitFor(() => expect(deleteReadingSessions).toHaveBeenLastCalledWith(false));
    expect(await screen.findByText("Deleted 9 sessions.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete all" })).toBeDisabled();
  });
});

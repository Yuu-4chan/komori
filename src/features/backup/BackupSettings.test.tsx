import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../appearance/AppearanceProvider";
import {
  createSnapshot,
  deleteSnapshot,
  exportBackup,
  getBackupSettings,
  listSnapshots,
  normalizePreview,
  openBackupFile,
  openSnapshot,
  restoreBackup,
  saveBackupSettings,
  type BackupPreview,
  type Snapshot,
} from "./backupApi";
import { BackupSettings } from "./BackupSettings";

vi.mock("./backupApi", async (original) => ({
  ...(await original<typeof import("./backupApi")>()),
  createSnapshot: vi.fn(),
  deleteSnapshot: vi.fn(),
  exportBackup: vi.fn(),
  getBackupSettings: vi.fn(),
  listSnapshots: vi.fn(),
  openBackupFile: vi.fn(),
  openSnapshot: vi.fn(),
  restoreBackup: vi.fn(),
  saveBackupSettings: vi.fn(),
}));

const snapshot: Snapshot = {
  id: "automatic-1759400000000",
  kind: "automatic",
  createdAt: 1_759_400_000_000,
  size: 2048,
};
const ready: BackupPreview = {
  status: "ready",
  token: "token-1",
  createdAt: 1_759_000_000_000,
  komoriVersion: "0.1.0",
  books: 3,
  matched: 2,
  unmatched: ["Book C"],
  unmatchedCount: 1,
  positions: 2,
  bookmarks: 4,
  sessions: 10,
  appearance: true,
  anki: true,
};

function renderBackup() {
  return render(
    <AppearanceProvider store={null}>
      <BackupSettings />
    </AppearanceProvider>,
  );
}

describe("Backup settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBackupSettings).mockResolvedValue({
      automatic: true,
      frequency: "daily",
      keep: 7,
    });
    vi.mocked(listSnapshots).mockResolvedValue([snapshot]);
    vi.mocked(saveBackupSettings).mockResolvedValue(true);
  });

  it("saves each automatic backup choice at once", async () => {
    const user = userEvent.setup();
    renderBackup();
    expect(await screen.findByText("Automatic · 2 KB")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Frequency"), "weekly");
    expect(saveBackupSettings).toHaveBeenLastCalledWith({
      automatic: true,
      frequency: "weekly",
      keep: 7,
    });
    await user.selectOptions(screen.getByLabelText("Keep"), "30");
    expect(saveBackupSettings).toHaveBeenLastCalledWith({
      automatic: true,
      frequency: "weekly",
      keep: 30,
    });
    await user.click(screen.getByRole("button", { name: "Automatic local backups" }));
    expect(saveBackupSettings).toHaveBeenLastCalledWith({
      automatic: false,
      frequency: "weekly",
      keep: 30,
    });
    // Saving can take a due snapshot, so the list is read again.
    expect(listSnapshots).toHaveBeenCalledTimes(4);
  });

  it("words an empty or unmatched backup without zero counts", async () => {
    const user = userEvent.setup();
    const empty = {
      ...ready,
      books: 0,
      matched: 0,
      unmatched: [],
      unmatchedCount: 0,
      positions: 0,
      bookmarks: 0,
      notes: 0,
      sessions: 0,
    };
    vi.mocked(openBackupFile).mockResolvedValueOnce(empty);
    renderBackup();
    await user.click(screen.getByRole("button", { name: /Import backup/ }));
    let dialog = await screen.findByRole("dialog", { name: "Restore this backup?" });
    expect(within(dialog).getByText("This backup holds no books.")).toBeInTheDocument();
    expect(
      within(dialog).getByText("No reading places, bookmarks, notes or reading sessions."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/(^|\s)0 /)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    vi.mocked(openBackupFile).mockResolvedValueOnce({ ...empty, books: 3, positions: 2 });
    await user.click(screen.getByRole("button", { name: /Import backup/ }));
    dialog = await screen.findByRole("dialog", { name: "Restore this backup?" });
    expect(
      within(dialog).getByText("No books in this backup match this library."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/All 0|0 of/)).toBeNull();
  });

  it("previews an imported backup and restores it only once confirmed", async () => {
    const user = userEvent.setup();
    vi.mocked(openBackupFile).mockResolvedValue(ready);
    vi.mocked(restoreBackup).mockResolvedValue({
      status: "restored",
      books: 2,
      unmatched: ["Book C"],
      unmatchedCount: 1,
      sessions: 10,
      snapshot: "restore-1",
    });
    renderBackup();
    await user.click(screen.getByRole("button", { name: /Import backup/ }));
    const dialog = await screen.findByRole("dialog", { name: "Restore this backup?" });
    expect(within(dialog).getByText(/2 of 3 books match this library/)).toBeInTheDocument();
    // Only what the backup holds is named: it has no notes.
    expect(
      within(dialog).getByText(/^2 reading places, 4 bookmarks, and 10 reading sessions \(added/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Not in this library, so not restored: Book C."));
    expect(within(dialog).getByText(/Appearance and reader settings and Anki setup/));
    expect(restoreBackup).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Restore" }));
    expect(restoreBackup).toHaveBeenCalledWith("token-1");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Restored 2 books, 10 reading sessions and your settings.",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 book in the backup is not in this library, so its places were not restored: Book C.",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("refuses foreign, newer and damaged files without a dialog", async () => {
    const user = userEvent.setup();
    renderBackup();
    for (const [status, text] of [
      ["foreign", "This file is not a Komori backup. Nothing was changed."],
      ["newer", "A newer version of Komori made this backup."],
      ["damaged", "This backup is damaged or incomplete"],
    ] as const) {
      vi.mocked(openBackupFile).mockResolvedValue(normalizePreview({ status }));
      await user.click(screen.getByRole("button", { name: /Import backup/ }));
      expect(await screen.findByRole("alert")).toHaveTextContent(text);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    }
    vi.mocked(openBackupFile).mockResolvedValue(normalizePreview({ status: "canceled" }));
    await user.click(screen.getByRole("button", { name: /Import backup/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  it("exports, takes snapshots, restores and deletes them", async () => {
    const user = userEvent.setup();
    vi.mocked(exportBackup).mockResolvedValue({
      status: "saved",
      fileName: "Komori backup 2026-10-02.komoribackup",
      books: 174,
      sessions: 1,
    });
    vi.mocked(createSnapshot).mockResolvedValue({ ...snapshot, id: "manual-1", kind: "manual" });
    vi.mocked(openSnapshot).mockResolvedValue({ ...ready, matched: 3, unmatched: [] });
    vi.mocked(deleteSnapshot).mockResolvedValue(true);
    renderBackup();
    await user.click(screen.getByRole("button", { name: /Export backup/ }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Saved Komori backup 2026-10-02.komoribackup with 174 books and 1 reading session.",
    );
    await user.click(screen.getByRole("button", { name: /Create snapshot/ }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved a snapshot"));

    await user.click(await screen.findByRole("button", { name: /Restore the snapshot of/ }));
    expect(openSnapshot).toHaveBeenCalledWith(snapshot.id);
    const restore = await screen.findByRole("dialog", { name: "Restore this backup?" });
    expect(within(restore).getByText(/All 3 books match this library/)).toBeInTheDocument();
    await user.click(within(restore).getByRole("button", { name: "Cancel" }));
    expect(restoreBackup).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Delete the snapshot of/ }));
    const confirm = await screen.findByRole("alertdialog", { name: "Delete this snapshot?" });
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    expect(deleteSnapshot).toHaveBeenCalledWith(snapshot.id);
  });

  it("returns focus to the button that opened a restore preview when it is cancelled", async () => {
    const user = userEvent.setup();
    let snapshotRead!: (preview: BackupPreview) => void;
    let fileRead!: (preview: BackupPreview) => void;
    vi.mocked(openSnapshot).mockReturnValue(new Promise((resolve) => (snapshotRead = resolve)));
    vi.mocked(openBackupFile).mockReturnValue(new Promise((resolve) => (fileRead = resolve)));
    renderBackup();
    for (const [name, opened] of [
      [/Restore the snapshot of/, () => snapshotRead(ready)],
      [/Import backup/, () => fileRead(ready)],
    ] as const) {
      const opener = await screen.findByRole("button", { name });
      opener.focus();
      await user.keyboard("{Enter}");
      // The opener is disabled while the preview loads, and the browser moves focus to the page
      // (jsdom does not, so a removed element stands in).
      expect(opener).toBeDisabled();
      const stand = document.body.appendChild(document.createElement("button"));
      stand.focus();
      stand.remove();
      expect(document.activeElement).toBe(document.body);
      act(opened);
      const dialog = await screen.findByRole("dialog", { name: "Restore this backup?" });
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
      // Escape, which jsdom does not turn into the dialog's cancel event itself.
      act(() => void dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(opener).toHaveFocus();
    }
  });
});

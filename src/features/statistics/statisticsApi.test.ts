import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { editDailyActivity, validDailyEdit, type DailyActivityEdit } from "./statisticsApi";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));

const edit: DailyActivityEdit = {
  bookId: "11111111-1111-4111-8111-111111111111",
  unit: "words",
  dayStart: +new Date(2026, 9, 15),
  dayEnd: +new Date(2026, 9, 16),
  unitsRead: 3000,
  activeMs: 1800000,
  expectedUnits: 6000,
  expectedActiveMs: 1200000,
  expectedSessions: 1,
};
beforeEach(() => vi.mocked(invoke).mockReset());

describe("daily activity API", () => {
  it("bounds both fields and identities before invoking native code", async () => {
    expect(validDailyEdit({ ...edit, unitsRead: 0, activeMs: 0 })).toBe(true);
    expect(validDailyEdit({ ...edit, unitsRead: 1000000000, activeMs: 86400000 })).toBe(true);
    for (const invalid of [
      { unitsRead: -1 },
      { unitsRead: 1.5 },
      { unitsRead: 1000000001 },
      { activeMs: NaN },
      { activeMs: 86400001 },
      { bookId: "C:/a.epub" },
      { dayEnd: edit.dayStart },
      { expectedSessions: 0 },
    ]) {
      await expect(editDailyActivity({ ...edit, ...invalid })).rejects.toThrow(
        "valid daily amount",
      );
    }
    expect(invoke).not.toHaveBeenCalled();
  });
  it("passes only the edit DTO and reports stale native refusal", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ status: "saved", sessions: [] });
    expect(await editDailyActivity(edit)).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("edit_daily_activity", { edit });
    vi.mocked(invoke).mockResolvedValueOnce({ status: "conflict", sessions: [] });
    await expect(editDailyActivity(edit)).rejects.toThrow("This day's reading changed");
    vi.mocked(invoke).mockResolvedValueOnce({ status: "missing", sessions: [] });
    await expect(editDailyActivity(edit)).rejects.toThrow("could not be saved");
  });
});

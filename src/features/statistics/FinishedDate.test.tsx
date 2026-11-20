import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";

import type { LibraryBook } from "../library/libraryApi";
import type { BookActivity, BookFinish } from "./statistics";
import { BookTotals, dateValue, finishedDayTime } from "./StatisticsCards";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => undefined,
  }),
}));
beforeEach(() => vi.mocked(invoke).mockReset());

const A = "11111111-1111-4111-8111-111111111111";
const book = { id: A, title: "Book A", fileName: "a.epub", hasCover: false } as LibraryBook;
const activity: BookActivity = {
  bookId: A,
  unit: "characters",
  unitsRead: 5000,
  activeMs: 3_600_000,
  sessions: 2,
  days: 2,
  lastReadAt: +new Date(2026, 9, 14, 21),
};

function open(finish: BookFinish | null, onSessionsChanged = vi.fn()) {
  const finishes = new Map(finish ? [[A, finish]] : []);
  const view = render(
    <BookTotals
      books={[activity]}
      finishes={finishes}
      library={new Map([[A, book]])}
      onSessionsChanged={onSessionsChanged}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Book A" }));
  return { view, field: screen.getByLabelText("Finished") as HTMLInputElement };
}

it("reads a date field's day as local noon from 2000 to today", () => {
  const now = +new Date(2026, 9, 15, 9);
  expect(finishedDayTime("2026-10-14", now)).toBe(+new Date(2026, 9, 14, 12));
  expect(finishedDayTime("2026-10-15", now)).toBe(+new Date(2026, 9, 15, 12));
  for (const value of ["", "0002-10-14", "1999-12-31", "2026-10-16", "2026-02-30", "2026-1-5"])
    expect(finishedDayTime(value, now)).toBeNull();
  expect(dateValue(+new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
});

it("shows the day a book was finished and saves a changed day", async () => {
  vi.mocked(invoke).mockResolvedValueOnce([]);
  const changed = vi.fn();
  const { field } = open({ at: +new Date(2026, 9, 3, 20), set: false }, changed);
  expect(field.value).toBe("2026-10-03");
  // A day read to the end has nothing to reset.
  expect(screen.queryByRole("button", { name: "Reset finished date" })).toBeNull();
  // A partly typed year is not saved.
  fireEvent.change(field, { target: { value: "0002-10-03" } });
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.change(field, { target: { value: "2026-10-01" } });
  await waitFor(() => expect(changed).toHaveBeenCalledWith([]));
  expect(invoke).toHaveBeenCalledWith("set_book_finished_date", {
    bookId: A,
    finishedAt: +new Date(2026, 9, 1, 12),
  });
});

it("resets a chosen day, and says so when saving fails", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null);
  const changed = vi.fn();
  const first = open(null, changed);
  expect(first.field.value).toBe("");
  const field = first.field;
  fireEvent.change(field, { target: { value: "2026-10-02" } });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The finished date could not be saved.",
  );
  expect(changed).not.toHaveBeenCalled();
  first.view.unmount();
  vi.mocked(invoke).mockResolvedValueOnce([]);
  open({ at: +new Date(2026, 9, 2, 12), set: true }, changed);
  fireEvent.click(screen.getByRole("button", { name: "Reset finished date" }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith([]));
  expect(invoke).toHaveBeenLastCalledWith("set_book_finished_date", {
    bookId: A,
    finishedAt: null,
  });
});

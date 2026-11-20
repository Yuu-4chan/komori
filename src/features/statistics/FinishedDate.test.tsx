import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 9, 15, 9));
});
afterEach(() => vi.useRealTimers());

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
  return { view, field: screen.getByRole("button", { name: /^Finished / }) };
}

const day = (name: RegExp) => screen.getByRole("button", { name });

it("reads a day as local noon from 2000 to today", () => {
  const now = +new Date(2026, 9, 15, 9);
  expect(finishedDayTime("2026-10-14", now)).toBe(+new Date(2026, 9, 14, 12));
  expect(finishedDayTime("2026-10-15", now)).toBe(+new Date(2026, 9, 15, 12));
  for (const value of ["", "0002-10-14", "1999-12-31", "2026-10-16", "2026-02-30", "2026-1-5"])
    expect(finishedDayTime(value, now)).toBeNull();
  expect(dateValue(+new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
});

it("shows the day a book was finished and saves a day chosen in the calendar", async () => {
  vi.mocked(invoke).mockResolvedValueOnce([]);
  const changed = vi.fn();
  const { field } = open({ at: +new Date(2026, 9, 3, 20), set: false }, changed);
  expect(field).toHaveAccessibleName("Finished Oct 3, 2026");
  // A day read to the end has nothing to reset.
  expect(screen.queryByRole("button", { name: "Reset finished date" })).toBeNull();
  fireEvent.click(field);
  expect(field).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("dialog", { name: "October 2026" })).toBeInTheDocument();
  expect(day(/October 3, 2026/)).toHaveAttribute("aria-pressed", "true");
  expect(day(/October 3, 2026/)).toHaveFocus();
  // Days after today cannot be chosen, nor the next month.
  expect(day(/October 16, 2026/)).toBeDisabled();
  expect(screen.getByRole("button", { name: "Next month" })).toBeDisabled();
  fireEvent.click(day(/October 1, 2026/));
  expect(field).toHaveAttribute("aria-expanded", "false");
  await waitFor(() => expect(changed).toHaveBeenCalledWith([]));
  expect(invoke).toHaveBeenCalledWith("set_book_finished_date", {
    bookId: A,
    finishedAt: +new Date(2026, 9, 1, 12),
  });
});

it("moves through the calendar from the keyboard and closes on Escape only", () => {
  const { field } = open({ at: +new Date(2026, 9, 1, 12), set: true });
  fireEvent.click(field);
  fireEvent.keyDown(day(/October 1, 2026/), { key: "ArrowLeft" });
  expect(screen.getByRole("dialog", { name: "September 2026" })).toBeInTheDocument();
  expect(day(/September 30, 2026/)).toHaveFocus();
  fireEvent.keyDown(day(/September 30, 2026/), { key: "PageUp" });
  expect(day(/August 30, 2026/)).toHaveFocus();
  fireEvent.keyDown(day(/August 30, 2026/), { key: "ArrowDown" });
  expect(day(/September 6, 2026/)).toHaveFocus();
  // Past today it stays on today.
  fireEvent.keyDown(day(/September 6, 2026/), { key: "PageDown" });
  fireEvent.keyDown(day(/October 6, 2026/), { key: "PageDown" });
  expect(day(/October 15, 2026/)).toHaveFocus();
  fireEvent.keyDown(day(/October 15, 2026/), { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: /2026/ })).toBeNull();
  expect(field).toHaveFocus();
  // The book's dialog stays open.
  expect(screen.getByRole("dialog", { name: "Book A" })).toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalled();
});

it("resets a chosen day, and says so when saving fails", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null);
  const changed = vi.fn();
  const first = open(null, changed);
  expect(first.field).toHaveAccessibleName("Finished Not set");
  fireEvent.click(first.field);
  // With no day yet, the calendar opens on today.
  expect(day(/October 15, 2026/)).toHaveFocus();
  fireEvent.click(day(/October 2, 2026/));
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

it("shows the open book's latest totals after its finished day changes", () => {
  const library = new Map([[A, book]]);
  const { view } = open({ at: +new Date(2026, 9, 3, 20), set: false });
  const lastRead = () => screen.getByText("Last read").nextElementSibling;
  expect(lastRead()).toHaveTextContent("Oct 14, 2026");
  // A book marked completed without sessions reads its Last read from its finished day.
  const moved = { ...activity, sessions: 0, lastReadAt: +new Date(2026, 9, 9, 12) };
  view.rerender(<BookTotals books={[moved]} library={library} />);
  expect(lastRead()).toHaveTextContent("Oct 9, 2026");
  // Moved out of the range, the book keeps the totals it showed.
  view.rerender(<BookTotals books={[]} library={library} />);
  expect(screen.getByRole("dialog", { name: "Book A" })).toBeInTheDocument();
  expect(lastRead()).toHaveTextContent("Oct 9, 2026");
});

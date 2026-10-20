import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider } from "../features/appearance/AppearanceProvider";
import type { AppearancePreferencesStore as AppearanceStore } from "../features/appearance/appearancePreferences";
import { listLibrary, type LibraryBook } from "../features/library/libraryApi";
import { libraryCache } from "../features/library/libraryCache";
import {
  listLibraryKanji,
  listReadingSessions,
  editDailyActivity,
  type StoredReadingSession,
  DailyActivityConflict,
} from "../features/statistics/statisticsApi";
import { StatisticsPage } from "./StatisticsPage";

vi.mock("../features/library/libraryApi", () => ({
  listLibrary: vi.fn(),
  onLibraryDetailsUpdated: vi.fn(() => () => {}),
}));
vi.mock("../features/statistics/statisticsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../features/statistics/statisticsApi")>()),
  listReadingSessions: vi.fn(),
  listLibraryKanji: vi.fn(),
  editDailyActivity: vi.fn(),
}));

const JA = "11111111-1111-4111-8111-111111111111";
const EN = "22222222-2222-4222-8222-222222222222";
const book = (id: string, extra: Partial<LibraryBook>): LibraryBook => ({
  id,
  title: null,
  author: null,
  fileName: `${id}.epub`,
  importedAt: "2026-01-01T00:00:00Z",
  availability: "available",
  hasCover: false,
  ...extra,
});
const books = [
  book(JA, {
    title: "秋の手紙",
    author: "山田 花子",
    language: "ja",
    characters: 200_000,
    progress: { unit: "characters", current: 50_000, total: 200_000 },
  }),
  book(EN, {
    title: "Harbor Notes",
    language: "en",
    progress: { unit: "words", current: 188_000, total: 188_000 },
  }),
];
let ids = 0;
const session = (
  bookId: string,
  start: Date,
  minutes: number,
  unitsRead: number,
  extra: Partial<StoredReadingSession> = {},
): StoredReadingSession => ({
  bookId,
  id: `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  startedAt: +start,
  endedAt: +start + minutes * 60_000,
  activeMs: minutes * 60_000,
  unit: "characters",
  unitsRead,
  startUnits: 1_000,
  endUnits: 1_000 + unitsRead,
  totalUnits: 200_000,
  bookTitle: null,
  finishCleared: false,
  ...extra,
});

function Location() {
  return <span data-testid="location">{useLocation().pathname + useLocation().search}</span>;
}

function renderPage(store: AppearanceStore | null = null) {
  return render(
    <AppearanceProvider store={store}>
      <MemoryRouter initialEntries={["/statistics"]}>
        <Routes>
          <Route path="*" element={<StatisticsPage />} />
        </Routes>
        <Location />
      </MemoryRouter>
    </AppearanceProvider>,
  );
}

beforeEach(() => {
  vi.mocked(editDailyActivity).mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 9, 15, 21, 0));
  libraryCache.reset();
  vi.mocked(listLibrary).mockResolvedValue(books);
  vi.mocked(listReadingSessions).mockResolvedValue([
    session(JA, new Date(2026, 8, 20, 9), 30, 6_000),
    session(JA, new Date(2026, 9, 14, 9), 60, 18_000),
    session(EN, new Date(2026, 9, 15, 8), 20, 6_000, {
      unit: "words",
      startUnits: 182_000,
      endUnits: 188_000,
      totalUnits: 188_000,
    }),
  ]);
  vi.mocked(listLibraryKanji).mockResolvedValue([
    {
      language: "ja",
      books: 1,
      kanji: Array.from("日本人心山田花子読書時間", (character, index) => ({
        character,
        books: index < 2 ? 2 : 1,
        completed: index === 0,
      })).concat(
        Array.from({ length: 60 }, (_, index) => ({
          character: String.fromCodePoint(0x4e00 + index),
          books: 1,
          completed: false,
        })),
      ),
    },
  ]);
});
afterEach(() => vi.useRealTimers());

describe("Statistics", () => {
  it("edits books beyond the three-row preview, including removed books while recording is off", async () => {
    const extra = "99999999-9999-4999-8999-999999999999";
    vi.mocked(listReadingSessions).mockResolvedValueOnce([
      session(JA, new Date(2026, 9, 15, 9), 60, 1000),
      session(EN, new Date(2026, 9, 15, 10), 30, 1000, { unit: "words" }),
      session(extra, new Date(2026, 9, 15, 11), 10, 1000, { bookTitle: "Removed first" }),
      session("88888888-8888-4888-8888-888888888888", new Date(2026, 9, 15, 12), 5, 1000, {
        bookTitle: "Removed fourth",
        unit: "words",
      }),
    ]);
    renderPage({
      load: vi.fn(async () => ({ statisticsEnabled: false })),
      save: vi.fn(async () => {}),
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const calendar = await screen.findByRole("region", { name: "Daily activity" });
    expect(
      within(calendar).queryByRole("button", { name: "Edit daily activity for Removed fourth" }),
    ).not.toBeInTheDocument();
    await user.click(within(calendar).getByRole("button", { name: "Show all 4 books" }));
    await user.click(
      within(calendar).getByRole("button", { name: "Edit daily activity for Removed fourth" }),
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("textbox", { name: "Words read" }),
    ).toHaveValue("1000");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(editDailyActivity).not.toHaveBeenCalled();
  });

  it("refreshes a stale day and reopens with the new totals without replacing the unsaved draft", async () => {
    const original = await listReadingSessions();
    renderPage();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const calendar = await screen.findByRole("region", { name: "Daily activity" });
    await user.click(
      within(calendar).getByRole("button", { name: "Edit daily activity for Harbor Notes" }),
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Words read" }), {
      target: { value: "500" },
    });
    vi.mocked(editDailyActivity).mockRejectedValueOnce(
      new DailyActivityConflict("This day's reading changed."),
    );
    vi.mocked(listReadingSessions).mockResolvedValue(
      original.map((s) =>
        s.bookId === EN
          ? { ...s, unitsRead: 6010, activeMs: s.activeMs + 60000, endedAt: s.endedAt + 60000 }
          : s,
      ),
    );
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("reading changed");
    expect(within(dialog).getByRole("textbox", { name: "Words read" })).toHaveValue("500");
    await waitFor(() =>
      expect(
        within(calendar).getByRole("complementary", { name: "Day details" }),
      ).toHaveTextContent("6,010 words"),
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(
      within(calendar).getByRole("button", { name: "Edit daily activity for Harbor Notes" }),
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("textbox", { name: "Words read" }),
    ).toHaveValue("6010");
  });

  it("right-clicks a stable book/day, validates, cancels and saves with refreshed totals", async () => {
    const view = renderPage();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const calendar = await screen.findByRole("region", { name: "Daily activity" });
    const edit = () =>
      within(calendar).getByRole("button", { name: "Edit daily activity for Harbor Notes" });
    fireEvent.contextMenu(edit().closest("li")!);
    let dialog = screen.getByRole("dialog", { name: "Edit daily activity" });
    expect(dialog).toHaveTextContent("October 15, 2026");
    expect(within(dialog).getByRole("textbox", { name: "Words read" })).toHaveValue("6000");
    await user.clear(within(dialog).getByRole("textbox", { name: "Words read" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Words read" }), "-1");
    expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("whole words");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(editDailyActivity).not.toHaveBeenCalled();
    expect(edit()).toHaveFocus();
    // Closing a native modal can uncover another cell without moving the pointer.
    fireEvent.mouseEnter(within(calendar).getByRole("button", { name: "October 14: 1h 00m read" }));
    expect(edit()).toBeInTheDocument();
    expect(edit()).toHaveFocus();
    await user.click(edit());
    dialog = screen.getByRole("dialog");
    const units = within(dialog).getByRole("textbox", { name: "Words read" });
    const minutes = within(dialog).getByRole("textbox", { name: "Time spent (minutes)" });
    for (const invalid of ["", "1.5", "1000000001", "NaN"]) {
      fireEvent.change(units, { target: { value: invalid } });
      expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeDisabled();
    }
    fireEvent.change(units, { target: { value: "3000" } });
    for (const invalid of ["", "-1", "1440.001", "Infinity"]) {
      fireEvent.change(minutes, { target: { value: invalid } });
      expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeDisabled();
    }
    fireEvent.change(minutes, { target: { value: "30.5" } });
    const original = await listReadingSessions();
    const saved = original.map((s) =>
      s.bookId === EN ? { ...s, adjustment: { unitsDelta: -3000, activeMsDelta: 630000 } } : s,
    );
    let resolveSave!: (sessions: StoredReadingSession[]) => void;
    vi.mocked(editDailyActivity).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(within(dialog).getByRole("status")).toHaveTextContent("Saving daily activity");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(editDailyActivity).toHaveBeenCalledWith({
      bookId: EN,
      dayStart: +new Date(2026, 9, 15),
      dayEnd: +new Date(2026, 9, 16),
      unit: "words",
      unitsRead: 3000,
      activeMs: 1830000,
      expectedUnits: 6000,
      expectedActiveMs: 1200000,
      expectedSessions: 1,
    });
    resolveSave(saved);
    expect(await screen.findByText("Daily activity saved.")).toBeInTheDocument();
    expect(within(calendar).getByRole("complementary", { name: "Day details" })).toHaveTextContent(
      "3,000 words",
    );
    const metrics = screen.getByRole("region", { name: "Reading activity" });
    expect(
      within(metrics).getByText("Reading time", { selector: "span" }).closest("article"),
    ).toHaveTextContent("1h 30m");
    expect(
      within(metrics).getByText("Words read", { selector: "span" }).closest("article"),
    ).toHaveTextContent("3,000");
    expect(
      within(metrics).getByText("Books finished", { selector: "span" }).closest("article"),
    ).toHaveTextContent("1");
    view.unmount();
    vi.mocked(listReadingSessions).mockResolvedValue(saved);
    renderPage();
    const reloaded = await screen.findByRole("region", { name: "Daily activity" });
    expect(within(reloaded).getByRole("complementary", { name: "Day details" })).toHaveTextContent(
      "3,000 words",
    );
  });

  it("makes the month one Tab stop that the arrow keys move through by day and week", async () => {
    renderPage();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const calendar = await screen.findByRole("region", { name: "Daily activity" });
    const days = () =>
      Array.from(calendar.querySelectorAll<HTMLElement>(".statistics-calendar__day"));
    const stops = () => days().filter((day) => day.tabIndex >= 0);
    expect(days()).toHaveLength(31);
    expect(stops()).toHaveLength(1);
    expect(stops()[0]).toHaveAccessibleName(/^October 15:/);

    stops()[0].focus();
    const focused = () => document.activeElement?.getAttribute("aria-label");
    await user.keyboard("{ArrowRight}");
    expect(focused()).toMatch(/^October 16:/);
    await user.keyboard("{ArrowUp}");
    expect(focused()).toMatch(/^October 9:/);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(focused()).toMatch(/^October 23:/);
    await user.keyboard("{End}{ArrowRight}");
    expect(focused()).toMatch(/^October 31:/);
    await user.keyboard("{Home}{ArrowLeft}");
    expect(focused()).toMatch(/^October 1:/);
    expect(stops()).toEqual([document.activeElement]);
    expect(within(calendar).getByRole("complementary", { name: "Day details" })).toHaveTextContent(
      "Oct 1, 2026",
    );
  });

  it("keeps failed edits in the floating editor without exposing native errors, and cancels with Escape", async () => {
    renderPage();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const calendar = await screen.findByRole("region", { name: "Daily activity" });
    await user.click(within(calendar).getByRole("button", { name: "October 14: 1h 00m read" }));
    await user.click(
      within(calendar).getByRole("button", { name: "Edit daily activity for 秋の手紙" }),
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Characters read" }), {
      target: { value: "0" },
    });
    vi.mocked(editDailyActivity).mockRejectedValueOnce(new Error("C:/private/library.sqlite3"));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "previous statistics are kept",
    );
    expect(document.body).not.toHaveTextContent("private");
    expect(within(dialog).getByRole("textbox", { name: "Characters read" })).toHaveValue("0");
    expect(within(calendar).getByRole("complementary", { name: "Day details" })).toHaveTextContent(
      "18,000 characters",
    );
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows each range's real reading and the Library's cards", async () => {
    renderPage();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const metrics = await screen.findByRole("region", { name: "Reading activity" });
    const metric = (label: string) =>
      within(metrics).getByText(label, { selector: "span" }).closest("article")!;
    expect(metric("Reading time")).toHaveTextContent("1h 20m");
    expect(metric("Reading time")).toHaveTextContent("+167% vs last month");
    expect(metric("Sessions")).toHaveTextContent("2");
    expect(metric("Characters read")).toHaveTextContent("18,000");
    expect(metric("Words read")).toHaveTextContent("6,000");
    expect(metric("Avg. Ch./h")).toHaveTextContent("18,000");
    expect(metric("Books finished")).toHaveTextContent("1");

    await user.click(screen.getByRole("button", { name: "Statistics range: This month" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Today/ }));
    expect(metric("Reading time")).toHaveTextContent("20m");
    expect(metric("Characters read")).toHaveTextContent("0");
    expect(metric("Avg. Wo./h")).toHaveTextContent("18,000");
    await user.click(screen.getByRole("button", { name: "Statistics range: Today" }));
    await user.click(screen.getByRole("menuitemradio", { name: /All time/ }));
    expect(metric("Reading time")).toHaveTextContent("1h 50m");
    expect(metric("Characters read")).toHaveTextContent("24,000");

    const overview = screen.getByRole("region", { name: "Library overview" });
    expect(within(overview).getByText("Books").closest("article")).toHaveTextContent("2");
    expect(within(overview).getByText("Completed").closest("article")).toHaveTextContent(
      "50% of library",
    );
    expect(within(overview).getByText("Current streak").closest("article")).toHaveTextContent(
      "2 days",
    );
    expect(screen.getByRole("img", { name: "200,000 CJK characters" })).toBeInTheDocument();
    expect(screen.getByText("English").closest(".language-row")).toHaveTextContent("1 book");
    expect(
      screen.getByRole("img", { name: "1 completed, 1 in progress, 0 not started" }),
    ).toBeInTheDocument();
    // The reading volume cards are gone.
    expect(screen.queryByRole("region", { name: /volume/i })).not.toBeInTheDocument();
  });

  it("shows a calendar day's reading and books, and other months", async () => {
    renderPage();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const calendar = await screen.findByRole("region", { name: "Daily activity" });
    expect(within(calendar).getByText("October 2026")).toBeInTheDocument();
    // Today is chosen first.
    const details = within(calendar).getByRole("complementary", { name: "Day details" });
    expect(details).toHaveTextContent("20m reading");
    expect(within(calendar).getByRole("complementary", { name: "Books read" })).toHaveTextContent(
      "Harbor Notes",
    );
    await user.hover(within(calendar).getByRole("button", { name: "October 14: 1h 00m read" }));
    expect(details).toHaveTextContent("1h 00m reading");
    expect(details).toHaveTextContent("18,000 characters");
    expect(within(calendar).getByRole("complementary", { name: "Books read" })).toHaveTextContent(
      "山田 花子18,000 Ch. · 1h 00m",
    );
    await user.click(within(calendar).getByRole("button", { name: "October 13: no reading" }));
    expect(details).toHaveTextContent("Rest day");
    expect(within(calendar).getByText("No book read")).toBeInTheDocument();
    expect(within(calendar).getByRole("button", { name: "Next month" })).toBeDisabled();
    await user.click(within(calendar).getByRole("button", { name: "Previous month" }));
    expect(within(calendar).getByText("September 2026")).toBeInTheDocument();
    expect(
      within(calendar).getByRole("button", { name: "September 20: 30m read" }),
    ).toBeInTheDocument();
    // No sessions before September.
    expect(within(calendar).getByRole("button", { name: "Previous month" })).toBeDisabled();
  });

  it("explores the Library's kanji with search, preview and Dictionary lookup", async () => {
    renderPage();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const explorer = (await screen.findByText("Character explorer")).closest("article")!;
    await within(explorer).findByRole("button", { name: /^日: in 2 books, seen in a completed/ });
    expect(within(explorer).getAllByRole("button", { name: /Look up/ })).toHaveLength(48);
    await user.click(within(explorer).getByRole("button", { name: "Show all 72 characters" }));
    expect(within(explorer).getAllByRole("button", { name: /Look up/ })).toHaveLength(72);
    await user.click(within(explorer).getByRole("button", { name: "Show preview" }));
    const characterSearch = within(explorer).getByRole("textbox", { name: "Search characters" });
    expect(characterSearch).toHaveAttribute("spellcheck", "false");
    await user.type(characterSearch, "読書x");
    expect(
      within(explorer)
        .getAllByRole("button", { name: /Look up/ })
        .map((tile) => tile.textContent),
    ).toEqual(["読1 book", "書1 book"]);
    await user.click(within(explorer).getByRole("button", { name: "Chinese" }));
    expect(explorer).toHaveTextContent("No Chinese books with counted kanji yet.");
    await user.click(within(explorer).getByRole("button", { name: "Japanese" }));
    await user.click(within(explorer).getByRole("button", { name: /^読:/ }));
    expect(screen.getByTestId("location")).toHaveTextContent(
      `/dictionary?q=${encodeURIComponent("読")}`,
    );
  });

  it("says when statistics are off and keeps removed and unread books honest", async () => {
    vi.mocked(listReadingSessions).mockResolvedValueOnce([
      session(JA, new Date(2026, 9, 14, 9), 60, 18_000),
      session(EN, new Date(2026, 9, 15, 8), 20, 6_000, {
        unit: "words",
        startUnits: 182_000,
        endUnits: 188_000,
        totalUnits: 188_000,
        finishCleared: true,
      }),
      session("99999999-9999-4999-8999-999999999999", new Date(2026, 9, 15, 9), 10, 3_000, {
        bookTitle: "A removed book",
      }),
    ]);
    const store = {
      load: vi.fn(async () => ({ statisticsEnabled: false })),
      save: vi.fn(async () => {}),
    };
    renderPage(store);
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("Reading statistics are off");
    expect(within(note).getByRole("link", { name: "Turn them on in Settings" })).toHaveAttribute(
      "href",
      "/settings?section=statistics",
    );
    const metrics = screen.getByRole("region", { name: "Reading activity" });
    // Harbor Notes was marked unread since its last session.
    expect(
      within(metrics).getByText("Books finished", { selector: "span" }).closest("article"),
    ).toHaveTextContent("0");
    const calendar = screen.getByRole("region", { name: "Daily activity" });
    expect(within(calendar).getByRole("complementary", { name: "Books read" })).toHaveTextContent(
      "A removed book",
    );
  });

  it("is honest when nothing was read and when loading fails", async () => {
    vi.mocked(listReadingSessions).mockResolvedValueOnce([]);
    const view = renderPage();
    expect(screen.getByRole("status")).toHaveTextContent("Loading statistics");
    expect(await screen.findByText(/No reading sessions yet/)).toBeInTheDocument();
    const metrics = screen.getByRole("region", { name: "Reading activity" });
    expect(
      within(metrics).getByText("Reading time", { selector: "span" }).closest("article"),
    ).toHaveTextContent("0m");
    expect(within(metrics).getByText("Avg. Ch./h").closest("article")).toHaveTextContent("—");
    view.unmount();

    vi.mocked(listReadingSessions).mockRejectedValueOnce(new Error("C:/private/library.sqlite3"));
    vi.mocked(listLibraryKanji).mockRejectedValueOnce(new Error("failed"));
    renderPage();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    expect(await screen.findByText("Statistics could not be loaded")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("private");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByText("The library's characters could not be loaded.")).toBeInTheDocument(),
    );
    expect(await screen.findByText("Reading activity")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: /^日: in 2 books/ })).toBeInTheDocument();
  });
});

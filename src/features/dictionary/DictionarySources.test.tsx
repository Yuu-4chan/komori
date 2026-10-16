import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  importDictionaries,
  listDictionaries,
  moveDictionary,
  removeDictionaries,
  removeDictionary,
  type DictionaryMoveStatus,
  type DictionaryRemovalResult,
  type DictionaryRemovalStatus,
  type DictionarySummary,
} from "./dictionaryApi";
import { DictionarySources } from "./DictionarySources";
import { guardDocument } from "../../app/nativeSurfaces";

vi.mock("./dictionaryApi", () => ({
  importDictionaries: vi.fn(),
  listDictionaries: vi.fn(),
  moveDictionary: vi.fn(),
  removeDictionaries: vi.fn(),
  removeDictionary: vi.fn(),
}));

const listMock = vi.mocked(listDictionaries);
const importMock = vi.mocked(importDictionaries);
const removeMock = vi.mocked(removeDictionary);
const bulkRemoveMock = vi.mocked(removeDictionaries);
const moveMock = vi.mocked(moveDictionary);

const jitendex: DictionarySummary = {
  id: 1,
  title: "Jitendex",
  revision: "2026-08-11",
  enabled: true,
  termCount: 435448,
  termMetaCount: 0,
  kanjiCount: 0,
  kanjiMetaCount: 0,
  hasFrequency: true,
  hasPitch: false,
  hasDefinitions: true,
};

const kanjidic: DictionarySummary = {
  id: 2,
  title: "KANJIDIC",
  revision: "2026-222",
  enabled: true,
  termCount: 0,
  termMetaCount: 0,
  kanjiCount: 10384,
  kanjiMetaCount: 1,
  hasFrequency: true,
  hasPitch: false,
  hasDefinitions: true,
};

const jpdb: DictionarySummary = {
  id: 3,
  title: "JPDB",
  revision: "2024-10-13",
  enabled: false,
  termCount: 0,
  termMetaCount: 520000,
  kanjiCount: 0,
  kanjiMetaCount: 0,
  hasFrequency: true,
  hasPitch: false,
  hasDefinitions: false,
};

function rows() {
  return within(screen.getByRole("list", { name: "Installed dictionaries" })).getAllByRole(
    "listitem",
  );
}

function listedTitles() {
  return rows().map((row) => row.querySelector("strong")?.textContent);
}

function row(title: string) {
  return rows().find((item) => item.querySelector("strong")?.textContent === title)!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Dictionary sources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue([]);
  });

  it("ignores an older list response that arrives after an import refresh", async () => {
    const oldList = deferred<DictionarySummary[]>();
    listMock.mockReturnValueOnce(oldList.promise).mockResolvedValue([jitendex, kanjidic]);
    importMock.mockResolvedValue({
      canceled: false,
      results: [{ fileName: "kanjidic.zip", status: "imported", title: "KANJIDIC" }],
    });
    render(<DictionarySources />);
    await userEvent.click(screen.getByRole("button", { name: "Add dictionaries" }));
    await screen.findByText("KANJIDIC");
    await act(async () => {
      oldList.resolve([jitendex]);
    });
    expect(listedTitles()).toEqual(["Jitendex", "KANJIDIC"]);
  });

  it("lists imported dictionaries in import order with their revision and row counts", async () => {
    listMock.mockResolvedValue([jitendex, kanjidic]);
    render(<DictionarySources />);

    const list = await screen.findByRole("list", { name: "Installed dictionaries" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Jitendex435,448 terms · Revision 2026-08-11");
    expect(rows[1]).toHaveTextContent(
      "KANJIDIC10,384 kanji · 1 kanji frequency · Revision 2026-222",
    );
  });

  it("does not reload a disposed page when a pending import finishes", async () => {
    const user = userEvent.setup();
    const pending = deferred<Awaited<ReturnType<typeof importDictionaries>>>();
    importMock.mockReturnValue(pending.promise);
    const view = render(<DictionarySources />);
    await screen.findByText(/No dictionaries yet/);
    await user.click(screen.getByRole("button", { name: "Add dictionaries" }));
    view.unmount();
    await act(async () =>
      pending.resolve({
        canceled: false,
        results: [{ fileName: "new.zip", status: "imported", title: "New" }],
      }),
    );
    expect(listMock).toHaveBeenCalledOnce();
    expect(screen.queryByRole("list", { name: "Installed dictionaries" })).not.toBeInTheDocument();
  });

  it("shows an empty list and a path-safe failure outside the desktop app", async () => {
    const view = render(<DictionarySources />);
    expect(await screen.findByText(/No dictionaries yet/)).toBeInTheDocument();
    view.unmount();

    listMock.mockRejectedValue(new Error("Open Komori in the desktop app to manage dictionaries."));
    render(<DictionarySources />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your dictionaries could not be loaded: Open Komori in the desktop app to manage dictionaries.",
    );
  });

  it("adds dictionaries, refreshes the list, and explains every archive that was not added", async () => {
    const user = userEvent.setup();
    const pending = deferred<Awaited<ReturnType<typeof importDictionaries>>>();
    importMock.mockReturnValue(pending.promise);
    render(<DictionarySources />);
    await screen.findByText(/No dictionaries yet/);

    await user.click(screen.getByRole("button", { name: /Add dictionaries/ }));
    const busy = screen.getByRole("button", { name: /Adding dictionaries/ });
    expect(busy).toBeDisabled();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    await user.click(busy);
    expect(importMock).toHaveBeenCalledTimes(1);

    listMock.mockResolvedValue([jitendex]);
    pending.resolve({
      canceled: false,
      results: [
        { fileName: "jitendex.zip", status: "imported", title: "Jitendex" },
        { fileName: "jitendex copy.zip", status: "alreadyImported", title: "Jitendex" },
        { fileName: "notes.zip", status: "invalid", title: null },
        { fileName: "locked.zip", status: "unreadable", title: null },
        { fileName: "large.zip", status: "failed", title: "Large" },
      ],
    });

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("1 added · 1 already installed · 3 not added");
    const reasons = within(notice)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(reasons).toEqual([
      "jitendex copy.zip: Jitendex is already installed at this revision.",
      "notes.zip: This is not a dictionary archive Komori can read. Nothing was added.",
      "locked.zip: Komori could not read this file. Nothing was added.",
      "large.zip: Komori could not save this dictionary. Nothing was added.",
    ]);
    expect(notice).not.toHaveClass("library-notice--error");
    expect(await screen.findByRole("list", { name: "Installed dictionaries" })).toHaveTextContent(
      "Jitendex",
    );
    expect(screen.getByRole("button", { name: /Add dictionaries/ })).toBeEnabled();
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("reports a batch with nothing added in the same plain notice, which closes", async () => {
    const user = userEvent.setup();
    importMock.mockResolvedValue({
      canceled: false,
      results: [{ fileName: "notes.zip", status: "invalid", title: null }],
    });
    render(<DictionarySources />);
    await screen.findByText(/No dictionaries yet/);

    await user.click(screen.getByRole("button", { name: /Add dictionaries/ }));
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("0 added · 1 not added");
    expect(notice).not.toHaveClass("library-notice--error");
    await user.click(within(notice).getByRole("button", { name: "Close" }));
    expect(screen.queryByText("0 added · 1 not added")).toBeNull();
  });

  it("leaves everything unchanged when the picker is canceled", async () => {
    const user = userEvent.setup();
    importMock.mockResolvedValue({ canceled: true, results: [] });
    render(<DictionarySources />);
    await screen.findByText(/No dictionaries yet/);

    await user.click(screen.getByRole("button", { name: /Add dictionaries/ }));
    expect(await screen.findByRole("button", { name: /Add dictionaries/ })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("reports a failed import command without a result list", async () => {
    const user = userEvent.setup();
    importMock.mockRejectedValue("Dictionary storage error: disk I/O error");
    render(<DictionarySources />);
    await screen.findByText(/No dictionaries yet/);

    await user.click(screen.getByRole("button", { name: /Add dictionaries/ }));
    expect(await screen.findByText(/Dictionaries could not be added:/)).toHaveTextContent(
      "Dictionaries could not be added: Dictionary storage error: disk I/O error",
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  describe("removing a dictionary", () => {
    async function openRemoval(title: string) {
      const user = userEvent.setup();
      listMock.mockResolvedValue([jitendex, kanjidic]);
      render(<DictionarySources />);
      await user.click(await screen.findByRole("button", { name: `Remove ${title}` }));
      return { user, dialog: screen.getByRole("alertdialog") };
    }

    it("removes a confirmed dictionary and keeps the rest in import order", async () => {
      const pending = deferred<DictionaryRemovalStatus>();
      removeMock.mockReturnValue(pending.promise);
      const { user, dialog } = await openRemoval("Jitendex");

      expect(dialog).toHaveAccessibleName("Remove this dictionary from Komori?");
      expect(dialog).toHaveAccessibleDescription(
        "Jitendex (revision 2026-08-11) will stop matching lookups. The original ZIP file will not be deleted, and you can add it again later.",
      );
      await user.click(within(dialog).getByRole("button", { name: "Remove dictionary" }));
      expect(removeMock).toHaveBeenCalledWith(1);
      // Nothing else can start while the removal runs.
      expect(within(dialog).getByRole("button", { name: "Removing…" })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
      expect(screen.getByRole("button", { name: /Add dictionaries/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Remove KANJIDIC" })).toBeDisabled();

      listMock.mockResolvedValue([kanjidic]);
      pending.resolve("removed");
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      await waitFor(() => expect(listedTitles()).toEqual(["KANJIDIC"]));
      expect(screen.getByRole("listitem")).toHaveTextContent(/^KANJIDIC/);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Add dictionaries/ })).toBeEnabled();
      expect(removeMock).toHaveBeenCalledTimes(1);
      expect(listMock).toHaveBeenCalledTimes(2);
    });

    it("changes nothing when the removal is canceled", async () => {
      const { user, dialog } = await openRemoval("KANJIDIC");
      expect(dialog).toHaveAccessibleDescription(/^KANJIDIC \(revision 2026-222\)/);

      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(removeMock).not.toHaveBeenCalled();
      expect(listMock).toHaveBeenCalledTimes(1);
      expect(listedTitles()).toEqual(["Jitendex", "KANJIDIC"]);
    });

    it("keeps the dictionary and explains a failed removal", async () => {
      removeMock.mockResolvedValueOnce("failed");
      const { user, dialog } = await openRemoval("Jitendex");

      await user.click(within(dialog).getByRole("button", { name: "Remove dictionary" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "Komori could not remove this dictionary. Nothing was removed.",
      );
      expect(listedTitles()).toEqual(["Jitendex", "KANJIDIC"]);
      expect(listMock).toHaveBeenCalledTimes(1);

      // A rejected command reports its message, and the dialog can still be closed.
      removeMock.mockRejectedValueOnce(
        new Error("Open Komori in the desktop app to manage dictionaries."),
      );
      await user.click(within(dialog).getByRole("button", { name: "Remove dictionary" }));
      await waitFor(() =>
        expect(within(dialog).getByRole("alert")).toHaveTextContent(
          "Open Komori in the desktop app to manage dictionaries.",
        ),
      );
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(listedTitles()).toEqual(["Jitendex", "KANJIDIC"]);
    });

    it("refreshes the list when the dictionary was already removed", async () => {
      removeMock.mockResolvedValue("notFound");
      const { user, dialog } = await openRemoval("Jitendex");

      listMock.mockResolvedValue([kanjidic]);
      await user.click(within(dialog).getByRole("button", { name: "Remove dictionary" }));
      expect(await screen.findByRole("status")).toHaveTextContent("Jitendex was already removed.");
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      await waitFor(() => expect(listedTitles()).toEqual(["KANJIDIC"]));
    });
  });

  describe("reordering dictionaries", () => {
    function handle(title: string) {
      return row(title).querySelector<HTMLElement>(".settings-source-row__handle")!;
    }

    function title(name: string) {
      return row(name).querySelector("strong")!;
    }

    /** Rows are 50 px tall, stacked from the top of the page. */
    function stackRows() {
      for (const [index, item] of rows().entries()) {
        vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
          new DOMRect(0, index * 50, 400, 50),
        );
      }
    }

    it("moves the focused row with Alt+Arrow keys, announcing it and keeping focus", async () => {
      const user = userEvent.setup();
      const pending = deferred<DictionaryMoveStatus>();
      moveMock.mockReturnValue(pending.promise);
      listMock.mockResolvedValue([jitendex, kanjidic, jpdb]);
      render(<DictionarySources />);
      await screen.findByRole("list", { name: "Installed dictionaries" });
      expect(screen.queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
      expect(row("Jitendex")).toHaveAccessibleDescription(
        "Drag the ≡ handle to change the lookup order, or focus a row and press Alt+↑ or Alt+↓.",
      );

      row("Jitendex").focus();
      // The first row cannot move up, and arrows without Alt do nothing.
      await user.keyboard("{Alt>}{ArrowUp}{/Alt}{ArrowDown}");
      expect(moveMock).not.toHaveBeenCalled();

      await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
      expect(moveMock).toHaveBeenCalledWith(1, 1);
      // The new order shows while it is saved, focus stays on the row, and nothing else starts.
      expect(listedTitles()).toEqual(["KANJIDIC", "Jitendex", "JPDB"]);
      expect(rows()[1]).toHaveTextContent(/^Jitendex/);
      expect(row("Jitendex")).toHaveFocus();
      await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
      expect(moveMock).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Remove KANJIDIC" })).toBeDisabled();
      expect(screen.getByRole("button", { name: /Add dictionaries/ })).toBeDisabled();
      expect(screen.getByRole("checkbox", { name: "Select KANJIDIC" })).toBeDisabled();
      // A browser blurs a row whose node React moves; jsdom does not, so blur it here.
      act(() => row("Jitendex").blur());

      listMock.mockResolvedValue([kanjidic, jitendex, jpdb]);
      pending.resolve("moved");
      expect(await screen.findByText("Jitendex moved to position 2 of 3.")).toHaveAttribute(
        "aria-live",
        "polite",
      );
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Add dictionaries/ })).toBeEnabled(),
      );
      expect(row("Jitendex")).toHaveFocus();
      expect(listedTitles()).toEqual(["KANJIDIC", "Jitendex", "JPDB"]);
      expect(
        rows().map((item) => item.querySelector(".settings-source-row__handle")?.textContent),
      ).toEqual(["", "", ""]);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      // Moving it down to the end keeps focus on it; the last row cannot move further down.
      moveMock.mockResolvedValue("moved");
      listMock.mockResolvedValue([kanjidic, jpdb, jitendex]);
      await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
      expect(moveMock).toHaveBeenLastCalledWith(1, 2);
      await waitFor(() => expect(listedTitles()).toEqual(["KANJIDIC", "JPDB", "Jitendex"]));
      expect(await screen.findByText("Jitendex moved to position 3 of 3.")).toBeInTheDocument();
      await waitFor(() => expect(row("Jitendex")).toHaveFocus());
      await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
      expect(moveMock).toHaveBeenCalledTimes(2);

      listMock.mockResolvedValue([kanjidic, jitendex, jpdb]);
      await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
      expect(moveMock).toHaveBeenLastCalledWith(1, 1);
      await waitFor(() => expect(listedTitles()).toEqual(["KANJIDIC", "Jitendex", "JPDB"]));
      await waitFor(() => expect(row("Jitendex")).toHaveFocus());
      expect(listMock).toHaveBeenCalledTimes(4);
    });

    it("moves dictionaries in both directions by their handle only", async () => {
      moveMock.mockResolvedValue("moved");
      listMock.mockResolvedValue([jitendex, kanjidic, jpdb]);
      render(<DictionarySources />);
      await screen.findByRole("list", { name: "Installed dictionaries" });
      stackRows();

      // A drag from the row's text.
      fireEvent.pointerDown(handle("JPDB"), { button: 0, pointerId: 1, clientY: 125 });
      expect(rows()[2]).toHaveClass("settings-source-row--dragged");
      fireEvent.pointerMove(title("JPDB"), { pointerId: 1, clientY: 60 });
      expect(listedTitles()).toEqual(["Jitendex", "JPDB", "KANJIDIC"]);
      fireEvent.pointerMove(title("JPDB"), { pointerId: 1, clientY: 10 });
      expect(listedTitles()).toEqual(["JPDB", "Jitendex", "KANJIDIC"]);
      expect(rows()[0]).toHaveTextContent(/^JPDB/);

      listMock.mockResolvedValue([jpdb, jitendex, kanjidic]);
      fireEvent.pointerUp(title("JPDB"), { pointerId: 1, clientY: 10 });
      expect(moveMock).toHaveBeenCalledWith(3, 0);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Add dictionaries/ })).toBeEnabled(),
      );
      expect(listedTitles()).toEqual(["JPDB", "Jitendex", "KANJIDIC"]);
      expect(document.querySelector(".settings-source-row--dragged")).toBeNull();
      expect(screen.getByText("JPDB moved to position 1 of 3.")).toBeInTheDocument();

      // A downward drag from the handle also works.
      stackRows();
      listMock.mockResolvedValue([jpdb, kanjidic, jitendex]);
      fireEvent.pointerDown(handle("Jitendex"), { button: 0, pointerId: 2, clientY: 75 });
      fireEvent.pointerMove(row("Jitendex"), { pointerId: 2, clientY: 140 });
      fireEvent.pointerUp(row("Jitendex"), { pointerId: 2, clientY: 140 });
      expect(moveMock).toHaveBeenLastCalledWith(1, 2);
      await waitFor(() => expect(listedTitles()).toEqual(["JPDB", "KANJIDIC", "Jitendex"]));

      // A drag that is canceled, or dropped where it started, moves nothing.
      stackRows();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Add dictionaries/ })).toBeEnabled(),
      );
      fireEvent.pointerDown(handle("Jitendex"), { button: 0, pointerId: 3, clientY: 125 });
      fireEvent.pointerMove(title("Jitendex"), { pointerId: 3, clientY: 10 });
      fireEvent.pointerCancel(title("Jitendex"), { pointerId: 3 });
      fireEvent.pointerDown(handle("Jitendex"), { button: 0, pointerId: 4, clientY: 125 });
      fireEvent.pointerUp(title("Jitendex"), { pointerId: 4, clientY: 125 });
      // Nor does a secondary button.
      fireEvent.pointerDown(handle("Jitendex"), { button: 2, pointerId: 5, clientY: 125 });
      expect(document.querySelector(".settings-source-row--dragged")).toBeNull();
      expect(listedTitles()).toEqual(["JPDB", "KANJIDIC", "Jitendex"]);
      expect(moveMock).toHaveBeenCalledTimes(2);
    });

    it("keeps capture on the list through downward row movement and cancels a lost list capture", async () => {
      moveMock.mockResolvedValue("moved");
      listMock.mockResolvedValue([jitendex, kanjidic, jpdb]);
      render(<DictionarySources />);
      const list = await screen.findByRole("list", { name: "Installed dictionaries" });
      const capture = vi.fn();
      list.setPointerCapture = capture;
      stackRows();
      fireEvent.pointerDown(handle("Jitendex"), { button: 0, pointerId: 7, clientY: 25 });
      expect(capture).toHaveBeenCalledWith(7);
      fireEvent.pointerMove(list, { pointerId: 7, clientY: 100 });
      expect(listedTitles()).toEqual(["KANJIDIC", "Jitendex", "JPDB"]);
      // A row being moved must not cancel the list's pointer capture.
      fireEvent.lostPointerCapture(row("Jitendex"), { pointerId: 7 });
      stackRows();
      fireEvent.pointerMove(list, { pointerId: 7, clientY: 160 });
      expect(listedTitles()).toEqual(["KANJIDIC", "JPDB", "Jitendex"]);
      listMock.mockResolvedValue([kanjidic, jpdb, jitendex]);
      fireEvent.pointerUp(list, { pointerId: 7, clientY: 160 });
      expect(moveMock).toHaveBeenCalledWith(1, 2);
      await screen.findByText("Jitendex moved to position 3 of 3.");
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Add dictionaries/ })).toBeEnabled(),
      );
      stackRows();
      fireEvent.pointerDown(handle("Jitendex"), { button: 0, pointerId: 8, clientY: 125 });
      fireEvent.pointerMove(list, { pointerId: 8, clientY: 10 });
      fireEvent.lostPointerCapture(list, { pointerId: 8 });
      fireEvent.pointerUp(list, { pointerId: 8, clientY: 10 });
      expect(moveMock).toHaveBeenCalledTimes(1);
      expect(listedTitles()).toEqual(["KANJIDIC", "JPDB", "Jitendex"]);
    });

    it("ignores drags that start on a row's controls", async () => {
      listMock.mockResolvedValue([jitendex, kanjidic]);
      render(<DictionarySources />);
      await screen.findByRole("list", { name: "Installed dictionaries" });
      stackRows();

      for (const control of [
        title("KANJIDIC"),
        row("KANJIDIC"),
        screen.getByRole("button", { name: "Remove KANJIDIC" }),
      ]) {
        fireEvent.pointerDown(control, { button: 0, pointerId: 1, clientY: 75 });
        expect(document.querySelector(".settings-source-row--dragged")).toBeNull();
        fireEvent.pointerMove(control, { pointerId: 1, clientY: 10 });
        fireEvent.pointerUp(control, { pointerId: 1, clientY: 10 });
      }
      expect(listedTitles()).toEqual(["Jitendex", "KANJIDIC"]);
      expect(moveMock).not.toHaveBeenCalled();
    });

    it("keeps the order and explains a failed move", async () => {
      const user = userEvent.setup();
      moveMock.mockResolvedValueOnce("failed");
      listMock.mockResolvedValue([jitendex, kanjidic]);
      render(<DictionarySources />);
      await screen.findByRole("list", { name: "Installed dictionaries" });

      row("KANJIDIC").focus();
      await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
      expect(moveMock).toHaveBeenCalledWith(2, 0);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Komori could not move KANJIDIC. The order is unchanged.",
      );
      expect(listedTitles()).toEqual(["Jitendex", "KANJIDIC"]);
      expect(row("KANJIDIC")).toHaveFocus();
      expect(row("KANJIDIC")).toHaveClass("settings-source-row--movable");
      expect(listMock).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/moved to position/)).not.toBeInTheDocument();

      moveMock.mockRejectedValueOnce(
        new Error("Open Komori in the desktop app to manage dictionaries."),
      );
      row("Jitendex").focus();
      await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Komori could not move Jitendex. The order is unchanged. Open Komori in the desktop app to manage dictionaries.",
        ),
      );
      expect(listedTitles()).toEqual(["Jitendex", "KANJIDIC"]);
      expect(listMock).toHaveBeenCalledTimes(1);
    });

    it("refreshes the list when the dictionary was already removed", async () => {
      const user = userEvent.setup();
      moveMock.mockResolvedValue("notFound");
      listMock.mockResolvedValue([jitendex, kanjidic]);
      render(<DictionarySources />);
      await screen.findByRole("list", { name: "Installed dictionaries" });

      listMock.mockResolvedValue([kanjidic]);
      row("Jitendex").focus();
      await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
      expect(await screen.findByRole("status")).toHaveTextContent("Jitendex was already removed.");
      await waitFor(() => expect(listedTitles()).toEqual(["KANJIDIC"]));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText(/moved to position/)).not.toBeInTheDocument();
    });

    it("cannot start a drag or move while an import runs", async () => {
      const user = userEvent.setup();
      const pending = deferred<Awaited<ReturnType<typeof importDictionaries>>>();
      importMock.mockReturnValue(pending.promise);
      listMock.mockResolvedValue([jitendex, kanjidic]);
      render(<DictionarySources />);
      await screen.findByRole("list", { name: "Installed dictionaries" });
      await user.click(screen.getByRole("button", { name: "Add dictionaries" }));
      expect(row("KANJIDIC")).not.toHaveClass("settings-source-row--movable");
      expect(handle("KANJIDIC")).toHaveAttribute("data-disabled");
      fireEvent.pointerDown(handle("KANJIDIC"), { button: 0, pointerId: 1, clientY: 75 });
      expect(document.querySelector(".settings-source-row--dragged")).toBeNull();
      row("KANJIDIC").focus();
      await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
      pending.resolve({ canceled: true, results: [] });
      await waitFor(() => expect(row("KANJIDIC")).toHaveClass("settings-source-row--movable"));
      expect(moveMock).not.toHaveBeenCalled();
    });
  });

  describe("removing several dictionaries", () => {
    const toolbar = () => screen.getByRole("toolbar", { name: "Dictionary selection" });
    const checkbox = (name: string) => screen.getByRole("checkbox", { name: `Select ${name}` });

    async function openSelection() {
      const user = userEvent.setup();
      listMock.mockResolvedValue([jitendex, kanjidic, jpdb]);
      render(<DictionarySources />);
      await screen.findByRole("checkbox", { name: "Select Jitendex" });
      return user;
    }

    it("Ctrl+A selects every installed ID only in this active selection context", async () => {
      const unguard = guardDocument(document);
      try {
        const user = await openSelection();
        await user.click(checkbox("Jitendex"));
        // Other Settings controls, text editing and nested contexts never select dictionaries.
        const other = document.createElement("button");
        document.body.append(other);
        fireEvent.keyDown(other, { key: "a", ctrlKey: true });
        const nested = document.createElement("div");
        nested.innerHTML =
          '<input /><textarea></textarea><div contenteditable="true"><b>Edit</b></div><div role="menu"><button>Nested</button></div>';
        row("Jitendex").append(nested);
        for (const field of nested.querySelectorAll("input, textarea, b")) {
          expect(fireEvent.keyDown(field, { key: "a", ctrlKey: true })).toBe(true);
          fireEvent.keyDown(field, { key: "Escape" });
        }
        fireEvent.keyDown(nested.querySelector("button")!, { key: "a", ctrlKey: true });
        for (const init of [
          { shiftKey: true },
          { altKey: true },
          { repeat: true },
          { isComposing: true },
          { metaKey: true },
        ])
          fireEvent.keyDown(checkbox("Jitendex"), { key: "a", ctrlKey: true, ...init });
        await user.click(within(toolbar()).getByRole("button", { name: "Remove selected" }));
        fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
        expect(toolbar()).toHaveTextContent("1 dictionary selected");
        await user.click(
          within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
        );
        fireEvent.keyDown(checkbox("Jitendex"), { key: "a", ctrlKey: true });
        expect(toolbar()).toHaveTextContent("3 dictionaries selected");
        expect(checkbox("JPDB")).toBeChecked(); // Disabled lookup sources remain removable.
        await user.click(checkbox("KANJIDIC"));
        fireEvent.keyDown(checkbox("Jitendex"), { key: "a", metaKey: true });
        expect(toolbar()).toHaveTextContent("3 dictionaries selected");
        await user.click(within(toolbar()).getByRole("button", { name: "Clear" }));
        expect(fireEvent.keyDown(document.body, { key: "a", ctrlKey: true })).toBe(false);
        expect(
          screen.queryByRole("toolbar", { name: "Dictionary selection" }),
        ).not.toBeInTheDocument();
        expect(bulkRemoveMock).not.toHaveBeenCalled();
        other.remove();
        nested.remove();
      } finally {
        unguard();
      }
    });

    it("removes the selected dictionaries after one confirmation", async () => {
      const pending = deferred<DictionaryRemovalResult[]>();
      bulkRemoveMock.mockReturnValue(pending.promise);
      const user = await openSelection();
      // Every row has its own box; the selection's actions appear once one is chosen.
      expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
      // A click on a row's text neither selects it nor stops it moving.
      await user.click(row("Jitendex").querySelector("strong")!);
      expect(checkbox("Jitendex")).not.toBeChecked();

      await user.click(checkbox("Jitendex"));
      await user.click(checkbox("JPDB"));
      // Chosen rows still move and keep their own removal.
      expect(row("Jitendex")).toHaveClass("settings-source-row--movable");
      expect(row("Jitendex")).toHaveAttribute("tabindex", "0");
      expect(screen.getByRole("button", { name: "Remove Jitendex" })).toBeInTheDocument();
      const removeSelected = within(toolbar()).getByRole("button", { name: "Remove selected" });
      await waitFor(() => expect(checkbox("KANJIDIC")).toBeEnabled());
      expect(checkbox("Jitendex")).toBeChecked();
      expect(checkbox("KANJIDIC")).not.toBeChecked();
      expect(row("JPDB")).toHaveClass("settings-source-row--selected");
      expect(toolbar()).toHaveTextContent("2 dictionaries selected");

      await user.click(removeSelected);
      const dialog = screen.getByRole("alertdialog");
      expect(dialog).toHaveAccessibleName("Remove 2 dictionaries from Komori?");
      expect(dialog).toHaveAccessibleDescription(
        "These 2 dictionaries will stop matching lookups. Their original ZIP files will not be deleted, and you can add them again later.",
      );
      expect(
        within(within(dialog).getByRole("list", { name: "Dictionaries to remove" }))
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual(["Jitendex (revision 2026-08-11)", "JPDB (revision 2024-10-13)"]);

      await user.click(within(dialog).getByRole("button", { name: "Remove 2 dictionaries" }));
      expect(bulkRemoveMock).toHaveBeenCalledWith([1, 3]);
      expect(within(dialog).getByRole("button", { name: "Removing…" })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
      expect(screen.getByRole("button", { name: /Add dictionaries/ })).toBeDisabled();

      listMock.mockResolvedValue([kanjidic]);
      pending.resolve([
        { id: 1, status: "removed" },
        { id: 3, status: "removed" },
      ]);
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      await waitFor(() => expect(listedTitles()).toEqual(["KANJIDIC"]));
      // Selection ends once everything was removed.
      expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
      expect(checkbox("KANJIDIC")).toBeEnabled();
      expect(checkbox("KANJIDIC")).not.toBeChecked();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(removeMock).not.toHaveBeenCalled();
    });

    it("selects all, clears, and leaves with Escape without removing anything", async () => {
      const user = await openSelection();
      await user.click(checkbox("JPDB"));
      await user.click(within(toolbar()).getByRole("button", { name: "Select all" }));
      expect(toolbar()).toHaveTextContent("3 dictionaries selected");
      for (const name of ["Jitendex", "KANJIDIC", "JPDB"]) expect(checkbox(name)).toBeChecked();

      // Canceling the dialog keeps the selection.
      await user.click(within(toolbar()).getByRole("button", { name: "Remove selected" }));
      const dialog = screen.getByRole("alertdialog");
      expect(dialog).toHaveAccessibleName("Remove 3 dictionaries from Komori?");
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(toolbar()).toHaveTextContent("3 dictionaries selected");

      await user.click(within(toolbar()).getByRole("button", { name: "Clear" }));
      expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
      for (const name of ["Jitendex", "KANJIDIC", "JPDB"]) expect(checkbox(name)).not.toBeChecked();
      expect(row("Jitendex")).toHaveClass("settings-source-row--movable");

      // Escape clears a new selection too.
      await user.click(checkbox("KANJIDIC"));
      expect(toolbar()).toHaveTextContent("1 dictionary selected");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
      expect(bulkRemoveMock).not.toHaveBeenCalled();
      expect(listMock).toHaveBeenCalledTimes(1);
    });

    it("names one selected dictionary in the confirmation", async () => {
      bulkRemoveMock.mockResolvedValue([{ id: 2, status: "removed" }]);
      const user = await openSelection();
      await user.click(checkbox("KANJIDIC"));
      await user.click(within(toolbar()).getByRole("button", { name: "Remove selected" }));
      const dialog = screen.getByRole("alertdialog");
      expect(dialog).toHaveAccessibleName("Remove 1 dictionary from Komori?");
      expect(dialog).toHaveAccessibleDescription(
        "This dictionary will stop matching lookups. Its original ZIP file will not be deleted, and you can add it again later.",
      );
      expect(dialog).toHaveTextContent("KANJIDIC (revision 2026-222)");
      listMock.mockResolvedValue([jitendex, jpdb]);
      await user.click(within(dialog).getByRole("button", { name: "Remove dictionary" }));
      expect(bulkRemoveMock).toHaveBeenCalledWith([2]);
      await waitFor(() => expect(listedTitles()).toEqual(["Jitendex", "JPDB"]));
    });

    it("reports every dictionary not removed and keeps the failed ones selected", async () => {
      bulkRemoveMock.mockResolvedValue([
        { id: 1, status: "removed" },
        { id: 2, status: "failed" },
        { id: 3, status: "notFound" },
      ]);
      const user = await openSelection();
      await user.click(checkbox("Jitendex"));
      await user.click(within(toolbar()).getByRole("button", { name: "Select all" }));
      await user.click(within(toolbar()).getByRole("button", { name: "Remove selected" }));
      listMock.mockResolvedValue([kanjidic]);
      await user.click(
        within(screen.getByRole("alertdialog")).getByRole("button", {
          name: "Remove 3 dictionaries",
        }),
      );

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Komori could not remove KANJIDIC. It is still installed.",
      );
      expect(screen.getByText("JPDB was already removed.")).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      await waitFor(() => expect(listedTitles()).toEqual(["KANJIDIC"]));
      expect(toolbar()).toHaveTextContent("1 dictionary selected");
      expect(checkbox("KANJIDIC")).toBeChecked();
      expect(listMock).toHaveBeenCalledTimes(2);
    });

    it("keeps the dialog open and the list unchanged when the command is rejected", async () => {
      bulkRemoveMock.mockRejectedValue(
        new Error("Open Komori in the desktop app to manage dictionaries."),
      );
      const user = await openSelection();
      await user.click(checkbox("Jitendex"));
      await user.click(checkbox("KANJIDIC"));
      await user.click(within(toolbar()).getByRole("button", { name: "Remove selected" }));
      const dialog = screen.getByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "Remove 2 dictionaries" }));

      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "Open Komori in the desktop app to manage dictionaries.",
      );
      expect(listedTitles()).toEqual(["Jitendex", "KANJIDIC", "JPDB"]);
      expect(listMock).toHaveBeenCalledTimes(1);
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(toolbar()).toHaveTextContent("2 dictionaries selected");
    });
  });

  it("lists the installed dictionaries in one grouped box under their header and Add button", async () => {
    listMock.mockResolvedValue([jitendex, kanjidic]);
    render(<DictionarySources />);
    await waitFor(() => expect(listedTitles()).toEqual(["Jitendex", "KANJIDIC"]));
    const box = screen
      .getByRole("list", { name: "Installed dictionaries" })
      .closest(".settings-list")!;
    expect(box).not.toBeNull();
    const add = screen.getByRole("button", { name: "Add dictionaries" });
    expect(box).toContainElement(add);
    expect(add).toHaveClass("button--secondary");
  });
});

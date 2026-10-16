import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppearanceProvider } from "../appearance/AppearanceProvider";
import { ReaderShell } from "./ReaderShell";
import type { NoteStore, ReaderNote } from "./notes";
import type { ReaderRenderer } from "./renderer";
const place = {
  passage: "Selected 本文",
  locator: { spineIndex: 1, sectionKey: "abcd1234", contentKey: "a".repeat(64), progress: 0.25 },
};
const note: ReaderNote = {
  ...place,
  id: "11111111-1111-4111-8111-111111111111",
  body: "A thought",
};
function store(items: ReaderNote[] = []): NoteStore {
  return {
    load: vi.fn(async () => items),
    create: vi.fn(async (passage, body) => ({ ...note, ...passage, body })),
    edit: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}
function adapter(): ReaderRenderer {
  return {
    mount: vi.fn(async (_host, _signal, changed) => {
      changed({ canAdvance: true, canRetreat: true });
      return "ready" as const;
    }),
    advancePage: vi.fn(async () => {}),
    retreatPage: vi.fn(async () => {}),
    dispose: vi.fn(),
    captureNote: vi.fn(async () => place),
    setNoteHighlights: vi.fn(),
    goToBookmark: vi.fn(async () => true),
  };
}
function shell(renderer: ReaderRenderer | undefined, notes: NoteStore) {
  return (
    <MemoryRouter>
      <AppearanceProvider store={null}>
        <ReaderShell rendererFactory={renderer ? () => renderer : undefined} noteStore={notes} />
      </AppearanceProvider>
    </MemoryRouter>
  );
}
describe("Reader notes through real actions", () => {
  it("captures N, cancels, creates, jumps, edits and removes without remounting", async () => {
    const reader = adapter();
    const notes = store();
    let select: Parameters<ReaderRenderer["mount"]>[8];
    vi.mocked(reader.mount).mockImplementation(async (...args) => {
      select = args[8];
      args[2]({ canAdvance: true, canRetreat: true });
      return "ready";
    });
    const user = userEvent.setup();
    render(shell(reader, notes));
    await screen.findByText("Reader ready");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Notes (0)" })).toBeInTheDocument(),
    );
    fireEvent.keyDown(screen.getByRole("main"), { key: "n" });
    const draft = await screen.findByRole("dialog", { name: "New note" });
    expect(within(draft).getByText(place.passage)).toBeInTheDocument();
    act(() =>
      select?.({
        text: "本文",
        rect: { left: 20, top: 20, right: 60, bottom: 40 },
        writingMode: "horizontal",
        origin: "keyboard",
      }),
    );
    expect(screen.queryByRole("dialog", { name: /^Lookup:/ })).not.toBeInTheDocument();
    await user.click(within(draft).getByText("Cancel"));
    expect(notes.create).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("main"), { key: "n" });
    await user.type(await screen.findByRole("textbox", { name: "Note" }), "My thought");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    expect(notes.create).toHaveBeenCalledWith(place, "My thought");
    await waitFor(() =>
      expect(reader.setNoteHighlights).toHaveBeenLastCalledWith([
        expect.objectContaining({ body: "My thought" }),
      ]),
    );
    const jump = await screen.findByRole("button", { name: "Jump to note 1" });
    await user.click(jump);
    await waitFor(() => expect(reader.goToBookmark).toHaveBeenCalledWith(place.locator));
    expect(screen.getByRole("main")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Edit note 1" }));
    const field = screen.getByRole("textbox", { name: "Note" });
    // A note is prose and keeps its spelling check.
    expect(field).not.toHaveAttribute("spellcheck", "false");
    await user.clear(field);
    await user.type(field, "Edited");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    expect(notes.edit).toHaveBeenCalledWith(note.id, "Edited");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove note 1" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Jump to note 1" })).not.toBeInTheDocument(),
    );
    expect(notes.remove).toHaveBeenCalledWith(note.id);
    await waitFor(() => expect(reader.setNoteHighlights).toHaveBeenLastCalledWith([]));
    expect(reader.mount).toHaveBeenCalledOnce();
  });
  it("offers Copy, Add note and Highlight for selected book text, and image actions on an image", async () => {
    const reader = adapter();
    const notes = store();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const book = frame.contentDocument!;
    book.body.innerHTML = '<p id="text">Selected 本文</p><img id="art" alt="">';
    const png = new Blob(["png"], { type: "image/png" });
    reader.imageAt = vi.fn(async () => ({
      items: [{ id: "art", alt: "", label: "Image 1", section: 0 }],
      index: 0,
    }));
    reader.loadImage = vi.fn(async () => ({ url: "blob:art", width: 4, height: 3, blob: png }));
    reader.releaseImage = vi.fn();
    vi.mocked(reader.mount).mockImplementation(async (...args) => {
      args[2]({ canAdvance: true, canRetreat: true });
      args[3]?.(book);
      return "ready";
    });
    const user = userEvent.setup();
    render(shell(reader, notes));
    await screen.findByText("Reader ready");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Notes (0)" })).toBeInTheDocument(),
    );
    const rightClick = (target: Element) =>
      target.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
      );
    // Without a selection, text keeps no menu of its own.
    rightClick(book.getElementById("text")!);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    book.getSelection()!.selectAllChildren(book.getElementById("text")!);
    act(() => void rightClick(book.getElementById("text")!));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Copy", "Add note", "Highlight"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Highlight" }));
    // A highlight is the passage saved without a note, marked in the book at once.
    await waitFor(() => expect(notes.create).toHaveBeenCalledWith(place, ""));
    expect(await screen.findByText("Highlight saved.")).toBeInTheDocument();
    await waitFor(() =>
      expect(reader.setNoteHighlights).toHaveBeenLastCalledWith([
        expect.objectContaining({ body: "" }),
      ]),
    );
    book.getSelection()!.removeAllRanges();
    act(() => void rightClick(book.getElementById("art")!));
    const imageMenu = await screen.findByRole("menu", { name: "Image" });
    expect(
      within(imageMenu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Copy image", "Save image"]);
    // The image is copied from the renderer's own bytes: the page may not fetch its blob URLs.
    const write = vi.fn(async () => {});
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly items: Record<string, Blob>) {}
      },
    );
    const fetching = vi.spyOn(globalThis, "fetch");
    await user.click(within(imageMenu).getByRole("menuitem", { name: "Copy image" }));
    expect(await screen.findByText("Image copied.")).toBeInTheDocument();
    expect(write).toHaveBeenCalledWith([{ items: { "image/png": png } }]);
    expect(fetching).not.toHaveBeenCalled();
    expect(reader.releaseImage).toHaveBeenCalledWith("blob:art");
    fetching.mockRestore();
    vi.unstubAllGlobals();
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    frame.remove();
  });
  it("opens a clicked saved passage in Notes or deletes it", async () => {
    const reader = adapter();
    const notes = store([note]);
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const book = frame.contentDocument!;
    book.body.innerHTML = '<p id="text">Selected 本文</p>';
    // The adapter's mark for the note, behind its text.
    const layer = book.createElement("div");
    layer.setAttribute("data-komori-note-marks", "");
    const mark = book.createElement("span");
    mark.setAttribute("data-note-id", note.id);
    mark.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 40 }) as DOMRect;
    layer.append(mark);
    book.documentElement.append(layer);
    vi.mocked(reader.mount).mockImplementation(async (...args) => {
      args[2]({ canAdvance: true, canRetreat: true });
      args[3]?.(book);
      return "ready";
    });
    const user = userEvent.setup();
    render(shell(reader, notes));
    await screen.findByText("Reader ready");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Notes (1)" })).toBeInTheDocument(),
    );
    const click = (x: number) =>
      book
        .getElementById("text")!
        .dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: 20 }),
        );
    // Outside the passage, a click stays the book's.
    act(() => void click(300));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    act(() => void click(50));
    const menu = await screen.findByRole("menu", { name: "Saved passage" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Open in notes", "Delete"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Open in notes" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Jump to note 1" })).toHaveFocus(),
    );
    act(() => void click(50));
    await user.click(
      within(await screen.findByRole("menu", { name: "Saved passage" })).getByRole("menuitem", {
        name: "Delete",
      }),
    );
    await waitFor(() => expect(notes.remove).toHaveBeenCalledWith(note.id));
    expect((await screen.findAllByText("Note removed.")).length).toBeGreaterThan(0);
    await waitFor(() => expect(reader.setNoteHighlights).toHaveBeenLastCalledWith([]));
    frame.remove();
  });

  it("keeps search/order across panel visits and mutations, resets on book change and a new session", async () => {
    const reader = adapter();
    const items = [
      { ...note, body: "Late THOUGHT", locator: { ...note.locator, spineIndex: 3 } },
      {
        ...note,
        id: "22222222-2222-4222-8222-222222222222",
        body: "Early thought",
        passage: "English passage",
      },
    ];
    const notes = store(items);
    const view = render(shell(reader, notes));
    const user = userEvent.setup();
    await screen.findByText("Reader ready");
    await user.click(screen.getByRole("button", { name: /^Notes/ }));
    const search = screen.getByRole("searchbox", { name: "Search notes" });
    expect(search).toHaveAttribute("spellcheck", "false");
    await user.type(search, "THOUGHT");
    expect(screen.getByText("2 of 2 notes")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Note order" }), "reading");
    expect(screen.getAllByRole("button", { name: /^Jump to note/ })[0]).toHaveTextContent(
      "Early thought",
    );
    await waitFor(() => expect(reader.setNoteHighlights).toHaveBeenLastCalledWith(items));
    const highlights = vi.mocked(reader.setNoteHighlights!).mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Jump to note 1" }));
    await waitFor(() => expect(reader.goToBookmark).toHaveBeenCalledWith(items[1].locator));
    await user.click(screen.getByRole("button", { name: "Edit note 1" }));
    await user.clear(screen.getByRole("textbox", { name: "Note" }));
    await user.type(screen.getByRole("textbox", { name: "Note" }), "Changed body");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(screen.getByText("1 of 2 notes")).toBeInTheDocument());
    expect(notes.edit).toHaveBeenCalledWith(items[1].id, "Changed body");
    await user.click(screen.getByRole("button", { name: "Back to reader controls" }));
    await user.click(screen.getByRole("button", { name: /^Notes/ }));
    expect(screen.getByRole("searchbox")).toHaveValue("THOUGHT");
    expect(screen.getByRole("combobox")).toHaveValue("reading");
    await user.click(screen.getByRole("button", { name: "Remove note 1" }));
    await screen.findByText("No matching notes.");
    expect(screen.getByText("0 of 1 notes")).toBeInTheDocument();
    expect(screen.queryByText(/^No notes yet/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear note search" }));
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByRole("searchbox")).toHaveFocus();
    await user.type(screen.getByRole("searchbox"), "english PASSAGE");
    expect(screen.getByText("1 of 1 notes")).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "selected");
    fireEvent.keyDown(screen.getByRole("main"), { key: "n" });
    await user.type(await screen.findByRole("textbox", { name: "Note" }), "New thought");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await screen.findByText("1 of 2 notes");
    expect(screen.getByRole("button", { name: "Jump to note 1" })).toHaveTextContent("New thought");
    expect(vi.mocked(reader.setNoteHighlights!).mock.calls.length).toBe(highlights + 3);
    expect(reader.mount).toHaveBeenCalledOnce();
    expect(reader.advancePage).not.toHaveBeenCalled();
    const next = store([note]);
    view.rerender(shell(adapter(), next));
    await screen.findByText("1 of 1 notes");
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByRole("combobox")).toHaveValue("creation");
    await user.type(screen.getByRole("searchbox"), "book");
    view.unmount();
    render(shell(adapter(), next));
    await user.click(screen.getByRole("button", { name: /^Notes/ }));
    await screen.findByText("1 of 1 notes");
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(items[1].body).toBe("Early thought");
  });
  it("keeps filters through load/save failures and retry, with empty and unavailable-jump feedback", async () => {
    const notes = store([note]);
    vi.mocked(notes.load).mockRejectedValueOnce(Error("failure"));
    const reader = adapter();
    vi.mocked(reader.goToBookmark!).mockResolvedValue(false);
    render(shell(reader, notes));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Notes/ }));
    await screen.findByText("Could not load notes. Try again.");
    await user.type(screen.getByRole("searchbox"), "thought");
    await user.selectOptions(screen.getByRole("combobox"), "reading");
    await user.click(screen.getByRole("button", { name: "Reload notes" }));
    await screen.findByText("1 of 1 notes");
    expect(screen.getByRole("searchbox")).toHaveValue("thought");
    expect(screen.getByRole("combobox")).toHaveValue("reading");
    await user.click(screen.getByRole("button", { name: "Jump to note 1" }));
    await screen.findByText(/This place is unavailable/);
    vi.mocked(notes.remove).mockRejectedValueOnce(Error("Could not save notes. Try again."));
    await user.click(screen.getByRole("button", { name: "Remove note 1" }));
    await screen.findByText("Could not save notes. Try again.");
    expect(screen.getByText("1 of 1 notes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove note 1" }));
    await screen.findByText(/^No notes yet/);
    expect(screen.getByText("0 of 0 notes")).toBeInTheDocument();
  });
  it("keeps a pending save single, errors editable, and unresolved notes manageable without a source", async () => {
    const notes = store([note]);
    render(shell(undefined, notes));
    await userEvent.click(screen.getByRole("button", { name: /^Notes/ }));
    expect(await screen.findByRole("button", { name: "Jump to note 1" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit note 1" }));
    let fail!: (error: Error) => void;
    vi.mocked(notes.edit).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(screen.getByRole("button", { name: "Saving note…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "n" });
    await act(async () => fail(Error("Could not save notes. Try again.")));
    expect(screen.getByRole("dialog")).toHaveTextContent("Could not save notes");
    expect(notes.edit).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove note 1" }));
    await waitFor(() => expect(notes.remove).toHaveBeenCalled());
  });
  it("rejects empty selections and late captures or lists after a book change", async () => {
    const first = adapter();
    const notes = store();
    vi.mocked(first.captureNote!).mockResolvedValueOnce(null);
    const view = render(shell(first, notes));
    await screen.findByText("Reader ready");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Notes (0)" })).toBeInTheDocument(),
    );
    fireEvent.keyDown(screen.getByRole("main"), { key: "n" });
    expect(await screen.findByText(/Select 1–4,096 characters/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    let finish!: (value: typeof place) => void;
    vi.mocked(first.captureNote!).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.keyDown(screen.getByRole("main"), { key: "n" });
    view.rerender(shell(adapter(), store()));
    await act(async () => finish(place));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(notes.create).not.toHaveBeenCalled();
  });
});

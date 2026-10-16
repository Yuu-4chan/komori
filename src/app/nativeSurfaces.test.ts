import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  editableField,
  guardDocument,
  isBrowserShortcut,
  setSurfaceHost,
  type SurfaceHost,
} from "./nativeSurfaces";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("browser surfaces", () => {
  let host: { [K in keyof SurfaceHost]: Mock<SurfaceHost[K]> };
  let cleanups: (() => void)[];

  beforeEach(() => {
    vi.useFakeTimers();
    host = {
      tooltip: vi.fn<SurfaceHost["tooltip"]>(),
      menu: vi.fn<SurfaceHost["menu"]>(),
      list: vi.fn<SurfaceHost["list"]>(),
    };
    cleanups = [setSurfaceHost(host), guardDocument(document)];
  });
  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("knows the browser's own shortcuts and leaves Komori's and editing keys alone", () => {
    for (const init of [
      { key: "p", ctrlKey: true },
      { key: "F", ctrlKey: true, shiftKey: true },
      { key: "r", ctrlKey: true },
      { key: "s", metaKey: true },
      { key: "u", ctrlKey: true },
      { key: "F5" },
      { key: "F7" },
      { key: "F3" },
    ])
      expect(isBrowserShortcut(key(init))).toBe(true);
    for (const init of [
      { key: "c", ctrlKey: true },
      { key: "v", ctrlKey: true },
      { key: "a", ctrlKey: true },
      { key: "b", ctrlKey: true },
      { key: "p" },
      { key: "p", ctrlKey: true, altKey: true },
      { key: "Escape" },
    ])
      expect(isBrowserShortcut(key(init))).toBe(false);
  });

  it("blocks browser shortcuts only after Komori's own handlers had their turn", () => {
    let seenPrevented: boolean | null = null;
    const own = (event: KeyboardEvent) => (seenPrevented = event.defaultPrevented);
    document.addEventListener("keydown", own);
    const print = key({ key: "p", ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(print);
    expect(seenPrevented).toBe(false);
    expect(print.defaultPrevented).toBe(true);
    const copy = key({ key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(false);
    document.removeEventListener("keydown", own);
  });

  it("blocks page Select all while preserving text editing and ordinary selection", () => {
    document.body.innerHTML = `<p>Readable text</p><input /><input type="search" />
      <input type="number" /><input readonly /><textarea></textarea><input type="checkbox" />
      <select><option>Choice</option></select><div contenteditable="plaintext-only"><b>Edit</b>
      <span contenteditable="false">Fixed</span></div><div role="textbox"><b>Edit</b></div>`;
    const press = (target: Element, init: KeyboardEventInit = {}) => {
      const event = key({ key: "a", ctrlKey: true, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    for (const target of document.querySelectorAll(
      'input:not([type="checkbox"]), textarea, [contenteditable] > b, [role="textbox"] > b',
    ))
      expect(press(target)).toBe(false);
    for (const target of [
      document.body,
      ...document.querySelectorAll('p, input[type="checkbox"], select, [contenteditable="false"]'),
    ]) {
      expect(press(target)).toBe(true);
      expect(press(target, { ctrlKey: false, metaKey: true })).toBe(true);
      expect(press(target, { repeat: true })).toBe(true);
      expect(press(target, { shiftKey: true })).toBe(true);
    }
    expect(press(document.body, { ctrlKey: false })).toBe(false);
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("p")!);
    document.getSelection()!.addRange(range);
    expect(press(document.body)).toBe(true);
    expect(document.getSelection()!.toString()).toBe("Readable text");
  });

  it("shows a title as Komori's tooltip and gives the title back on leaving", () => {
    document.body.innerHTML = '<button title="Add books"><span>+</span></button><p>Away</p>';
    const button = document.querySelector("button")!;
    button.firstElementChild!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    expect(button).not.toHaveAttribute("title");
    expect(host.tooltip).not.toHaveBeenCalledWith(expect.objectContaining({ text: "Add books" }));
    vi.advanceTimersByTime(700);
    expect(host.tooltip).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Add books" }));
    button.dispatchEvent(
      new PointerEvent("pointerout", {
        bubbles: true,
        relatedTarget: document.querySelector("p"),
      }),
    );
    expect(host.tooltip).toHaveBeenLastCalledWith(null);
    expect(button).toHaveAttribute("title", "Add books");
  });

  it("answers a right-click with Komori's text menu, or with nothing", () => {
    document.body.innerHTML =
      '<input aria-label="Search" value="cats" /><input type="checkbox" /><div class="empty"></div>';
    const press = (target: Element, prevented = false) => {
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 30,
      });
      if (prevented)
        target.addEventListener("contextmenu", (e) => e.preventDefault(), { once: true });
      target.dispatchEvent(event);
      return event;
    };

    const field = document.querySelector("input")!;
    expect(press(field).defaultPrevented).toBe(true);
    expect(host.menu).toHaveBeenLastCalledWith({ x: 20, y: 30, field, selection: "" });

    host.menu.mockClear();
    expect(press(document.querySelector(".empty")!).defaultPrevented).toBe(true);
    expect(press(document.querySelector('[type="checkbox"]')!).defaultPrevented).toBe(true);
    expect(host.menu).not.toHaveBeenCalled();

    // A card's own menu has already answered.
    press(document.querySelector(".empty")!, true);
    expect(host.menu).not.toHaveBeenCalled();
  });

  it("opens Komori's list for a select and for a field's suggestions", () => {
    document.body.innerHTML = `
      <select aria-label="Keep"><option value="1">1</option><option value="2">2</option></select>
      <input aria-label="Series name" list="names" />
      <datalist id="names"><option value="Cat Tales"></option><option value="Dog Days"></option></datalist>`;
    const select = document.querySelector("select")!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    select.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(host.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "select", element: select }),
    );

    const input = document.querySelector<HTMLInputElement>('[aria-label="Series name"]')!;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(input).not.toHaveAttribute("list");
    expect(input).toHaveAttribute("role", "combobox");
    expect(host.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "suggestions", options: ["Cat Tales", "Dog Days"] }),
    );
    input.value = "cat";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(host.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "suggestions", options: ["Cat Tales"] }),
    );
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(host.list).toHaveBeenLastCalledWith(null);
  });

  it("keeps links and images in the window", () => {
    document.body.innerHTML = '<a href="/settings">Settings</a><img alt="" src="data:," />';
    const link = document.querySelector("a")!;
    for (const init of [{ ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
      const click = new MouseEvent(init.button === 1 ? "auxclick" : "click", {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      link.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
    }
    const drag = new Event("dragstart", { bubbles: true, cancelable: true });
    document.querySelector("img")!.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
    const middle = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 });
    document.body.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);
  });

  it("edits only text fields", () => {
    document.body.innerHTML =
      '<input /><input type="search" /><input type="range" /><textarea></textarea><span></span>';
    const [text, search, range] = Array.from(document.querySelectorAll("input"));
    expect(editableField(text)).toBe(text);
    expect(editableField(search)).toBe(search);
    expect(editableField(range)).toBeNull();
    expect(editableField(document.querySelector("textarea"))).not.toBeNull();
    expect(editableField(document.querySelector("span"))).toBeNull();
  });

  it("prevents file-drop navigation in the app and book frames while keeping own handlers and cleanup", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const book = frame.contentDocument!;
    const unguardBook = guardDocument(book);
    cleanups.push(unguardBook);
    const dispatch = (doc: Document, type: string, types: string[]) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { types } });
      doc.body.dispatchEvent(event);
      return event;
    };
    for (const doc of [document, book]) {
      const own = vi.fn();
      doc.addEventListener("drop", own);
      expect(dispatch(doc, "dragover", ["Files"]).defaultPrevented).toBe(true);
      expect(dispatch(doc, "drop", ["Files"]).defaultPrevented).toBe(true);
      expect(own).toHaveBeenCalledOnce();
      expect(dispatch(doc, "drop", ["text/plain"]).defaultPrevented).toBe(false);
      doc.removeEventListener("drop", own);
    }
    cleanups[1]();
    unguardBook();
    expect(dispatch(document, "drop", ["Files"]).defaultPrevented).toBe(false);
    expect(dispatch(book, "drop", ["Files"]).defaultPrevented).toBe(false);
  });
});

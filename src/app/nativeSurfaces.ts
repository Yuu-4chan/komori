/**
 * Keeps WebView2's browser surfaces out of Komori: its tooltips, right-click menu, select and
 * suggestion popups, browser shortcuts (print, find, reload, save, view source, caret browsing),
 * link drags, native middle-button defaults and links opened in new windows. Each document guarded
 * here (the app and each displayed book section) hands what it would have shown natively to
 * one host, which shows Komori's own tooltip, menu, or list instead.
 */

export type EditableField = HTMLInputElement | HTMLTextAreaElement;

export interface MenuRequest {
  /** Where the menu opens, in the app window's coordinates. */
  x: number;
  y: number;
  /** The text field the menu edits, if the press was in one. */
  field: EditableField | null;
  /** The selected text outside a field, which the menu copies. */
  selection: string;
}

export type ListRequest =
  | { kind: "select"; element: HTMLSelectElement; rect: DOMRect }
  | { kind: "suggestions"; element: HTMLInputElement; options: string[]; rect: DOMRect };

export interface SurfaceHost {
  tooltip(tip: { text: string; rect: DOMRect } | null): void;
  menu(request: MenuRequest): void;
  list(request: ListRequest | null): void;
}

let host: SurfaceHost | null = null;

/** The app's one host; returns a cleanup that releases it. */
export function setSurfaceHost(next: SurfaceHost) {
  host = next;
  return () => {
    if (host === next) host = null;
  };
}

const TOOLTIP_DELAY_MS = 600;
// Ctrl (or Cmd) with these opens find, find next, history, downloads, a new window, an open-file
// dialog, print, reload, save page, or view source.
const BROWSER_CTRL_KEYS = new Set(["f", "g", "h", "j", "n", "o", "p", "r", "s", "u"]);
// Find next, reload, and the caret browsing prompt.
const BROWSER_KEYS = new Set(["F3", "F5", "F7", "BrowserRefresh", "BrowserSearch"]);
const TEXT_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "url",
  "email",
  "tel",
  "number",
  "password",
]);

/** Whether a key would open one of the browser's own features rather than Komori's. */
export function isBrowserShortcut(event: KeyboardEvent): boolean {
  if (BROWSER_KEYS.has(event.key)) return true;
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    event.key.length === 1 &&
    BROWSER_CTRL_KEYS.has(event.key.toLowerCase())
  );
}

/** The text field an event happened in, if it is one a text menu can edit. */
export function editableField(target: EventTarget | null): EditableField | null {
  const element = target as Element | null;
  if (!element || typeof element.closest !== "function") return null;
  const field = element.closest("input, textarea");
  if (!field) return null;
  if (field.tagName === "TEXTAREA") return field as HTMLTextAreaElement;
  const input = field as HTMLInputElement;
  return TEXT_INPUT_TYPES.has(input.getAttribute("type")?.toLowerCase() ?? "") ? input : null;
}

/** Text editing keeps native Select all, including content inside an editable element. */
export function textEditingTarget(target: EventTarget | null): boolean {
  if (editableField(target)) return true;
  const element = target as Element | null;
  const editable = element?.closest?.("[contenteditable]");
  return (
    (!!editable && editable.getAttribute("contenteditable")?.toLowerCase() !== "false") ||
    !!element?.closest?.('[role="textbox"]')
  );
}

/** Where a document's own coordinates sit in the app window (a book section's iframe). */
function frameOffset(document: Document) {
  const frame = document.defaultView?.frameElement;
  if (!frame) return { x: 0, y: 0 };
  const rect = frame.getBoundingClientRect();
  return { x: rect.left + frame.clientLeft, y: rect.top + frame.clientTop };
}

function inAppWindow(document: Document, rect: DOMRect) {
  const offset = frameOffset(document);
  return new DOMRect(rect.x + offset.x, rect.y + offset.y, rect.width, rect.height);
}

/** Guards one document; returns a cleanup that removes every listener. */
export function guardDocument(document: Document): () => void {
  const view = document.defaultView;
  if (!view) return () => {};

  // Tooltips: an element's title is held aside while the pointer is over it, so the browser
  // shows none, and the host shows it after the usual delay.
  let titled: Element | null = null;
  let titleText = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const leaveTitled = () => {
    clearTimeout(timer);
    host?.tooltip(null);
    if (!titled) return;
    if (titled.isConnected && !titled.hasAttribute("title"))
      titled.setAttribute("title", titleText);
    titled.removeAttribute("data-komori-title");
    titled = null;
  };
  const over = (event: PointerEvent) => {
    const target = event.target as Element | null;
    const element = target?.closest?.("[title], [data-komori-title]") ?? null;
    if (element === titled) return;
    leaveTitled();
    const text = element?.getAttribute("title");
    if (!element || !text?.trim()) return;
    titled = element;
    titleText = text;
    element.setAttribute("data-komori-title", "");
    element.removeAttribute("title");
    timer = setTimeout(() => {
      if (titled === element && element.isConnected)
        host?.tooltip({ text, rect: inAppWindow(document, element.getBoundingClientRect()) });
    }, TOOLTIP_DELAY_MS);
  };
  const out = (event: PointerEvent) => {
    const next = event.relatedTarget as Node | null;
    if (titled && !(next && titled.contains(next))) leaveTitled();
  };

  const key = (event: KeyboardEvent) => {
    leaveTitled();
    if (isBrowserShortcut(event)) event.preventDefault();
    // Collection handlers run first. Elsewhere Select all must never select the app or book.
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      event.key.toLowerCase() === "a" &&
      !textEditingTarget(event.target)
    )
      event.preventDefault();
  };

  const contextMenu = (event: MouseEvent) => {
    leaveTitled();
    // Komori's own menus (a Library card's) and the Reader's lookup have answered already.
    if (event.defaultPrevented) return;
    event.preventDefault();
    const field = editableField(event.target);
    const selection = field ? "" : (document.getSelection()?.toString() ?? "");
    if (!field && !selection.trim()) return;
    const offset = frameOffset(document);
    host?.menu({ x: event.clientX + offset.x, y: event.clientY + offset.y, field, selection });
  };

  const pointerDown = (event: PointerEvent) => {
    leaveTitled();
    // Komori's shared controller owns middle-button scrolling, including paginated books.
    if (event.button === 1) event.preventDefault();
  };
  const mouseDown = (event: MouseEvent) => {
    if (event.button === 1) event.preventDefault();
    // A select opens Komori's list instead of the browser's popup.
    const select = (event.target as Element | null)?.closest?.("select");
    if (event.button === 0 && select instanceof view.HTMLSelectElement && !select.disabled) {
      event.preventDefault();
      select.focus();
      host?.list({ kind: "select", element: select, rect: select.getBoundingClientRect() });
    }
  };
  const selectKey = (event: KeyboardEvent) => {
    const select = event.target;
    if (!(select instanceof view.HTMLSelectElement) || select.disabled) return;
    const opens =
      ((event.key === "ArrowDown" || event.key === "ArrowUp") && event.altKey) ||
      event.key === "F4" ||
      event.key === " " ||
      event.key === "Enter";
    if (!opens) return;
    event.preventDefault();
    host?.list({ kind: "select", element: select, rect: select.getBoundingClientRect() });
  };

  // A field's suggestions (a datalist) show in Komori's list rather than the browser's.
  const suggest = (event: Event) => {
    const input = event.target;
    if (!(input instanceof view.HTMLInputElement)) return;
    const listId = input.getAttribute("list") ?? input.getAttribute("data-komori-list");
    if (!listId) return;
    if (input.hasAttribute("list")) {
      input.setAttribute("data-komori-list", listId);
      input.removeAttribute("list");
      input.setAttribute("role", "combobox");
      input.setAttribute("aria-autocomplete", "list");
    }
    if (event.type === "focusout") {
      host?.list(null);
      return;
    }
    const typed = input.value.trim().toLowerCase();
    const options = Array.from(document.getElementById(listId)?.querySelectorAll("option") ?? [])
      .map((option) => option.value)
      .filter((value) => value && value.toLowerCase().includes(typed) && value !== input.value);
    host?.list(
      options.length > 0 && !input.disabled
        ? { kind: "suggestions", element: input, options, rect: input.getBoundingClientRect() }
        : null,
    );
  };

  const dragStart = (event: DragEvent) => {
    const target = event.target as Element | null;
    if (target?.closest?.("a, img") && !target.closest('[draggable="true"]'))
      event.preventDefault();
  };
  // File drops belong to the Library. Elsewhere they must not replace an app/book document.
  // Keep propagation intact so the Library's own listeners can handle them.
  const fileDrop = (event: DragEvent) => {
    if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) event.preventDefault();
  };

  // Links never open a second browser window: not with Ctrl, Shift or the middle button.
  const click = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    const link = (event.target as Element | null)?.closest?.("a[href]");
    if (link && (event.button === 1 || event.ctrlKey || event.shiftKey || event.metaKey))
      event.preventDefault();
  };

  const hide = () => leaveTitled();

  document.addEventListener("pointerover", over);
  document.addEventListener("pointerout", out);
  document.addEventListener("pointerdown", pointerDown);
  document.addEventListener("mousedown", mouseDown);
  document.addEventListener("keydown", selectKey);
  document.addEventListener("focusin", suggest);
  document.addEventListener("input", suggest);
  document.addEventListener("focusout", suggest);
  document.addEventListener("dragstart", dragStart);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("wheel", hide, { passive: true });
  // On the window, after the app's own handlers have had their turn.
  view.addEventListener("keydown", key);
  view.addEventListener("contextmenu", contextMenu);
  view.addEventListener("click", click);
  view.addEventListener("auxclick", click);
  view.addEventListener("blur", hide);
  view.addEventListener("dragover", fileDrop);
  view.addEventListener("drop", fileDrop);
  return () => {
    leaveTitled();
    document.removeEventListener("pointerover", over);
    document.removeEventListener("pointerout", out);
    document.removeEventListener("pointerdown", pointerDown);
    document.removeEventListener("mousedown", mouseDown);
    document.removeEventListener("keydown", selectKey);
    document.removeEventListener("focusin", suggest);
    document.removeEventListener("input", suggest);
    document.removeEventListener("focusout", suggest);
    document.removeEventListener("dragstart", dragStart);
    document.removeEventListener("scroll", hide, true);
    document.removeEventListener("wheel", hide);
    view.removeEventListener("keydown", key);
    view.removeEventListener("contextmenu", contextMenu);
    view.removeEventListener("click", click);
    view.removeEventListener("auxclick", click);
    view.removeEventListener("blur", hide);
    view.removeEventListener("dragover", fileDrop);
    view.removeEventListener("drop", fileDrop);
  };
}

/** Sets a field's or select's value as typing or choosing would, so React sees the change. */
export function setControlValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const prototype = Object.getPrototypeOf(element) as object;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Copies plain text, falling back to the editing command where the clipboard API is missing. */
export function copyText(text: string) {
  const fallback = () => {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.style.position = "fixed";
    scratch.style.opacity = "0";
    document.body.append(scratch);
    scratch.select();
    document.execCommand("copy");
    scratch.remove();
  };
  if (navigator.clipboard) void navigator.clipboard.writeText(text).catch(fallback);
  else fallback();
}

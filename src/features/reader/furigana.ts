import { i18n } from "../../i18n/i18n";
import type { ReaderFuriganaStyle } from "./presentation";

const STYLE = "data-komori-hide-furigana";
const ACTION = "data-komori-furigana-action";
const REVEALED = "data-komori-furigana-revealed";
const ORIGINAL = "data-komori-furigana-original";
const attributes = ["role", "tabindex", "aria-label", "aria-pressed"] as const;
const namespace = "http://www.w3.org/1999/xhtml";

function restore(ruby: Element): void {
  const saved = ruby.getAttribute(ORIGINAL);
  if (saved) {
    try {
      const values: unknown = JSON.parse(saved);
      if (Array.isArray(values) && values.length === attributes.length) {
        attributes.forEach((name, index) => {
          const value = values[index];
          if (value === null) ruby.removeAttribute(name);
          else if (typeof value === "string") ruby.setAttribute(name, value);
        });
      }
    } catch {
      // Publisher attributes cannot prevent reading.
    }
  }
  for (const name of [ACTION, REVEALED, ORIGINAL]) ruby.removeAttribute(name);
}

/** Per-book reveals keyed by section/ruby occurrence, never saved in the EPUB or preferences. */
export class FuriganaSession {
  private revealed = new Set<string>();
  private watches = new Map<Document, () => void>();
  private applied = new WeakMap<Document, string>();
  private revision = 0;
  private style: ReaderFuriganaStyle = "hide";
  private disposed = false;

  constructor(
    private refresh: () => void,
    private canActivate: () => boolean,
  ) {}

  apply(document: Document, spineIndex: number, enabled: boolean, mode: ReaderFuriganaStyle): void {
    if (this.disposed) return;
    this.style = mode;
    const key = `${spineIndex}:${enabled}:${mode}:${this.revision}:${i18n().language}`;
    if (this.applied.get(document) === key) return;
    this.applied.set(document, key);
    const rubies = [...document.querySelectorAll("body ruby")];
    rubies.forEach((ruby, ordinal) => {
      const interactive =
        enabled &&
        mode !== "hide" &&
        [...ruby.querySelectorAll("rt")].some((rt) => rt.closest("ruby") === ruby) &&
        !ruby.closest("a[href], button, input, select, textarea, [contenteditable]");
      if (!interactive) {
        restore(ruby);
        return;
      }
      if (!ruby.hasAttribute(ORIGINAL))
        ruby.setAttribute(
          ORIGINAL,
          JSON.stringify(attributes.map((name) => ruby.getAttribute(name))),
        );
      const key = `${spineIndex}:${ordinal}`;
      const revealed = this.revealed.has(key);
      ruby.setAttribute(ACTION, key);
      ruby.toggleAttribute(REVEALED, revealed);
      ruby.setAttribute("role", "button");
      ruby.setAttribute("tabindex", "0");
      const base = ruby.cloneNode(true) as Element;
      base.querySelectorAll("rt, rp").forEach((annotation) => annotation.remove());
      const text = (base.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
      ruby.setAttribute(
        "aria-label",
        i18n().t(revealed && mode === "toggle" ? "furigana.conceal" : "furigana.reveal", { text }),
      );
      ruby.setAttribute("aria-pressed", String(revealed));
    });
    let style = document.querySelector(`style[${STYLE}]`);
    if (!enabled) {
      style?.remove();
      return;
    }
    if (!style) {
      style = document.createElementNS(namespace, "style");
      style.setAttribute(STYLE, "");
      (document.head ?? document.documentElement).prepend(style);
    }
    if (mode === "hide") {
      style.textContent = ":root body rt, :root body rp { display: none !important; }";
      return;
    }
    const revealed = `:root body ruby[${REVEALED}] rt`;
    const hover = ":root body ruby:hover rt, :root body ruby:focus-visible rt";
    const rules =
      mode === "partial"
        ? `:root body rt { opacity: 0.35 !important; } ${revealed} { opacity: 1 !important; } @media (hover: hover) { ${hover} { opacity: 1 !important; } }`
        : `:root body rt { visibility: hidden !important; } ${revealed} { visibility: visible !important; } ${mode === "full" ? `@media (hover: hover) { ${hover} { visibility: visible !important; } }` : ""}`;
    style.textContent = `@layer komori-furigana { :root body rp { display: none !important; } ${rules} :root body [${ACTION}] { cursor: pointer; } :root body [${ACTION}]:focus-visible { outline: 2px solid Highlight !important; outline-offset: 2px; } }`;
    if (style !== document.head?.firstElementChild) document.head?.prepend(style);
  }

  /** Install before lookup/VN click handlers; drop listeners as views are discarded. */
  watchDocuments(documents: Document[]): void {
    if (this.disposed) return;
    for (const [document, stop] of this.watches) {
      if (documents.includes(document) && document.querySelector(`[${ACTION}]`)) continue;
      stop();
      this.watches.delete(document);
    }
    for (const document of documents) {
      if (this.watches.has(document) || !document.querySelector(`[${ACTION}]`)) continue;
      const target = (event: Event) => (event.target as Element | null)?.closest?.(`[${ACTION}]`);
      const mouseFocus = new Map<Element, ReturnType<typeof setTimeout>>();
      const restoreFocus = (ruby: Element) => {
        if (ruby.hasAttribute(ACTION) && !ruby.hasAttribute("tabindex"))
          ruby.setAttribute("tabindex", "0");
      };
      const mouseDown = (event: MouseEvent) => {
        const ruby = target(event);
        if (!ruby || event.button !== 0) return;
        // Chromium focuses a tabindex ruby instead of starting a text selection.
        // Suspend mouse focus for this default action; keyboard access returns next tick.
        ruby.removeAttribute("tabindex");
        clearTimeout(mouseFocus.get(ruby));
        mouseFocus.set(
          ruby,
          setTimeout(() => {
            mouseFocus.delete(ruby);
            restoreFocus(ruby);
          }, 0),
        );
      };
      const activate = (event: Event, ruby: Element) => {
        if (!this.canActivate()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const key = ruby.getAttribute(ACTION)!;
        if (this.style === "toggle" && this.revealed.has(key)) this.revealed.delete(key);
        else this.revealed.add(key);
        this.revision++;
        this.refresh();
      };
      const click = (event: MouseEvent) => {
        const ruby = target(event);
        if (
          !ruby ||
          event.button !== 0 ||
          event.shiftKey ||
          event.ctrlKey ||
          event.altKey ||
          event.metaKey ||
          document.getSelection()?.isCollapsed === false
        )
          return;
        activate(event, ruby);
      };
      const pointerUp = (event: PointerEvent) => {
        if (
          target(event) &&
          event.button === 0 &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey &&
          document.getSelection()?.isCollapsed !== false &&
          this.canActivate()
        )
          // Lookup schedules a direct click on pointer release. Mark ownership while
          // still letting its watcher finish the press and report real selections.
          event.preventDefault();
      };
      const key = (event: KeyboardEvent) => {
        const ruby = target(event);
        if (
          !ruby ||
          (event.key !== "Enter" && event.key !== " ") ||
          event.shiftKey ||
          event.ctrlKey ||
          event.altKey ||
          event.metaKey ||
          event.isComposing
        )
          return;
        if (event.type === "keyup" || event.repeat) {
          event.preventDefault();
          event.stopImmediatePropagation();
        } else activate(event, ruby);
      };
      document.addEventListener("mousedown", mouseDown, true);
      document.addEventListener("pointerup", pointerUp, true);
      document.addEventListener("click", click, true);
      document.addEventListener("keydown", key, true);
      document.addEventListener("keyup", key, true);
      this.watches.set(document, () => {
        document.removeEventListener("mousedown", mouseDown, true);
        document.removeEventListener("pointerup", pointerUp, true);
        document.removeEventListener("click", click, true);
        document.removeEventListener("keydown", key, true);
        document.removeEventListener("keyup", key, true);
        for (const [ruby, timer] of mouseFocus) {
          clearTimeout(timer);
          restoreFocus(ruby);
        }
        mouseFocus.clear();
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const stop of this.watches.values()) stop();
    this.watches.clear();
    this.revealed.clear();
    this.applied = new WeakMap();
  }
}

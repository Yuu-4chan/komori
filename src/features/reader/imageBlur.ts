import { i18n } from "../../i18n/i18n";
import type { ReaderBlurMode } from "./presentation";

/** The end of the authored contents page, or a contents container within a section. */
export interface ImageBlurBoundary {
  spineIndex: number;
  fragment?: string;
}

const ACTION = "data-komori-image-action";
const BLURRED = "data-komori-image-blurred";
const ORIGINAL = "data-komori-image-original";
const FILTER = "data-komori-image-filter";
const STYLE = "data-komori-blur-image";
const attributes = ["role", "tabindex", "aria-label", "aria-pressed", "title"] as const;
const namespace = "http://www.w3.org/1999/xhtml";

/** Images are occurrences, including repeated resources; outer SVGs count once. */
function media(document: Document): Element[] {
  return [...document.querySelectorAll("body img, body video, body svg")].filter(
    (element) => !element.parentElement?.closest("svg"),
  );
}

function restore(element: Element): void {
  inlineFilter(element, false, true);
  const saved = element.getAttribute(ORIGINAL);
  if (saved) {
    try {
      const values: unknown = JSON.parse(saved);
      if (Array.isArray(values) && values.length === attributes.length) {
        attributes.forEach((name, index) => {
          const value = values[index];
          if (value === null) element.removeAttribute(name);
          else if (typeof value === "string") element.setAttribute(name, value);
        });
      }
    } catch {
      // A malformed publisher attribute never prevents reading.
    }
  }
  for (const name of [ACTION, BLURRED, ORIGINAL]) element.removeAttribute(name);
}

/** Inline important declarations outrank even an important layer. Keep only that override. */
function inlineFilter(element: Element, blurred: boolean, restore = false): void {
  const style = (element as HTMLElement).style;
  if (!style) return;
  let saved = element.getAttribute(FILTER);
  if (!saved && !restore && style.getPropertyPriority("filter") === "important") {
    saved = JSON.stringify([style.getPropertyValue("filter"), "important"]);
    element.setAttribute(FILTER, saved);
  }
  if (!saved) return;
  try {
    const original: unknown = JSON.parse(saved);
    if (Array.isArray(original) && typeof original[0] === "string" && original[1] === "important")
      style.setProperty("filter", blurred ? "blur(20px)" : original[0], "important");
  } catch {
    // Malformed publisher attributes are ignored.
  }
  if (restore) element.removeAttribute(FILTER);
}

/** Adapter-owned, non-durable reveal state. Styling never changes the document's layout. */
export class ImageBlurSession {
  private revealed = new Set<string>();
  private watches = new Map<Document, () => void>();
  private disposed = false;

  constructor(
    private refresh: () => void,
    private canActivate: () => boolean,
  ) {}

  apply(
    document: Document,
    spineIndex: number,
    enabled: boolean,
    mode: ReaderBlurMode,
    boundary?: ImageBlurBoundary,
  ): void {
    if (this.disposed) return;
    const elements = media(document);
    const end = boundary?.fragment ? document.getElementById(boundary.fragment) : undefined;
    const container = end?.closest('nav, [role="doc-toc"]') ?? end;
    // Missing fragments make the section's entire contents page the boundary.
    const affected = (element: Element) =>
      mode === "all" ||
      !boundary ||
      spineIndex > boundary.spineIndex ||
      (spineIndex === boundary.spineIndex &&
        !!container &&
        !container.contains(element) &&
        !!(container.compareDocumentPosition(element) & 4));
    let controls = false;
    elements.forEach((element, ordinal) => {
      if (!enabled || !affected(element)) {
        restore(element);
        return;
      }
      controls = true;
      if (!element.hasAttribute(ORIGINAL))
        element.setAttribute(
          ORIGINAL,
          JSON.stringify(attributes.map((name) => element.getAttribute(name))),
        );
      const key = `${spineIndex}:${ordinal}`;
      const revealed = this.revealed.has(key);
      element.setAttribute(ACTION, key);
      element.toggleAttribute(BLURRED, !revealed);
      inlineFilter(element, !revealed);
      element.setAttribute("role", "button");
      element.setAttribute("tabindex", "0");
      const alt = (element.getAttribute("alt") ?? element.querySelector("title")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
      const { t } = i18n();
      element.setAttribute(
        "aria-label",
        alt
          ? t("imageBlur.revealNamed", { name: alt })
          : t("imageBlur.reveal", { index: ordinal + 1 }),
      );
      element.setAttribute("aria-pressed", String(revealed));
      element.setAttribute("title", t(revealed ? "imageBlur.reblurHint" : "imageBlur.revealHint"));
    });
    let style = document.querySelector(`style[${STYLE}]`);
    if (!controls) {
      style?.remove();
      return;
    }
    if (!style) {
      style = document.createElementNS(namespace, "style");
      style.setAttribute(STYLE, "");
      (document.head ?? document.documentElement).append(style);
    }
    // An early layer overrides publisher important filters without changing sizes.
    style.textContent = `@layer komori-image-blur {\n:root body [${BLURRED}] { filter: blur(20px) !important; }\n:root body [${ACTION}] { cursor: pointer; outline: none !important; }\n:root body [${ACTION}]:focus-visible { outline: 2px solid Highlight !important; outline-offset: -2px; }\n}`;
    if (style !== document.head?.firstElementChild) document.head?.prepend(style);
  }

  /** Bind before lookup listeners. Release documents that the rendition discarded. */
  watchDocuments(documents: Document[]): void {
    if (this.disposed) return;
    const kept = new Set(documents);
    for (const [document, stop] of this.watches) {
      if (kept.has(document)) continue;
      stop();
      this.watches.delete(document);
    }
    for (const document of documents) {
      if (this.watches.has(document)) continue;
      const target = (event: Event) => (event.target as Element | null)?.closest?.(`[${ACTION}]`);
      const stop = (event: Event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const toggle = (element: Element) => {
        if (!this.canActivate()) return;
        const key = element.getAttribute(ACTION)!;
        if (this.revealed.has(key)) this.revealed.delete(key);
        else this.revealed.add(key);
        this.refresh();
      };
      const click = (event: MouseEvent) => {
        const element = target(event);
        if (
          !element ||
          event.button !== 0 ||
          event.ctrlKey ||
          event.altKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        stop(event);
        toggle(element);
      };
      const key = (event: KeyboardEvent) => {
        const element = target(event);
        if (
          !element ||
          !["Enter", " "].includes(event.key) ||
          event.ctrlKey ||
          event.altKey ||
          event.metaKey ||
          event.shiftKey ||
          event.isComposing
        )
          return;
        stop(event);
        if (event.type === "keydown" && !event.repeat) toggle(element);
      };
      const pointer = (event: PointerEvent) => {
        if (
          target(event) &&
          event.button === 0 &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey &&
          !event.shiftKey
        )
          event.stopImmediatePropagation();
      };
      document.addEventListener("click", click, true);
      document.addEventListener("keydown", key, true);
      document.addEventListener("keyup", key, true);
      document.addEventListener("pointerdown", pointer, true);
      document.addEventListener("pointerup", pointer, true);
      this.watches.set(document, () => {
        document.removeEventListener("click", click, true);
        document.removeEventListener("keydown", key, true);
        document.removeEventListener("keyup", key, true);
        document.removeEventListener("pointerdown", pointer, true);
        document.removeEventListener("pointerup", pointer, true);
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const stop of this.watches.values()) stop();
    this.watches.clear();
    this.revealed.clear();
  }
}

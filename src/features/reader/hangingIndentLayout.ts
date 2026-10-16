import type { ReaderWritingMode } from "./presentation";

const STYLE = "data-komori-hanging-indent-layout";
const NUMBER = "data-komori-numbered-subchapter";

/** EPUB Japanese layout classes use physical padding for their authored text axis. */
export function applyHangingIndentLayout(document: Document, mode?: ReaderWritingMode): void {
  const existing = document.querySelector(`style[${STYLE}]`);
  for (const element of document.querySelectorAll(`[${NUMBER}]`)) element.removeAttribute(NUMBER);
  const root = document.documentElement;
  const authored = root.classList.contains("vrtl")
    ? "vertical"
    : root.classList.contains("hltr")
      ? "horizontal"
      : undefined;
  if (!mode || !authored || mode === authored) {
    existing?.remove();
    return;
  }
  const rules = new Map<string, number>();
  let numbers = false;
  for (const element of document.querySelectorAll("body [class]")) {
    for (const name of element.classList) {
      const match = /^h-indent-(\d+)(?:em)?$/.exec(name);
      if (!match || Number(match[1]) > 20) continue;
      const indent = Number(match[1]);
      rules.set(name, indent);
      // Numbered subchapters already cancel the negative indent with authored spaces.
      // Keep prose hanging indents; only remove this duplicated offset from the number.
      if (
        element.children.length === 1 &&
        element.firstElementChild?.tagName.toLowerCase() === "p" &&
        new RegExp(`^\\u3000{${indent}}[0-9０-９]{1,3}\\s*$`).test(
          element.firstElementChild.textContent ?? "",
        )
      ) {
        element.setAttribute(NUMBER, "");
        numbers = true;
      }
    }
  }
  if (!rules.size) {
    existing?.remove();
    return;
  }
  const style = existing ?? document.createElementNS("http://www.w3.org/1999/xhtml", "style");
  if (!existing) {
    style.setAttribute(STYLE, "");
    (document.head ?? root).prepend(style);
  }
  // Move only the hanging-indent padding; preserve authored block gaps and DOM/CFIs.
  style.textContent = `@layer komori-hanging-indent { ${[...rules]
    .map(
      ([name, indent]) =>
        `:root body .${name} { padding-${authored === "vertical" ? "top" : "left"}: 0 !important; padding-inline-start: ${indent}em !important; }`,
    )
    .join(
      " ",
    )} ${numbers ? `:root body [${NUMBER}] { padding-inline-start: 0 !important; }` : ""} }`;
}

import { noteTextValid } from "./notes";

/** Detached plain text; block boundaries remain readable, inactive content and ruby excluded. */
export function notePassage(range: Range): string | null {
  const fragment = range.cloneContents();
  fragment
    .querySelectorAll("rt, rp, script, style, template, noscript, [hidden], [aria-hidden='true']")
    .forEach((node) => node.remove());
  fragment.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
  fragment
    .querySelectorAll("p, div, section, li, h1, h2, h3, h4, h5, h6, blockquote")
    .forEach((node) => node.append("\n"));
  const text = (fragment.textContent ?? "").replace(/\r\n?/g, "\n").trim();
  return noteTextValid(text) ? text : null;
}

import { editableTarget } from "./lookupTriggers";
import { matchesModifiers, shortcutCommand } from "./shortcuts";
import { i18n } from "../../i18n/i18n";

export function activateExpression(popup: HTMLElement, expression: Element, scroll = false) {
  const expressions = Array.from(popup.querySelectorAll<HTMLElement>("[data-popup-expression]"));
  if (!expressions.includes(expression as HTMLElement)) return;
  for (const entry of expressions) entry.dataset.active = String(entry === expression);
  const status = popup.querySelector("[data-active-expression-status]");
  if (status)
    status.textContent = i18n().t("popup.activeExpression", {
      index: expressions.indexOf(expression as HTMLElement) + 1,
      count: expressions.length,
    });
  const body = popup.querySelector<HTMLElement>(".reader-lookup__body");
  if (scroll && body) {
    // A taller-than-viewport entry can intersect both edges, making `nearest`
    // scrolling a no-op when returning to it. Scroll only the popup to its start.
    const padding = Number.parseFloat(getComputedStyle(body).paddingTop) || 0;
    body.scrollTop = Math.max(
      0,
      body.scrollTop +
        expression.getBoundingClientRect().top -
        body.getBoundingClientRect().top -
        padding,
    );
  }
}

/** Only the topmost popup handles commands, even when focus is still in the EPUB iframe. */
export function popupShortcut(event: KeyboardEvent | WheelEvent): boolean {
  const popup = Array.from(
    document.querySelectorAll<HTMLElement>(".reader-lookup:not(.reader-lookup--preview)"),
  ).at(-1);
  if (!popup || event.defaultPrevented || editableTarget(event.target)) return false;
  const expressions = Array.from(popup.querySelectorAll<HTMLElement>("[data-popup-expression]"));
  const active = expressions.find((entry) => entry.dataset.active === "true") ?? expressions[0];
  if ("key" in event) {
    const command = shortcutCommand(event, "Dictionary popup");
    if (command !== "anki-add" && command !== "anki-browse") return false;
    event.preventDefault();
    const button = active?.querySelector<HTMLButtonElement>(
      `[data-anki-action="${command === "anki-add" ? "add" : "browse"}"]`,
    );
    if (button && !button.disabled) button.click();
    return true;
  }
  if (!matchesModifiers(event, "alt") || !Number.isFinite(event.deltaY) || !event.deltaY)
    return false;
  event.preventDefault();
  if (active) {
    const index = Math.max(
      0,
      Math.min(expressions.length - 1, expressions.indexOf(active) + Math.sign(event.deltaY)),
    );
    activateExpression(popup, expressions[index], true);
  }
  return true;
}

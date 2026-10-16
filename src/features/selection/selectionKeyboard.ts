import { textEditingTarget } from "../../app/nativeSurfaces";

/** Collection shortcuts leave editing, modal and nested control contexts to their own keys. */
export function selectionKeyTarget(event: KeyboardEvent, scope: string): boolean {
  const target = event.target as Element | null;
  const document = target?.ownerDocument;
  return (
    !event.defaultPrevented &&
    !event.repeat &&
    !event.isComposing &&
    !event.altKey &&
    !event.shiftKey &&
    !textEditingTarget(target) &&
    !target?.closest?.(
      'input:not([type="checkbox"]), textarea, select, dialog, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="combobox"]',
    ) &&
    !document?.querySelector('dialog[open], [aria-modal="true"]') &&
    (target === document?.body ||
      target === document?.documentElement ||
      !!target?.closest?.(scope))
  );
}

export function selectAllKey(event: KeyboardEvent): boolean {
  return event.ctrlKey !== event.metaKey && event.key.toLowerCase() === "a";
}

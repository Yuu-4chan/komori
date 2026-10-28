import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  tone?: "default" | "danger";
  disabled?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  label: string;
  items: ContextMenuItem[];
  onClose: () => void;
  position: { x: number; y: number } | null;
  /** Where the menu is placed; a modal dialog's own menus belong inside it. */
  container?: HTMLElement;
}

export function ContextMenu({ items, label, onClose, position, container }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !position) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const bounds = menu.getBoundingClientRect();
    const gutter = 8;
    menu.style.left = `${Math.max(gutter, Math.min(position.x, window.innerWidth - bounds.width - gutter))}px`;
    menu.style.top = `${Math.max(gutter, Math.min(position.y, window.innerHeight - bounds.height - gutter))}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [position]);

  useEffect(() => {
    if (!position) return;
    function handlePointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    }
    // The open menu owns Escape and the arrows: taken before any other key handler, Escape
    // closes only the menu, never the surface behind it.
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        onClose();
        return;
      }
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
      );
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      items[(current + direction + items.length) % items.length]?.focus();
    }
    // A press in a book section's frame reaches only the frame; the window loses focus.
    function handleBlur() {
      onClose();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", handleBlur);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", handleBlur);
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [onClose, position]);

  if (!position) return null;

  return createPortal(
    <div
      aria-label={label}
      className="context-menu"
      ref={menuRef}
      role="menu"
      style={{ left: position.x, top: position.y }}
    >
      {items.map((item) => (
        <button
          className={item.tone === "danger" ? "context-menu__item--danger" : undefined}
          disabled={item.disabled}
          key={item.label}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
          role="menuitem"
          type="button"
        >
          {item.icon ? <span className="context-menu__icon">{item.icon}</span> : null}
          <span>{item.label}</span>
        </button>
      ))}
    </div>,
    container ?? document.body,
  );
}

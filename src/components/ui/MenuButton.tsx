import { CaretDownIcon } from "@phosphor-icons/react";
import { ChoiceCheck } from "./SelectionBox";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface MenuOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

interface MenuButtonProps<T extends string> {
  /** The menu's accessible name. */
  label: string;
  icon?: ReactNode;
  value: T;
  options: readonly MenuOption<T>[];
  onChange: (value: T) => void;
}

/**
 * A toolbar pill showing the chosen option that opens a radio menu, as the Library's menus do:
 * focus moves into the menu, arrows/Home/End move between options, Escape closes it and returns
 * focus, and Tab or a press outside closes it.
 */
export function MenuButton<T extends string>({
  label,
  icon,
  value,
  options,
  onChange,
}: MenuButtonProps<T>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const menu = wrapRef.current?.querySelector('[role="menu"]');
    (
      menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      menu?.querySelector<HTMLButtonElement>("button")
    )?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      const menu = wrapRef.current?.querySelector('[role="menu"]');
      if (!menu?.contains(document.activeElement)) return;
      if (event.key === "Tab") {
        setOpen(false);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button"));
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const chosen = options.find((option) => option.value === value);
  return (
    <div className="menu-button" ref={wrapRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${label}: ${chosen?.label ?? value}`}
        className={open ? "toolbar-pill toolbar-pill--active" : "toolbar-pill"}
        onClick={() => setOpen((current) => !current)}
        ref={buttonRef}
        type="button"
      >
        {icon ? <span className="toolbar-pill__icon">{icon}</span> : null}
        <span className="toolbar-pill__label">{chosen?.label ?? value}</span>
        <CaretDownIcon aria-hidden="true" className="toolbar-pill__caret" size={12} weight="bold" />
      </button>
      {open ? (
        <div className="floating-menu" role="menu" aria-label={label}>
          {options.map((option) => {
            const checked = option.value === value;
            return (
              <button
                aria-checked={checked}
                className={
                  checked
                    ? "floating-menu__option floating-menu__option--active"
                    : "floating-menu__option"
                }
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  buttonRef.current?.focus();
                }}
                role="menuitemradio"
                type="button"
              >
                <ChoiceCheck checked={checked} />
                <span className="floating-menu__text">
                  <strong>{option.label}</strong>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

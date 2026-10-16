import { useI18n } from "../../i18n/i18n";
import { ChoiceCheck } from "../ui/SelectionBox";
import { ClipboardTextIcon, CopyIcon, ScissorsIcon, SelectionAllIcon } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import {
  copyText,
  guardDocument,
  setControlValue,
  setSurfaceHost,
  type ListRequest,
  type MenuRequest,
} from "../../app/nativeSurfaces";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";

const GUTTER = 8;

/**
 * Komori's own versions of what WebView2 would otherwise draw itself: tooltips for titled
 * elements, the right-click menu of text fields and selected text, a select's options, and a
 * field's suggestions. Mounted once; it guards the app's document, and the Reader guards each
 * book section it shows.
 */
export function NativeSurfaces() {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [list, setList] = useState<ListRequest | null>(null);

  useEffect(() => {
    const release = setSurfaceHost({
      tooltip: setTip,
      menu: (request) => {
        setTip(null);
        setList(null);
        setMenu(request);
      },
      list: (request) => {
        setTip(null);
        setList((current) =>
          request?.kind === "select" &&
          current?.kind === "select" &&
          current.element === request.element
            ? null
            : request,
        );
      },
    });
    const unguard = guardDocument(document);
    return () => {
      unguard();
      release();
    };
  }, []);

  return (
    <>
      {tip ? <Tooltip rect={tip.rect} text={tip.text} /> : null}
      {menu ? <TextMenu onClose={() => setMenu(null)} request={menu} /> : null}
      {list?.kind === "select" ? (
        <SelectList element={list.element} onClose={() => setList(null)} rect={list.rect} />
      ) : null}
      {list?.kind === "suggestions" ? (
        <SuggestionList
          element={list.element}
          onClose={() => setList(null)}
          options={list.options}
          rect={list.rect}
        />
      ) : null}
    </>
  );
}

/** A modal dialog's popups belong inside it, or they would sit under it and be inert. */
const containerFor = (element: Element | null) =>
  (element?.closest("dialog[open]") as HTMLElement | null) ?? document.body;

/**
 * Places a fixed popup below (or, without room, above) a rectangle in the window, kept inside
 * the window; it corrects for a container that moves fixed elements.
 */
function usePlacement(
  ref: RefObject<HTMLElement | null>,
  rect: DOMRect,
  align: "center" | "start",
) {
  useLayoutEffect(() => {
    const popup = ref.current;
    if (!popup) return;
    popup.style.left = "0px";
    popup.style.top = "0px";
    const origin = popup.getBoundingClientRect();
    const width = origin.width;
    const height = origin.height;
    const below = rect.bottom + 6;
    const top =
      below + height + GUTTER <= window.innerHeight || rect.top - height - 6 < GUTTER
        ? Math.min(below, window.innerHeight - height - GUTTER)
        : rect.top - height - 6;
    const preferred = align === "center" ? rect.left + rect.width / 2 - width / 2 : rect.left;
    const left = Math.max(GUTTER, Math.min(preferred, window.innerWidth - width - GUTTER));
    popup.style.left = `${left - origin.left}px`;
    popup.style.top = `${Math.max(GUTTER, top) - origin.top}px`;
  }, [align, rect, ref]);
}

function Tooltip({ text, rect }: { text: string; rect: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null);
  usePlacement(ref, rect, "center");
  return createPortal(
    <div aria-hidden="true" className="app-tooltip" ref={ref}>
      {text}
    </div>,
    containerFor(document.activeElement),
  );
}

function TextMenu({ request, onClose }: { request: MenuRequest; onClose: () => void }) {
  const { field, selection } = request;
  const { t } = useI18n();
  const start = field ? safeSelection(field, "start") : null;
  const end = field ? safeSelection(field, "end") : null;
  const selected = start !== null && end !== null && end > start;
  const writable = field ? !field.readOnly && !field.disabled : false;
  const restore = () => {
    if (!field) return;
    field.focus();
    if (start !== null && end !== null) field.setSelectionRange(start, end);
  };

  const items: ContextMenuItem[] = field
    ? [
        {
          label: t("textMenu.cut"),
          icon: <ScissorsIcon aria-hidden="true" />,
          disabled: !selected || !writable,
          onSelect: () => {
            restore();
            field.ownerDocument.execCommand("cut");
          },
        },
        {
          label: t("textMenu.copy"),
          icon: <CopyIcon aria-hidden="true" />,
          disabled: !selected,
          onSelect: () => {
            restore();
            field.ownerDocument.execCommand("copy");
          },
        },
        {
          label: t("textMenu.paste"),
          icon: <ClipboardTextIcon aria-hidden="true" />,
          disabled: !writable,
          onSelect: () => {
            void invoke<string>("read_clipboard_text")
              .then((text) => {
                restore();
                if (text) field.ownerDocument.execCommand("insertText", false, text);
              })
              .catch(() => restore());
          },
        },
        {
          label: t("textMenu.selectAll"),
          icon: <SelectionAllIcon aria-hidden="true" />,
          disabled: field.value.length === 0,
          onSelect: () => {
            field.focus();
            field.select();
          },
        },
      ]
    : [
        {
          label: t("textMenu.copy"),
          icon: <CopyIcon aria-hidden="true" />,
          onSelect: () => copyText(selection),
        },
      ];

  return (
    <ContextMenu
      container={containerFor(field)}
      items={items}
      label={t("textMenu.label")}
      onClose={onClose}
      position={{ x: request.x, y: request.y }}
    />
  );
}

/** A select's options, in place of the browser's popup; choosing one changes the select. */
function SelectList({
  element,
  rect,
  onClose,
}: {
  element: HTMLSelectElement;
  rect: DOMRect;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  usePlacement(ref, rect, "start");
  const options = Array.from(element.options);
  const label = element.getAttribute("aria-label") ?? element.labels?.[0]?.textContent ?? "";

  const close = (refocus: boolean) => {
    onClose();
    if (refocus) element.focus();
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    close(true);
    if (element.value !== option.value) setControlValue(element, option.value);
  };

  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const current =
      list.querySelector<HTMLElement>('[aria-selected="true"]') ??
      list.querySelector<HTMLElement>('[role="option"]:not([aria-disabled="true"])');
    current?.focus();
    current?.scrollIntoView?.({ block: "nearest" });
  }, []);

  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target as Node;
      // The trigger's subsequent mousedown toggles the list. Closing here would reopen it.
      if (!ref.current?.contains(target) && !element.contains(target)) close(false);
    };
    const closeNow = () => close(false);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", closeNow);
    window.addEventListener("blur", closeNow);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", closeNow);
      window.removeEventListener("blur", closeNow);
    };
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])') ??
        [],
    );
    const current = items.indexOf(document.activeElement as HTMLElement);
    const focus = (index: number) => {
      const item = items[Math.max(0, Math.min(items.length - 1, index))];
      item?.focus();
      item?.scrollIntoView?.({ block: "nearest" });
    };
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focus(current + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focus(current - 1);
    } else if (event.key === "Home" || event.key === "PageUp") {
      event.preventDefault();
      focus(0);
    } else if (event.key === "End" || event.key === "PageDown") {
      event.preventDefault();
      focus(items.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(Number(items[current]?.dataset.index ?? -1));
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const letter = event.key.toLowerCase();
      const next = [...items.slice(current + 1), ...items.slice(0, current + 1)].find((item) =>
        item.textContent?.trim().toLowerCase().startsWith(letter),
      );
      if (next) focus(items.indexOf(next));
    }
  };

  return createPortal(
    <div
      aria-label={label}
      className="app-listbox"
      onKeyDown={onKeyDown}
      ref={ref}
      role="listbox"
      style={{ minWidth: rect.width }}
    >
      {options.map((option, index) => (
        <div
          aria-disabled={option.disabled || undefined}
          aria-selected={option.selected}
          className="app-listbox__option"
          data-index={index}
          key={`${index}:${option.value}`}
          onClick={() => choose(index)}
          role="option"
          tabIndex={-1}
        >
          <ChoiceCheck checked={option.selected} />
          {option.label}
        </div>
      ))}
    </div>,
    containerFor(element),
  );
}

/** A field's suggestions under it while it is typed in; focus stays in the field. */
function SuggestionList({
  element,
  options,
  rect,
  onClose,
}: {
  element: HTMLInputElement;
  options: string[];
  rect: DOMRect;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const [active, setActive] = useState(-1);
  usePlacement(ref, rect, "start");

  useEffect(() => setActive(-1), [options]);
  useEffect(() => {
    element.setAttribute("aria-expanded", "true");
    element.setAttribute("aria-controls", id);
    return () => {
      element.setAttribute("aria-expanded", "false");
      element.removeAttribute("aria-activedescendant");
    };
  }, [element, id]);
  useEffect(() => {
    if (active >= 0) element.setAttribute("aria-activedescendant", `${id}-${active}`);
    else element.removeAttribute("aria-activedescendant");
    ref.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, element, id]);

  useEffect(() => {
    const choose = (value: string) => {
      onClose();
      setControlValue(element, value);
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        // Past either end the field's own text is current again, as with the browser's list.
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((current) => {
          const next = current + step;
          return next < -1 ? options.length - 1 : next >= options.length ? -1 : next;
        });
      } else if (event.key === "Enter" && active >= 0 && options[active] !== undefined) {
        event.preventDefault();
        choose(options[active]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    element.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    return () => {
      element.removeEventListener("keydown", key);
      window.removeEventListener("resize", onClose);
    };
  }, [active, element, onClose, options]);

  return createPortal(
    <div
      className="app-listbox app-listbox--suggestions"
      id={id}
      ref={ref}
      role="listbox"
      style={{ width: rect.width }}
    >
      {options.map((option, index) => (
        <div
          aria-selected={index === active}
          className="app-listbox__option"
          data-index={index}
          id={`${id}-${index}`}
          key={option}
          // Keeps focus (and the list) in the field until the click chooses.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onClose();
            setControlValue(element, option);
          }}
          role="option"
        >
          {option}
        </div>
      ))}
    </div>,
    containerFor(element),
  );
}

function safeSelection(field: HTMLInputElement | HTMLTextAreaElement, edge: "start" | "end") {
  try {
    return edge === "start" ? field.selectionStart : field.selectionEnd;
  } catch {
    return null;
  }
}

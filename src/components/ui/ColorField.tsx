import { useI18n } from "../../i18n/i18n";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";

interface ColorFieldProps {
  label: string;
  /** A `#rrggbb` color. */
  value: string;
  /** Receives each valid `#rrggbb` color, in lowercase. */
  onChange: (value: string) => void;
}

const isHexColor = (value: string) => /^#[\da-f]{6}$/i.test(value);

/**
 * A color field: a swatch opening Komori's color picker beside a HEX field.
 * A typed color applies once it is a whole `#rrggbb` value; leaving the field with
 * anything else returns it to the current color.
 */
export function ColorField({ label, value, onChange }: ColorFieldProps) {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const swatchRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setDraft(value), [value]);

  const update = (next: string) => {
    setDraft(next);
    if (isHexColor(next)) onChange(next.toLowerCase());
  };

  return (
    <div className="color-field">
      <span className="color-field__label" id={id}>
        {label}
      </span>
      <div className="color-field__row">
        <button
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t("color.choose", { label: label.toLowerCase() })}
          className="color-field__swatch"
          onClick={() => setOpen(!open)}
          ref={swatchRef}
          type="button"
        >
          <span style={{ background: value }} aria-hidden="true" />
        </button>
        <input
          className={
            isHexColor(draft) ? "color-field__hex" : "color-field__hex color-field__hex--invalid"
          }
          value={draft}
          maxLength={7}
          spellCheck={false}
          aria-label={t("color.hex", { label })}
          aria-invalid={!isHexColor(draft)}
          onChange={(event) => update(event.target.value.trim())}
          onBlur={() => {
            if (!isHexColor(draft)) setDraft(value);
          }}
        />
      </div>
      {open && swatchRef.current ? (
        <ColorPicker
          anchor={swatchRef.current}
          label={label}
          onChange={(next) => update(next)}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) swatchRef.current?.focus();
          }}
          value={isHexColor(value) ? value : "#000000"}
        />
      ) : null}
    </div>
  );
}

interface Hsv {
  h: number;
  s: number;
  v: number;
}

export function hexToHsv(hex: string): Hsv {
  const [r, g, b] = [1, 3, 5].map(
    (start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255,
  );
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    const value = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Komori's color picker: saturation and brightness on a square, hue on a bar, both by pointer or
 * arrow keys. It opens under its swatch and closes with Escape or a press outside.
 */
function ColorPicker({
  anchor,
  label,
  value,
  onChange,
  onClose,
}: {
  anchor: HTMLElement;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onClose: (refocus: boolean) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  // The hue is kept while the color is grey or black, where the color alone loses it.
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  useEffect(() => {
    setHsv((current) => (hsvToHex(current) === value.toLowerCase() ? current : hexToHsv(value)));
  }, [value]);
  const apply = (next: Hsv) => {
    setHsv(next);
    onChange(hsvToHex(next));
  };

  useLayoutEffect(() => {
    const popup = ref.current;
    if (!popup) return;
    const rect = anchor.getBoundingClientRect();
    popup.style.left = "0px";
    popup.style.top = "0px";
    const origin = popup.getBoundingClientRect();
    const below = rect.bottom + 6;
    const top =
      below + origin.height + 8 <= window.innerHeight ? below : rect.top - origin.height - 6;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - origin.width - 8));
    popup.style.left = `${left - origin.left}px`;
    popup.style.top = `${Math.max(8, top) - origin.top}px`;
    popup.querySelector<HTMLElement>('[role="slider"]')?.focus();
  }, [anchor]);

  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchor.contains(target)) onClose(false);
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);

  const drag = (move: (x: number, y: number) => void) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const area = event.currentTarget;
    const at = (clientX: number, clientY: number) => {
      const rect = area.getBoundingClientRect();
      move(clamp((clientX - rect.left) / rect.width), clamp((clientY - rect.top) / rect.height));
    };
    area.setPointerCapture(event.pointerId);
    area.focus();
    at(event.clientX, event.clientY);
    const onMove = (next: globalThis.PointerEvent) => at(next.clientX, next.clientY);
    const onUp = () => {
      area.removeEventListener("pointermove", onMove);
      area.removeEventListener("pointerup", onUp);
      area.removeEventListener("pointercancel", onUp);
    };
    area.addEventListener("pointermove", onMove);
    area.addEventListener("pointerup", onUp);
    area.addEventListener("pointercancel", onUp);
  };

  const keys =
    (step: (dx: number, dy: number) => void) => (event: KeyboardEvent<HTMLDivElement>) => {
      const amount = event.shiftKey ? 0.1 : 0.01;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-amount, 0],
        ArrowRight: [amount, 0],
        ArrowUp: [0, -amount],
        ArrowDown: [0, amount],
      };
      const move = moves[event.key];
      if (!move) return;
      event.preventDefault();
      step(move[0], move[1]);
    };

  const hueColor = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  const container = (anchor.closest("dialog[open]") as HTMLElement | null) ?? document.body;
  return createPortal(
    <div aria-label={t("color.picker", { label })} className="color-picker" ref={ref} role="dialog">
      <div
        aria-label={t("color.area", { label })}
        aria-valuetext={t("color.areaValue", {
          saturation: Math.round(hsv.s * 100),
          brightness: Math.round(hsv.v * 100),
        })}
        className="color-picker__area"
        onKeyDown={keys((dx, dy) => apply({ ...hsv, s: clamp(hsv.s + dx), v: clamp(hsv.v - dy) }))}
        onPointerDown={drag((x, y) => apply({ ...hsv, s: x, v: 1 - y }))}
        role="slider"
        style={{ backgroundColor: hueColor }}
        tabIndex={0}
      >
        <span
          aria-hidden="true"
          className="color-picker__thumb"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: value }}
        />
      </div>
      <div
        aria-label={t("color.hue", { label })}
        aria-valuemax={360}
        aria-valuemin={0}
        aria-valuenow={Math.round(hsv.h)}
        className="color-picker__hue"
        onKeyDown={keys((dx, dy) =>
          apply({ ...hsv, h: Math.max(0, Math.min(359.9, hsv.h + (dx || -dy) * 360)) }),
        )}
        onPointerDown={drag((x) => apply({ ...hsv, h: Math.min(359.9, x * 360) }))}
        role="slider"
        tabIndex={0}
      >
        <span
          aria-hidden="true"
          className="color-picker__thumb"
          style={{ left: `${(hsv.h / 360) * 100}%`, top: "50%", background: hueColor }}
        />
      </div>
    </div>,
    container,
  );
}

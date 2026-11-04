import { onBackButtonPress } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

const sides = ["top", "right", "bottom", "left"] as const;
type Sides = Partial<Record<(typeof sides)[number], number>>;
type Insets = Sides & { stable?: Sides };

/**
 * Keeps `--safe-area-top`, `-right`, `-bottom` and `-left` at the phone's status bar, display
 * cutout and gesture bar as they are now, and `--stable-area-*` at them as they are with the
 * bars shown, in CSS pixels, as Android reports them: once now and on every change.
 */
export function watchSafeArea(): () => void {
  const style = document.createElement("style");
  style.dataset.komoriSafeArea = "";
  document.head.append(style);
  const apply = (insets: Insets | null | undefined) => {
    const properties = (prefix: string, values: Sides | undefined) =>
      sides.flatMap((side) => {
        const value = values?.[side];
        return typeof value === "number" && Number.isFinite(value) && value >= 0
          ? [`--${prefix}-${side}: ${Math.round(value * 10) / 10}px;`]
          : [];
      });
    const shown = [
      ...properties("safe-area", insets ?? undefined),
      ...properties("stable-area", insets?.stable),
    ];
    // Doubled, so it outweighs the WebView's own insets that mobile.css starts from.
    if (shown.length) style.textContent = `:root:root { ${shown.join(" ")} }`;
  };
  const changed = (event: Event) => apply((event as CustomEvent<Insets>).detail);
  window.addEventListener("komori-insets", changed);
  void invoke<Insets>("window_insets").then(apply, () => {});
  return () => {
    window.removeEventListener("komori-insets", changed);
    style.remove();
  };
}

/** Shows or hides the status and navigation bars; the Reader hides them while reading. */
export function showSystemBars(shown: boolean) {
  void invoke("show_system_bars", { shown }).catch(() => {});
}

/** Draws the bars' icons `dark`, over a light page, or light, whatever Android's dark mode. */
export function systemBarIcons(dark: boolean) {
  void invoke("system_bar_icons", { dark }).catch(() => {});
}

let bookOwnsSelection = false;

/**
 * Whether a selection made now is the book's: over the book, Komori's toolbar replaces
 * Android's. The Reader says so as each touch starts.
 */
export function ownBookSelection(own: boolean) {
  if (own === bookOwnsSelection) return;
  bookOwnsSelection = own;
  void invoke("book_selection", { own }).catch(() => {});
}

const closers: (() => void)[] = [];

/**
 * While `open`, Android's Back runs `close` before anything else, the latest opened first, as
 * it closes a sheet or menu before leaving the page.
 */
export function useBackCloser(open: boolean, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const closer = () => latest.current();
    closers.push(closer);
    return () => {
      const index = closers.lastIndexOf(closer);
      if (index >= 0) closers.splice(index, 1);
    };
  }, [open]);
}

/**
 * Android's Back: it closes the open sheet or dialog first, then returns to the page before,
 * and from the Library sends Komori to the background as Android's own apps do.
 */
export function useBackButton() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const path = useRef(pathname);
  path.current = pathname;
  useEffect(() => {
    let active = true;
    const listening = onBackButtonPress(() => {
      const closer = closers.at(-1);
      if (closer) return closer();
      const dialog = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(-1);
      if (dialog) {
        // A dialog that handles its own cancel closes itself; any other closes as Escape does.
        if (dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) dialog.close();
        return;
      }
      if (path.current === "/library" || path.current === "/") {
        void invoke("leave_app").catch(() => {});
        return;
      }
      const index = (window.history.state as { idx?: number } | null)?.idx ?? 0;
      if (index > 0) navigate(-1);
      else navigate("/library", { replace: true });
    });
    void listening.then(
      (listener) => {
        if (!active) void listener.unregister();
      },
      () => {},
    );
    return () => {
      active = false;
      void listening.then((listener) => listener.unregister()).catch(() => {});
    };
  }, [navigate]);
}

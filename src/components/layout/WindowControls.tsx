import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState, type MouseEvent } from "react";

import { useI18n } from "../../i18n/i18n";

/**
 * Minimize, maximize/restore, and close for Komori's own title bar, since its window has no
 * system frame. Drawn with the Windows glyph font so they read as the system's own. Nothing
 * renders outside the desktop application, as in tests.
 */
export function WindowControls({
  className,
  inDialog = false,
}: {
  className?: string;
  /** Inside a modal dialog: out of its Tab order and never taking focus from it on click. */
  inDialog?: boolean;
}) {
  const desktop = isTauri();
  const [maximized, setMaximized] = useState(false);
  const { t } = useI18n();

  useEffect(() => {
    if (!desktop) return;
    const appWindow = getCurrentWindow();
    let active = true;
    const update = () =>
      void appWindow
        .isMaximized()
        .then((value) => active && setMaximized(value))
        .catch(() => undefined);
    update();
    const unlisten = appWindow.onResized(update);
    return () => {
      active = false;
      void unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, [desktop]);

  if (!desktop) return null;
  const appWindow = getCurrentWindow();
  const dialogProps = inDialog
    ? { onMouseDown: (event: MouseEvent) => event.preventDefault(), tabIndex: -1 }
    : {};
  return (
    <div className={["window-controls", className].filter(Boolean).join(" ")}>
      <button
        aria-label={t("window.minimize")}
        className="window-controls__button"
        onClick={() => void appWindow.minimize()}
        {...dialogProps}
        title={t("window.minimize")}
        type="button"
      >
        <span aria-hidden="true">{"\uE921"}</span>
      </button>
      <button
        aria-label={t(maximized ? "window.restore" : "window.maximize")}
        className="window-controls__button"
        onClick={() => void appWindow.toggleMaximize()}
        {...dialogProps}
        title={t(maximized ? "window.restore" : "window.maximize")}
        type="button"
      >
        <span aria-hidden="true">{maximized ? "\uE923" : "\uE922"}</span>
      </button>
      <button
        aria-label={t("window.close")}
        className="window-controls__button window-controls__button--close"
        onClick={() => void appWindow.close()}
        {...dialogProps}
        title={t("window.close")}
        type="button"
      >
        <span aria-hidden="true">{"\uE8BB"}</span>
      </button>
    </div>
  );
}

/**
 * The window's title bar inside a modal dialog's top layer, where the page's own title bar is
 * inert: a strip along the top that drags the window, with the window controls on its right.
 */
export function DialogCaption() {
  if (!isTauri()) return null;
  return (
    <div className="dialog-caption" data-tauri-drag-region>
      <WindowControls inDialog />
    </div>
  );
}

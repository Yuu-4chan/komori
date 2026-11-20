import { useEffect } from "react";

/**
 * Calls `refresh` now and each second while `active` and the document is visible; hiding
 * the app suspends the timer and showing it again refreshes immediately.
 */
export function useEverySecond(active: boolean, refresh: () => void) {
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const visibilityChanged = () => {
      clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== "hidden") {
        refresh();
        timer = setInterval(refresh, 1000);
      }
    };
    visibilityChanged();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [active, refresh]);
}

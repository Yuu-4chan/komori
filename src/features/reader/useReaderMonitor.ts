import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Logical pixels on the monitor containing Komori; never inferred from browser screen data. */
export function useReaderMonitor() {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      try {
        const result = await invoke<{ width: number; height: number } | null>(
          "get_reader_monitor_size",
        );
        if (active && current === revision) setSize(result);
      } catch {
        if (active && current === revision) setSize(null);
      }
    };
    void refresh();
    const window = getCurrentWindow();
    const listeners = [
      window.onMoved(refresh),
      window.onResized(refresh),
      window.onScaleChanged(refresh),
    ];
    return () => {
      active = false;
      for (const listener of listeners)
        void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  return size;
}

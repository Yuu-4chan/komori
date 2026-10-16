import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const flushers = new Set<() => Promise<unknown>>();
const visibilityListeners = new Set<(visible: boolean) => void>();
let visible = true;

/**
 * Pending native writes join the window close, without coupling Reader code to tray controls. A
 * flush resolving `false` (or rejecting) reports work it could not save.
 */
export function registerWindowFlush(flush: () => Promise<unknown>): () => void {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}
export function watchWindowVisibility(changed: (visible: boolean) => void): () => void {
  visibilityListeners.add(changed);
  changed(visible);
  return () => {
    visibilityListeners.delete(changed);
  };
}
function visibility(value: boolean) {
  visible = value;
  for (const changed of visibilityListeners) changed(value);
}
/** Runs every pending native write; false when one could not be saved. */
export async function flushPendingWrites(): Promise<boolean> {
  const results = await Promise.allSettled(
    [...flushers].map((flush) => Promise.resolve().then(flush)),
  );
  return !results.some((result) => result.status === "rejected" || result.value === false);
}
async function flushWindowState() {
  visibility(false);
  // The window closes anyway; native keeps its own deadline.
  if (!(await flushPendingWrites()))
    console.warn("Komori could not save every change before the window closed.");
}

/** Installed before React mounts, including before appearance preferences have loaded. */
export function installWindowLifecycle(): () => void {
  if (!isTauri()) return () => {};
  let active = true;
  const stops = [
    listen<string>("komori-window-closing", async ({ payload: token }) => {
      if (!active) return;
      await flushWindowState();
      await invoke("finish_window_close", { token });
    }),
    listen<boolean>("komori-window-visible", ({ payload }) => {
      if (active) visibility(payload);
    }),
  ];
  // A failed registration must not create an unhandled rejection; native still has its deadline.
  for (const stop of stops) void stop.catch(() => {});
  return () => {
    active = false;
    for (const stop of stops) void stop.then((unlisten) => unlisten()).catch(() => {});
  };
}

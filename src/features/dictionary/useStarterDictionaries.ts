import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { dictionariesChanged } from "./sourcePolicy";

type StarterPhase =
  | "ready"
  | "downloading"
  | "verifying"
  | "importing"
  | "imported"
  | "alreadyImported"
  | "failed"
  | "interrupted";
export interface StarterEntry {
  id: string;
  name: string;
  description: string;
  attribution: string;
  license: string;
  phase: StarterPhase;
  received: number;
  total: number | null;
  /** The imported dictionary's title, once a download has added it. */
  title?: string;
}
export interface StarterSnapshot {
  revision: number;
  started: boolean;
  dismissed: boolean;
  entries: StarterEntry[];
}
export const starterActive = (snapshot: StarterSnapshot | null) =>
  snapshot?.entries.some(({ phase }) =>
    ["downloading", "verifying", "importing"].includes(phase),
  ) ?? false;

/** The application owns completion notifications even when Settings is closed. */
export function useStarterDictionaryNotifications() {
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    let latest = -1;
    if (!isTauri()) return;
    void listen<StarterSnapshot>("starter-dictionaries-changed", ({ payload }) => {
      if (disposed || payload.revision <= latest) return;
      latest = payload.revision;
      if (!starterActive(payload)) window.dispatchEvent(new Event(dictionariesChanged));
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
}

/** Native snapshots recover missed events after navigation or a webview reload. */
export function useStarterDictionaries() {
  const [snapshot, setSnapshot] = useState<StarterSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const latest = useRef(-1);
  const mounted = useRef(false);
  const accept = useCallback((value: StarterSnapshot) => {
    if (!mounted.current || value.revision < latest.current) return false;
    latest.current = value.revision;
    setSnapshot(value);
    setError(false);
    return true;
  }, []);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    let stop: (() => void) | undefined;
    async function load() {
      try {
        if (!isTauri()) throw new Error("Desktop required");
        stop = await listen<StarterSnapshot>("starter-dictionaries-changed", ({ payload }) => {
          if (active && accept(payload) && !starterActive(payload))
            window.dispatchEvent(new Event(dictionariesChanged));
        });
        if (!active) {
          stop();
          return;
        }
        const value = await invoke<StarterSnapshot>("get_starter_dictionaries");
        if (active) accept(value);
      } catch {
        if (active) setError(true);
      }
    }
    void load();
    return () => {
      active = false;
      mounted.current = false;
      stop?.();
    };
  }, [reload, accept]);
  const action = async (command: string, args?: Record<string, unknown>) => {
    const value = await invoke<StarterSnapshot>(command, args);
    accept(value);
  };
  return {
    snapshot,
    error,
    retry: () => setReload((value) => value + 1),
    download: (id: string) => action("download_starter_dictionary", { id }),
    dismiss: () => action("dismiss_starter_dictionaries"),
  };
}

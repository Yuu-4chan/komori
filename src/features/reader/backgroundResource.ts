import type { MessageKey } from "../../i18n/i18n";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";

export interface ReaderBackground {
  revision: string;
  url: string;
}
interface Snapshot {
  image: ReaderBackground | null;
  loaded: boolean;
  pending: "load" | "choose" | "remove" | null;
  /** What went wrong, as a message of the interface language. */
  error: MessageKey | null;
  imageFailed: boolean;
  attempt: number;
}
export interface BackgroundApi {
  get: () => Promise<unknown>;
  choose: () => Promise<unknown>;
  remove: () => Promise<void>;
}
export function normalizeBackground(value: unknown): ReaderBackground | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw Error("Invalid background");
  const { revision, url } = value as ReaderBackground;
  if (
    typeof revision !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(revision) ||
    ![
      `http://komori-background.localhost/${revision}`,
      `komori-background://localhost/${revision}`,
    ].includes(url)
  )
    throw Error("Invalid background");
  return { revision, url };
}

/** One native operation across Reader/panel lifetimes; no source path or object URL is retained. */
export class ReaderBackgroundStore {
  private state: Snapshot = {
    image: null,
    loaded: false,
    pending: null,
    error: null,
    imageFailed: false,
    attempt: 0,
  };
  private observers = new Set<() => void>();
  constructor(private api: BackgroundApi) {}
  snapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.observers.add(fn);
    return () => {
      this.observers.delete(fn);
    };
  };
  private publish(patch: Partial<Snapshot>) {
    this.state = { ...this.state, ...patch };
    this.observers.forEach((fn) => fn());
  }
  async load() {
    if (this.state.pending) return;
    this.publish({ pending: "load", error: null });
    try {
      const image = normalizeBackground(await this.api.get());
      this.publish({ image, imageFailed: false, attempt: this.state.attempt + 1 });
    } catch {
      this.publish({ error: "background.loadFailed" });
    } finally {
      this.publish({ loaded: true, pending: null });
    }
  }
  async change(action: "choose" | "remove") {
    if (this.state.pending) return;
    const previousError = this.state.error;
    this.publish({ pending: action, error: null });
    try {
      if (action === "remove") {
        await this.api.remove();
        this.publish({ image: null, imageFailed: false });
      } else {
        const image = normalizeBackground(await this.api.choose());
        // Null means native picker cancellation, never removal.
        if (image) this.publish({ image, imageFailed: false, attempt: this.state.attempt + 1 });
        else this.publish({ error: previousError });
      }
    } catch {
      this.publish({
        error: action === "choose" ? "background.chooseFailed" : "background.removeFailed",
      });
    } finally {
      this.publish({ loaded: true, pending: null });
    }
  }
  failed(revision: string, attempt: number) {
    if (this.state.image?.revision !== revision || this.state.attempt !== attempt) return;
    this.publish({
      imageFailed: true,
      error: "background.displayFailed",
    });
  }
}
const desktop = () => {
  if (!isTauri()) throw Error("Desktop required");
};
export const readerBackgroundStore = new ReaderBackgroundStore({
  get: async () => {
    desktop();
    return invoke("get_reader_background");
  },
  choose: async () => {
    desktop();
    return invoke("choose_reader_background");
  },
  remove: async () => {
    desktop();
    return invoke("remove_reader_background");
  },
});
export function useReaderBackground() {
  const state = useSyncExternalStore(
    readerBackgroundStore.subscribe,
    readerBackgroundStore.snapshot,
  );
  useEffect(() => {
    if (isTauri() && !readerBackgroundStore.snapshot().loaded) void readerBackgroundStore.load();
  }, []);
  return state;
}

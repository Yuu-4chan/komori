import { invoke, isTauri } from "@tauri-apps/api/core";

import type { ReaderLocator, ReaderPositionStore } from "./renderer";

const maxSpineIndex = 100_000;

/** Accept only a well-formed Komori locator; anything else means "no saved position". */
export function normalizeReaderLocator(value: unknown): ReaderLocator | null {
  if (!value || typeof value !== "object") return null;
  const { spineIndex, sectionKey, progress } = value as Record<string, unknown>;
  if (
    typeof spineIndex !== "number" ||
    !Number.isInteger(spineIndex) ||
    spineIndex < 0 ||
    spineIndex > maxSpineIndex ||
    typeof progress !== "number" ||
    !Number.isFinite(progress) ||
    progress < 0 ||
    progress > 1
  )
    return null;
  if (sectionKey === undefined || sectionKey === null) return { spineIndex, progress };
  if (typeof sectionKey !== "string" || !/^[\da-f]{8}$/.test(sectionKey)) return null;
  return { spineIndex, sectionKey, progress };
}

export function readerPositionStore(catalogId: string): ReaderPositionStore {
  return {
    async load() {
      if (!isTauri()) return null;
      try {
        return normalizeReaderLocator(
          await invoke<unknown>("get_reading_position", { id: catalogId }),
        );
      } catch {
        // A position is a convenience; the Reader opens at the authored start instead.
        return null;
      }
    },
    async saveProgress({ unit, current, total }) {
      if (!isTauri() || !(total > 0)) return;
      await invoke("save_book_progress", {
        id: catalogId,
        progress: { unit, current: Math.min(Math.max(0, current), total), total },
      });
    },
    async saveSession(session) {
      if (!isTauri()) return;
      await invoke("save_reading_session", { id: catalogId, session });
    },
    async save(locator) {
      const position = normalizeReaderLocator(locator);
      if (!isTauri() || !position) return;
      await invoke("save_reading_position", { id: catalogId, position });
    },
  };
}

/**
 * Throttles one book's position (or progress) writes. The latest position wins, writes run one at
 * a time in order, and dispose() flushes a pending position before ignoring updates. A position
 * stays pending until its write succeeds; a failed one is retried by the next update or flush.
 */
export class ReaderPositionSaver<Value = ReaderLocator> {
  private pending: Value | null = null;
  private last: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastWrite = Number.NEGATIVE_INFINITY;
  private chain: Promise<boolean> = Promise.resolve(true);
  private disposed = false;

  constructor(
    private readonly store: { save(value: Value): Promise<void> },
    private readonly interval = 1000,
  ) {}

  update(locator: Value): void {
    if (this.disposed) return;
    this.pending = locator;
    if (this.timer !== undefined) return;
    const wait = Math.max(0, this.lastWrite + this.interval - Date.now());
    this.timer = setTimeout(() => void this.flush(), wait);
  }

  /** Writes the pending position; resolves with whether nothing is left unsaved. */
  flush(): Promise<boolean> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending !== null && JSON.stringify(this.pending) !== this.last)
      this.lastWrite = Date.now();
    this.chain = this.chain.then(() => this.write());
    return this.chain;
  }

  dispose(): Promise<boolean> {
    if (this.disposed) return this.flush();
    const flushed = this.flush();
    this.disposed = true;
    return flushed;
  }

  private async write(): Promise<boolean> {
    const locator = this.pending;
    if (locator === null) return true;
    const key = JSON.stringify(locator);
    if (key !== this.last) {
      try {
        await this.store.save(locator);
      } catch {
        return false;
      }
      this.last = key;
    }
    if (this.pending === locator) this.pending = null;
    return true;
  }
}

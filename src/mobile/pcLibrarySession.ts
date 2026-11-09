import type { MessageKey } from "../i18n/i18n";
import type { PcBook } from "./pcLinkApi";

/** Whether the PC answered the last listing this session, or why not; unknown before one. */
export type PcConnection = "unknown" | "connected" | MessageKey;

export interface PcSession {
  /** The PC's books as last listed or saved on the phone (none when none is saved); null
   * before either is read. */
  books: PcBook[] | null;
  connection: PcConnection;
  /** When the PC was last listed (ms), 0 before the first time or after a sync that changed
   * what it lists. */
  listedAt: number;
}

const initial: PcSession = { books: null, connection: "unknown", listedAt: 0 };
let state = initial;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/**
 * The PC's Library as the phone knows it, kept for the session so returning to the Library
 * shows it at once while it is listed again in the background.
 */
export const pcSession = {
  get: () => state,
  set(patch: Partial<PcSession>) {
    state = { ...state, ...patch };
    notify();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  /** The listing is out of date (a sync changed it, or a pull asks again), so the next showing
   * lists the PC again. */
  markStale() {
    state = { ...state, listedAt: 0 };
  },
  /** Forgets the PC's books, as unpairing does; also for tests. */
  reset() {
    state = initial;
    notify();
  },
};

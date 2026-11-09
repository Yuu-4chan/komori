import { listen } from "@tauri-apps/api/event";

// On the phone a PC book's cover the phone does not have yet is a miss at first: Komori fetches
// it from the PC in the background and announces it with `pc-cover`, and the cards showing it
// load it again.

interface CoverArrived {
  id: string;
  revision: number;
}

const waiting = new Map<string, Set<() => void>>();
const arrived = new Set<string>();
let listening: Promise<unknown> | null = null;

/** A PC cover's place in its URL, `/pc/<id>/<revision>`, or null for the phone's own covers. */
export function pcCoverKey(url: string): string | null {
  const at = url.indexOf("/pc/");
  return at === -1 ? null : url.slice(at);
}

/** Whether the phone received the PC cover at `key` since Komori started. */
export function pcCoverArrived(key: string): boolean {
  return arrived.has(key);
}

/** Calls `onArrival` each time the phone receives the PC cover at `key`, until unsubscribed. */
export function onPcCoverArrival(key: string, onArrival: () => void): () => void {
  listening ??= listen<CoverArrived>("pc-cover", ({ payload }) => {
    const key = `/pc/${payload.id}/${payload.revision}`;
    arrived.add(key);
    for (const notify of waiting.get(key) ?? []) notify();
  }).catch(() => {
    listening = null;
  });
  let callbacks = waiting.get(key);
  if (!callbacks) {
    callbacks = new Set();
    waiting.set(key, callbacks);
  }
  callbacks.add(onArrival);
  return () => {
    callbacks.delete(onArrival);
    if (callbacks.size === 0) waiting.delete(key);
  };
}

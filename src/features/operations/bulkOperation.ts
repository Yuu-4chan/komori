import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

import { i18n } from "../../i18n/i18n";

export type Store = "library" | "dictionaries";
type Compaction =
  | { status: "compacted"; sizeBefore: number; sizeAfter: number }
  | { status: "notNeeded" }
  | { status: "failed" };
export interface RemovalBatch<T> {
  results: T;
  maintenance: Compaction | null;
}
export interface BulkProgress {
  operationId: string;
  completed: number;
  total: number | null;
  phase: "waiting" | "picking" | "discovering" | "processing" | "reclaiming";
}
export interface BulkOperation extends BulkProgress {
  command: string;
  active: boolean;
  result?: unknown;
  error?: string;
}

// The invocation owns its listener and result, independently of any page's lifetime.
// A store has one active action; revisiting a route observes that action and its last outcome.
const states: Record<Store, BulkOperation | null> = { library: null, dictionaries: null };
const subscribers = new Set<() => void>();
const subscribe = (callback: () => void) => {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
};
function publish(store: Store, value: BulkOperation | null) {
  states[store] = value;
  subscribers.forEach((callback) => callback());
}
export function useBulkOperation(store: Store): BulkOperation | null {
  return useSyncExternalStore(subscribe, () => states[store]);
}
// Pages showing a finished operation's outcome. Once the last of them closes, the outcome has been
// seen and is cleared, so it does not return on later visits. A notice that is only remounted
// (React's development double mount) keeps it, since the check waits for the next task.
const viewers = new Map<string, number>();
/** Marks a finished operation as shown; the returned function ends that showing. */
export function viewBulkOperation(operation: BulkOperation): () => void {
  const { operationId } = operation;
  viewers.set(operationId, (viewers.get(operationId) ?? 0) + 1);
  return () => {
    viewers.set(operationId, (viewers.get(operationId) ?? 1) - 1);
    setTimeout(() => {
      if ((viewers.get(operationId) ?? 0) > 0) return;
      viewers.delete(operationId);
      (Object.keys(states) as Store[]).forEach((store) => {
        const current = states[store];
        if (current && !current.active && current.operationId === operationId) publish(store, null);
      });
    }, 0);
  };
}
export function bulkOperationActive(store: Store): boolean {
  return states[store]?.active ?? false;
}

/** Subscribe before invoking, so even a fast first item cannot escape observation. */
export async function runBulkOperation<T>(
  store: Store,
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (bulkOperationActive(store)) throw new Error(i18n().t("operation.busy"));
  const previous = states[store];
  const operationId = crypto.randomUUID();
  publish(store, {
    operationId,
    command,
    active: true,
    phase: "waiting",
    completed: 0,
    total: null,
  });
  let stop: (() => void) | undefined;
  try {
    stop = await listen<BulkProgress>("bulk-progress", ({ payload }) => {
      const current = states[store];
      if (!current?.active || payload.operationId !== current.operationId) return;
      // Events may be delayed or repeated; a count or phase never goes backward.
      const phases = ["waiting", "picking", "discovering", "processing", "reclaiming"];
      if (
        !phases.includes(payload.phase) ||
        phases.indexOf(payload.phase) < phases.indexOf(current.phase)
      )
        return;
      if (!Number.isSafeInteger(payload.completed) || payload.completed < current.completed) return;
      if (
        payload.total !== null &&
        (!Number.isSafeInteger(payload.total) || payload.total < payload.completed)
      )
        return;
      if (current.total !== null && payload.total !== current.total) return;
      publish(store, { ...current, ...payload });
    });
    const result = await invoke<T>(command, { ...args, operationId });
    const emptyScan =
      command === "scan_library_folders" && Array.isArray(result) && result.length === 0;
    const canceled =
      typeof result === "object" &&
      result !== null &&
      (("canceled" in result && result.canceled === true) ||
        ("status" in result && result.status === "canceled"));
    const outcomes = Array.isArray(result)
      ? result
      : typeof result === "object" && result !== null && "results" in result
        ? result.results
        : undefined;
    const count = Array.isArray(outcomes)
      ? outcomes.length
      : typeof outcomes === "boolean" || typeof outcomes === "string"
        ? 1
        : null;
    publish(
      store,
      emptyScan || canceled
        ? previous
        : {
            ...states[store]!,
            active: false,
            result,
            ...(count === null ? {} : { completed: count, total: count }),
          },
    );
    return result;
  } catch {
    // Never surface native diagnostics, source paths, or listener errors in a notice.
    const error = i18n().t("operation.failed");
    publish(store, { ...states[store]!, active: false, error });
    throw new Error(error);
  } finally {
    stop?.();
  }
}

export function operationLabel(operation: BulkOperation | null): string {
  const { t } = i18n();
  if (!operation) return t("operation.working");
  if (operation.command.startsWith("compact_")) return t("operation.reclaiming");
  const progress = { completed: operation.completed, total: operation.total ?? 0 };
  if (operation.phase === "reclaiming") return t("operation.reclaimingProgress", progress);
  if (operation.phase === "picking") return t("operation.picking");
  if (operation.phase === "discovering") return t("operation.discovering");
  if (operation.total === null) return t("operation.waiting");
  return t(
    operation.command.startsWith("remove_") ? "operation.removing" : "operation.adding",
    progress,
  );
}

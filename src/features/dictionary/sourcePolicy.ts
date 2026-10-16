export type SourceSelection =
  { mode: "all" } | { mode: "none" } | { mode: "selected"; ids: number[] };

export interface SourcePolicy {
  definitions: SourceSelection;
  frequency: SourceSelection;
  pitch: SourceSelection;
}

export const allSources: SourceSelection = { mode: "all" };
export const dictionariesChanged = "komori:dictionaries-changed";
export const sourceRoles = ["definitions", "frequency", "pitch"] as const;
export type SourceRole = (typeof sourceRoles)[number];

/** Validate a whole role independently. Never salvage invalid IDs into a broader choice. */
export function normalizeSourceSelection(value: unknown): SourceSelection | undefined {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.mode === "all" || record.mode === "none") {
    if (Object.keys(record).length === 1) return { mode: record.mode };
  }
  if (
    record.mode === "selected" &&
    Object.keys(record).length === 2 &&
    Array.isArray(record.ids) &&
    record.ids.length <= 128 &&
    record.ids.every((id) => Number.isSafeInteger(id) && id > 0) &&
    new Set(record.ids).size === record.ids.length
  )
    return { mode: "selected", ids: [...record.ids] };
}

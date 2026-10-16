import { invoke, isTauri } from "@tauri-apps/api/core";

import { i18n } from "../../i18n/i18n";

export const backupFrequencies = [
  { value: "daily", label: "backup.daily" },
  { value: "weekly", label: "backup.weekly" },
  { value: "monthly", label: "backup.monthly" },
] as const;
type BackupFrequency = (typeof backupFrequencies)[number]["value"];
export const backupKeepChoices = [3, 7, 14, 30] as const;
type BackupKeep = (typeof backupKeepChoices)[number];

/** Automatic snapshots: on by default, daily, the newest seven kept. */
export interface BackupSettings {
  automatic: boolean;
  frequency: BackupFrequency;
  keep: BackupKeep;
}

export const defaultBackupSettings: BackupSettings = {
  automatic: true,
  frequency: "daily",
  keep: 7,
};

export interface Snapshot {
  id: string;
  kind: "automatic" | "manual" | "restore";
  /** Unix milliseconds. */
  createdAt: number;
  size: number;
}

export type PreviewStatus =
  "ready" | "canceled" | "foreign" | "newer" | "damaged" | "tooLarge" | "unreadable" | "missing";

/** What a backup holds and how it would apply to this Library. */
export interface BackupPreview {
  status: PreviewStatus;
  token: string | null;
  createdAt: number | null;
  komoriVersion: string | null;
  books: number;
  matched: number;
  unmatched: string[];
  unmatchedCount: number;
  positions: number;
  bookmarks: number;
  notes?: number;
  sessions: number;
  appearance: boolean;
  anki: boolean;
  startup?: boolean;
}

export interface RestoreResult {
  status: "restored" | "expired" | "snapshotFailed";
  books: number;
  unmatched: string[];
  unmatchedCount: number;
  sessions: number;
  snapshot: string | null;
}

export interface ExportResult {
  status: "saved" | "canceled" | "failed";
  fileName: string | null;
  books: number;
  sessions: number;
}

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const snapshotId = /^(automatic|manual|restore)-\d{1,15}$/;
const previewStatuses: readonly string[] = [
  "ready",
  "canceled",
  "foreign",
  "newer",
  "damaged",
  "tooLarge",
  "unreadable",
  "missing",
];
const titles = (value: unknown) =>
  Array.isArray(value) ? value.filter((title): title is string => typeof title === "string") : [];

function desktop() {
  if (!isTauri()) throw new Error(i18n().t("backup.desktopOnly"));
}

function normalizeBackupSettings(value: unknown): BackupSettings {
  const settings = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    automatic:
      typeof settings.automatic === "boolean"
        ? settings.automatic
        : defaultBackupSettings.automatic,
    frequency:
      backupFrequencies.find(({ value }) => value === settings.frequency)?.value ??
      defaultBackupSettings.frequency,
    keep: backupKeepChoices.find((keep) => keep === settings.keep) ?? defaultBackupSettings.keep,
  };
}

function normalizeSnapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object") return null;
  const { id, kind, createdAt, size } = value as Record<string, unknown>;
  if (typeof id !== "string" || !snapshotId.test(id)) return null;
  if (kind !== "automatic" && kind !== "manual" && kind !== "restore") return null;
  if (!count(createdAt) || !count(size)) return null;
  return { id, kind, createdAt, size };
}

export function normalizePreview(value: unknown): BackupPreview {
  const preview = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const status = previewStatuses.includes(preview.status as string)
    ? (preview.status as PreviewStatus)
    : "unreadable";
  const number = (key: string) => (count(preview[key]) ? (preview[key] as number) : 0);
  const ready = status === "ready" && typeof preview.token === "string";
  return {
    status: ready || status !== "ready" ? status : "unreadable",
    token: ready ? (preview.token as string) : null,
    createdAt: count(preview.createdAt) ? preview.createdAt : null,
    komoriVersion: typeof preview.komoriVersion === "string" ? preview.komoriVersion : null,
    books: number("books"),
    matched: number("matched"),
    unmatched: titles(preview.unmatched),
    unmatchedCount: number("unmatchedCount"),
    positions: number("positions"),
    bookmarks: number("bookmarks"),
    notes: number("notes"),
    sessions: number("sessions"),
    appearance: preview.appearance === true,
    anki: preview.anki === true,
    startup: preview.startup === true,
  };
}

export async function getBackupSettings(): Promise<BackupSettings> {
  desktop();
  return normalizeBackupSettings(await invoke("get_backup_settings"));
}

export async function saveBackupSettings(settings: BackupSettings): Promise<boolean> {
  desktop();
  return (await invoke("save_backup_settings", { settings })) === true;
}

export async function listSnapshots(): Promise<Snapshot[]> {
  desktop();
  const listed = await invoke("list_snapshots");
  return Array.isArray(listed)
    ? listed.map(normalizeSnapshot).filter((snapshot): snapshot is Snapshot => !!snapshot)
    : [];
}

export async function createSnapshot(): Promise<Snapshot | null> {
  desktop();
  const result = (await invoke("create_snapshot")) as { status?: unknown; snapshot?: unknown };
  return result?.status === "created" ? normalizeSnapshot(result.snapshot) : null;
}

export async function deleteSnapshot(id: string): Promise<boolean> {
  desktop();
  return (await invoke("delete_snapshot", { id })) === true;
}

export async function exportBackup(): Promise<ExportResult> {
  desktop();
  const result = ((await invoke("export_backup")) ?? {}) as Record<string, unknown>;
  const status =
    result.status === "saved" || result.status === "canceled" ? result.status : "failed";
  return {
    status,
    fileName: typeof result.fileName === "string" ? result.fileName : null,
    books: count(result.books) ? result.books : 0,
    sessions: count(result.sessions) ? result.sessions : 0,
  };
}

export async function openBackupFile(): Promise<BackupPreview> {
  desktop();
  return normalizePreview(await invoke("open_backup_file"));
}

export async function openSnapshot(id: string): Promise<BackupPreview> {
  desktop();
  return normalizePreview(await invoke("open_snapshot", { id }));
}

export async function restoreBackup(token: string): Promise<RestoreResult> {
  desktop();
  const result = ((await invoke("restore_backup", { token })) ?? {}) as Record<string, unknown>;
  const status =
    result.status === "restored" || result.status === "snapshotFailed" ? result.status : "expired";
  return {
    status,
    books: count(result.books) ? result.books : 0,
    unmatched: titles(result.unmatched),
    unmatchedCount: count(result.unmatchedCount) ? result.unmatchedCount : 0,
    sessions: count(result.sessions) ? result.sessions : 0,
    snapshot: typeof result.snapshot === "string" ? result.snapshot : null,
  };
}

import { invoke, isTauri } from "@tauri-apps/api/core";
import { flushPendingWrites } from "../../app/windowLifecycle";

/** A newer Komori release, with its changelog section as plain text. */
export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  notes: string;
}

/** Asks the project's releases for a newer version; null when Komori is up to date. */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isTauri()) throw Error("Updates need the Komori app.");
  return (await invoke<AvailableUpdate | null>("check_for_update")) ?? null;
}

/**
 * Saves pending changes, then downloads, verifies and starts the update the last check found.
 * On the PC Komori exits when the installer starts, so this settles only on failure; on the
 * phone it settles once Android's installer has the APK.
 */
export async function installUpdate(): Promise<void> {
  if (!isTauri()) throw Error("Updates need the Komori app.");
  await flushPendingWrites();
  await invoke("install_update");
}

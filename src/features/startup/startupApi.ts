import { invoke, isTauri } from "@tauri-apps/api/core";
import { registerWindowFlush } from "../../app/windowLifecycle";

export interface StartupPreferences {
  launchAtStartup: boolean;
  restoreLastBook: boolean;
  rememberWindowSize: boolean;
  minimizeToTray: boolean;
  checkForUpdates: boolean;
}
export const defaultStartupPreferences: StartupPreferences = {
  launchAtStartup: false,
  restoreLastBook: true,
  rememberWindowSize: true,
  minimizeToTray: false,
  checkForUpdates: true,
};
export async function getStartupPreferences(): Promise<StartupPreferences> {
  if (!isTauri()) throw Error("Startup choices need the Komori desktop app.");
  return invoke("get_startup_preferences");
}
export async function saveStartupPreferences(
  changes: Partial<StartupPreferences>,
): Promise<StartupPreferences> {
  if (!isTauri()) throw Error("Startup choices need the Komori desktop app.");
  const writing = invoke<StartupPreferences>("save_startup_preferences", { changes });
  const stop = registerWindowFlush(() => writing);
  try {
    return await writing;
  } finally {
    stop();
  }
}
export async function rememberLastBook(id: string): Promise<void> {
  if (!isTauri()) return;
  const writing = invoke("remember_last_book", { id }).catch(() => {});
  const stop = registerWindowFlush(() => writing);
  try {
    await writing;
  } finally {
    stop();
  }
}
export async function getStartupBook(): Promise<string | null> {
  if (!isTauri()) return null;
  const id = await invoke<unknown>("get_startup_book");
  return typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null;
}
